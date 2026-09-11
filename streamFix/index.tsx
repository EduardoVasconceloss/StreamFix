/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Constants, MaskedLink, RestAPI, SearchableSelect, showToast, Toasts, UserStore } from "@webpack/common";

import { aAmostra } from "./tunnel/coletor";
import { EstadoTunel } from "./tunnel/controle";
import { Estado, Veredito } from "./tunnel/monitor";
import { observar } from "./tunnel/observador";
import { aviso, decidir, hostDoEndpoint } from "./tunnel/porteiro";

interface RegionStore {
    getPreferredRegion(): string | null;
    getPreferredRegions(): string[] | null;
    shouldIncludePreferredRegion(): boolean;
}

interface VoiceRegion {
    id: string;
    name: string;
    optimal: boolean;
    deprecated: boolean;
    custom: boolean;
}

interface MediaEngineStore {
    supportsInApp(kind: string): boolean;
    supports(kind: string): boolean;
    isSupported(): boolean;
}

interface DiagnosticStore {
    [method: string]: unknown;
}

const RTCRegionStore: RegionStore = findStoreLazy("RTCRegionStore");
const MediaEngineStore: MediaEngineStore = findStoreLazy("MediaEngineStore");
const ApexExperimentStore: DiagnosticStore = findStoreLazy("ApexExperimentStore");
const ApplicationStreamingStore: DiagnosticStore = findStoreLazy("ApplicationStreamingStore");
const StreamRTCConnectionStore: DiagnosticStore = findStoreLazy("StreamRTCConnectionStore");
const RTCConnectionStore: DiagnosticStore = findStoreLazy("RTCConnectionStore");

const Native = VencordNative.pluginHelpers.StreamFix as PluginNative<typeof import("./native")>;

/** O laco do monitor, enquanto houver transmissao nossa no ar. */
let pararDeObservar: (() => void) | null = null;

// O experimento que esconde o Go Live de quem esta no Brasil. O plugin nao o desarma mais --
// ver docs/superpowers/plans/2026-09-11-tunel-nas-duas-pontas-plan.md, correcao 2. Continua
// aqui porque saber a atribuicao e diagnostico util.
const VIDEO_GUARD = "2026-08-video-guard";

const AUTOMATIC = "";
const VOICE_KEYS: "voiceRegion"[] = ["voiceRegion"];
const STREAM_KEYS: "streamRegion"[] = ["streamRegion"];

let original: RegionStore | undefined;

interface RegionSelectProps {
    value: string;
    placeholder: string;
    automaticLabel: string;
    onChange(region: string): void;
}

function RegionSelect({ value, placeholder, automaticLabel, onChange }: RegionSelectProps) {
    const [regions, error, pending] = useAwaiter(
        async () => {
            const { body } = await RestAPI.get({ url: Constants.Endpoints.REGIONS() });
            return (body as VoiceRegion[]).filter(region => !region.deprecated && !region.custom);
        },
        { fallbackValue: [] as VoiceRegion[] }
    );

    if (pending) return <Paragraph>Loading the region list.</Paragraph>;
    if (error) return <Paragraph>Discord did not hand over the region list. Log in and reopen settings to try again.</Paragraph>;

    const options = [
        { label: automaticLabel, value: AUTOMATIC },
        ...regions.map(region => ({ label: region.optimal ? `${region.name}, optimal for you` : region.name, value: region.id }))
    ];

    return (
        <SearchableSelect
            placeholder={placeholder}
            maxVisibleItems={8}
            options={options}
            value={options.find(option => option.value === value)?.value}
            onChange={onChange}
            closeOnSelect
        />
    );
}

function VoiceRegionPicker() {
    const { voiceRegion } = settings.use(VOICE_KEYS);

    return (
        <RegionSelect
            value={voiceRegion}
            placeholder="Pick the region your calls should connect through"
            automaticLabel="Automatic, whatever Discord picks"
            onChange={region => settings.store.voiceRegion = region}
        />
    );
}

function StreamRegionPicker() {
    const { streamRegion } = settings.use(STREAM_KEYS);

    return (
        <RegionSelect
            value={streamRegion}
            placeholder="Pick the region your screen share should go through"
            automaticLabel="Same region as your call"
            onChange={region => settings.store.streamRegion = region}
        />
    );
}

function AboutPlugin() {
    return (
        <Paragraph>
            Source and issues on <MaskedLink href="https://github.com/EduardoVasconceloss/StreamFix">GitHub</MaskedLink>. StreamFix is a fork of <MaskedLink href="https://github.com/bezumiya/GoLiveBypass">bezumiya/GoLiveBypass</MaskedLink>.
        </Paragraph>
    );
}

const settings = definePluginSettings({
    voiceRegion: {
        type: OptionType.COMPONENT,
        component: VoiceRegionPicker,
        default: AUTOMATIC
    },
    streamRegion: {
        type: OptionType.COMPONENT,
        component: StreamRegionPicker,
        default: AUTOMATIC
    },
    exigirTunel: {
        type: OptionType.BOOLEAN,
        description: "Block Go Live when the tunnel is not carrying your media. Without it Discord refuses the stream anyway -- this just tells you why, before it happens.",
        default: true
    },
    perfilDoTunel: {
        type: OptionType.STRING,
        description: "WireSock profile name. The installer writes it; change it only if you renamed the profile.",
        default: "streamfix-santiago"
    },
    enderecoDaSaida: {
        type: OptionType.STRING,
        description: "host:port of your exit. Checked against what Discord reports, so a mismatch is caught before you stream.",
        default: "159.112.151.37:39743"
    }
});

function forcedRegion() {
    const region = settings.store.voiceRegion;
    if (typeof region !== "string") return null;

    const trimmed = region.trim();
    return trimmed === AUTOMATIC ? null : trimmed;
}

function forceRegion() {
    if (original !== undefined) return;

    const store = RTCRegionStore;
    if (typeof store.getPreferredRegion !== "function"
        || typeof store.getPreferredRegions !== "function"
        || typeof store.shouldIncludePreferredRegion !== "function") {
        showToast("StreamFix could not find Discord's region picker, so your call region is untouched.", Toasts.Type.FAILURE);
        return;
    }

    const saved: RegionStore = {
        getPreferredRegion: store.getPreferredRegion,
        getPreferredRegions: store.getPreferredRegions,
        shouldIncludePreferredRegion: store.shouldIncludePreferredRegion
    };

    store.getPreferredRegion = function () {
        return forcedRegion() ?? saved.getPreferredRegion.call(this);
    };

    store.getPreferredRegions = function () {
        const forced = forcedRegion();
        const ranked = saved.getPreferredRegions.call(this);
        return forced === null ? ranked : [forced, ...(ranked ?? []).filter(region => region !== forced)];
    };

    store.shouldIncludePreferredRegion = function () {
        return forcedRegion() !== null || saved.shouldIncludePreferredRegion.call(this);
    };

    original = saved;
}

function restoreRegion() {
    if (original === undefined) return;

    RTCRegionStore.getPreferredRegion = original.getPreferredRegion;
    RTCRegionStore.getPreferredRegions = original.getPreferredRegions;
    RTCRegionStore.shouldIncludePreferredRegion = original.shouldIncludePreferredRegion;
    original = undefined;
}

/**
 * Por onde o Discord diz que a midia esta saindo.
 *
 * O caminho e o mesmo do `tests/fixtures/capture.mjs`, de proposito: o que a captura grava e o
 * que o plugin le. `null` quando nao ha conexao ainda -- nunca um endereco chutado.
 *
 * Prefere o contexto `stream`; cai para o `default`, que e a call. Nos dois o endereco e o
 * mesmo quando o tunel esta de pe, e no clique do Go Live so o `default` existe.
 */
async function enderecoLocalDaMidia(): Promise<string | null> {
    try {
        const motor = (MediaEngineStore as unknown as { getMediaEngine(): { connections: Iterable<any>; } })
            .getMediaEngine();
        const conexoes = [...motor.connections];
        const ordem = [...conexoes].sort((a, b) => (a?.context === "stream" ? -1 : 0) - (b?.context === "stream" ? -1 : 0));
        for (const conexao of ordem) {
            const stats = await conexao.getStats();
            const endereco = stats?.transport?.localAddress;
            if (typeof endereco === "string" && endereco.length > 0) return endereco;
        }
    } catch {
        // Motor ausente, campo renomeado, prazo de 1s do getStats estourado. Tudo vira "nao sei",
        // e quem decide o que fazer com isso e o porteiro.
    }
    return null;
}

/** Uma leitura crua para o coletor, no formato que as fixtures gravam. */
async function leituraDaMidia() {
    const motor = (MediaEngineStore as unknown as { getMediaEngine(): { connections: Iterable<any>; } })
        .getMediaEngine();
    const dados = [];
    for (const conexao of [...motor.connections]) {
        let stats: any = null;
        try { stats = await conexao.getStats(); } catch { stats = null; }
        const saida = stats?.rtp?.outbound ?? [];
        dados.push({
            context: conexao?.context ?? null,
            captura: { tela: stats?.screenshare ?? null, camera: stats?.camera ?? null },
            video: Array.isArray(saida) ? saida.filter((e: any) => e?.type === "video") : []
        });
    }

    let espectadores: number | null = null;
    try {
        const meu = ask(ApplicationStreamingStore, "getCurrentUserActiveStream");
        espectadores = meu == null || typeof meu === "string"
            ? null
            : ((ask(ApplicationStreamingStore, "getViewerIds", meu) as unknown[]) ?? []).length;
    } catch {
        espectadores = null;
    }

    return { espectadores, dados };
}

function comecarAObservar() {
    if (pararDeObservar !== null) return;
    let ultimo: string | null = null;

    pararDeObservar = observar(
        async () => leituraDaMidia(),
        (veredito: Veredito, _estado: Estado) => {
            const texto = aviso(veredito);
            // Um aviso por mudanca de veredito, nao por amostra. Repetir a mesma frase a cada
            // meio segundo seria ruido, e ruido a pessoa aprende a ignorar.
            if (texto === null || texto === ultimo) { ultimo = texto; return; }
            ultimo = texto;
            showToast(texto, Toasts.Type.FAILURE);
        }
    );
}

function pararDeObservarAgora() {
    pararDeObservar?.();
    pararDeObservar = null;
}

function ask(store: object, method: string, ...args: unknown[]) {
    const fn = (store as DiagnosticStore)[method];
    if (typeof fn !== "function") return "metodo ausente";

    try {
        return (fn as (...a: unknown[]) => unknown).apply(store, args) ?? null;
    } catch (error) {
        return `erro: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function buildReport() {
    const user = UserStore.getCurrentUser();
    const lines: string[] = ["StreamFix, diagnostico"];

    lines.push("", "== o servidor te bloqueia? ==");
    lines.push(`atribuicao do video guard: ${JSON.stringify(user == null ? "sem usuario" : ask(ApexExperimentStore, "getServerAssignment", "user", user.id, VIDEO_GUARD))}`);

    lines.push("", "== o cliente consegue fazer video? ==");
    // Estes valores voltaram a dizer a verdade: o patch que mantinha supportsInApp sempre
    // verdadeiro saiu junto com a proxy.
    lines.push(`supports(VIDEO)          ${ask(MediaEngineStore, "supports", "VIDEO")}`);
    lines.push(`supportsInApp(VIDEO)     ${ask(MediaEngineStore, "supportsInApp", "VIDEO")}`);
    lines.push(`supportsInApp(DESKTOP)   ${ask(MediaEngineStore, "supportsInApp", "DESKTOP_CAPTURE")}`);
    lines.push(`motor de midia pronto    ${ask(MediaEngineStore, "isSupported")}`);

    lines.push("", "== transmissao ==");
    lines.push(`minha transmissao ativa  ${JSON.stringify(ask(ApplicationStreamingStore, "getCurrentUserActiveStream"))}`);
    lines.push(`transmissoes visiveis    ${JSON.stringify(ask(ApplicationStreamingStore, "getAllActiveStreams"))}`);
    lines.push(`conexoes de midia        ${JSON.stringify(ask(StreamRTCConnectionStore, "getAllActiveStreamKeys"))}`);
    lines.push(`estado da call           ${ask(RTCConnectionStore, "getState")} em ${ask(RTCConnectionStore, "getHostname")}`);

    lines.push("", "== regiao ==");
    lines.push(`preferida  ${ask(RTCRegionStore, "getPreferredRegion")}`);
    lines.push(`lista      ${JSON.stringify(ask(RTCRegionStore, "getPreferredRegions"))}`);
    lines.push(`override instalado ${original !== undefined}`);

    lines.push("", "== configuracao ==");
    const { voiceRegion, streamRegion } = settings.store;
    lines.push(`regiao de call "${voiceRegion}" | regiao de stream "${streamRegion}"`);

    lines.push("", "== tunel ==");
    const { exigirTunel, perfilDoTunel, enderecoDaSaida } = settings.store;
    const saidaEsperada = hostDoEndpoint(enderecoDaSaida);
    let tunel: string;
    try {
        tunel = await Native.estadoDoTunel(perfilDoTunel);
    } catch (error) {
        tunel = `erro: ${error instanceof Error ? error.message : String(error)}`;
    }
    const localAddress = await enderecoLocalDaMidia();
    lines.push(`porteiro ${exigirTunel ? "ligado" : "desligado"} | perfil "${perfilDoTunel}"`);
    lines.push(`o WireSock diz       ${tunel}`);
    lines.push(`o Discord diz        ${localAddress ?? "nada ainda"}`);
    lines.push(`saida esperada       ${saidaEsperada ?? "nenhuma configurada"}`);
    lines.push(`veredito do porteiro ${JSON.stringify(decidir({
        tunel: tunel as EstadoTunel, localAddress, saidaEsperada, exigirTunel
    }))}`);
    lines.push(`monitor observando   ${pararDeObservar !== null}`);

    return lines.join("\n");
}

export default definePlugin({
    name: "StreamFix",
    description: "Keeps your calls and screen share on the region you pick. The Go Live tunnel is being rebuilt: see the 2026-09-11 plan.",
    authors: [
        { name: "Eduardo Vasconcelos", id: 389561533342023681n },
        { name: "bezumiya", id: 1366453661970071633n }
    ],
    tags: ["Voice", "Privacy"],
    settings,
    settingsAboutComponent: AboutPlugin,

    patches: [
        {
            find: ".STREAM_CREATE,{type:",
            replacement: {
                match: /(?<=\.STREAM_CREATE,\{.{0,80}?preferred_region:)\i/,
                replace: "$self.pickStreamRegion($&)"
            }
        },
        // O porteiro.
        //
        // A funcao ja tem protocolo de recusa proprio -- ela devolve [!1,"no source"] e
        // [!1,"no permission"] em outros caminhos -- entao a interface do Discord ja sabe lidar
        // com uma recusa vinda daqui. Nao foi preciso inventar recusa nenhuma.
        //
        // O nome `startStreamWithSource` existe so como string, num logger; a funcao em si e
        // minificada (`async function b(e,n){` no 1.0.9257). Por isso a ancora e a string, e o
        // corte e estrutural: logo depois dela, a proxima funcao assincrona de dois argumentos.
        // Conferido contra o bundle real -- ver tests/patch-go-live.test.cjs, que roda o mesmo
        // regex contra o modulo gravado e exige que ele case exatamente uma vez.
        {
            find: "\"startStreamWithSource\"",
            replacement: {
                match: /(?<="startStreamWithSource"\);.{0,200}?async function \i\(\i,\i\)\{)/,
                replace: "const _sf=await $self.antesDeTransmitir();if(!_sf.ok)return[!1,_sf.motivo];"
            }
        }
    ],

    pickStreamRegion(fallback: string | null) {
        const region = settings.store.streamRegion;
        return typeof region === "string" && region !== AUTOMATIC ? region : fallback;
    },

    /**
     * Chamado no clique do Go Live, antes de a transmissao subir.
     *
     * Devolve { ok: false, motivo } e o Discord mostra o motivo na propria interface. O porteiro
     * nunca lanca: qualquer erro aqui viraria transmissao travada, e a decisao de projeto e que
     * uma falha do StreamFix nao pode impedir alguem de transmitir.
     */
    async antesDeTransmitir() {
        try {
            const { exigirTunel, perfilDoTunel, enderecoDaSaida } = settings.store;
            if (!exigirTunel) return { ok: true as const };

            const [tunel, localAddress] = await Promise.all([
                Native.estadoDoTunel(perfilDoTunel) as Promise<EstadoTunel>,
                enderecoLocalDaMidia()
            ]);

            const veredito = decidir({
                tunel, localAddress, exigirTunel: true,
                saidaEsperada: hostDoEndpoint(enderecoDaSaida)
            });

            if (!veredito.ok && tunel !== "conectado") {
                // A spec pedia "um botao para tentar subir". Nao da para por botao na recusa do
                // Discord, e esperar o tunel aqui deixaria o clique pendurado ate 10 s. Subir em
                // segundo plano e avisar custa um clique a mais e nenhuma espera.
                showToast("StreamFix esta subindo o tunel. Clique em Go Live de novo em alguns segundos.", Toasts.Type.MESSAGE);
                void this.subirOTunel();
            }
            return veredito;
        } catch (error) {
            // Nao bloqueia por falha propria. A transmissao pode morrer, e ai o monitor avisa --
            // bem melhor do que ninguem conseguir transmitir porque o plugin quebrou.
            showToast(`StreamFix nao conseguiu conferir o tunel: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
            return { ok: true as const };
        }
    },

    async subirOTunel() {
        const resultado = await Native.subirTunel(settings.store.perfilDoTunel);
        if (!resultado.ok) showToast(`StreamFix: ${resultado.motivo}`, Toasts.Type.FAILURE);
        return resultado;
    },

    commands: [
        {
            name: "streamfix",
            description: "Copia um diagnostico do plugin para voce colar no suporte.",
            async execute(_args, ctx) {
                const report = await buildReport();
                copyWithToast(report, "Diagnostico copiado. Cole no canal de suporte.");
                sendBotMessage(ctx.channel.id, { content: `\`\`\`\n${report.slice(0, 1800)}\n\`\`\`` });
            }
        }
    ],

    flux: {
        // O monitor so roda enquanto ha transmissao nossa no ar. Observar sempre custaria uma
        // leitura do motor de midia a cada meio segundo por nada.
        STREAM_CREATE({ streamKey }: { streamKey?: string; }) {
            const eu = UserStore.getCurrentUser()?.id;
            if (eu != null && typeof streamKey === "string" && streamKey.includes(eu)) comecarAObservar();
        },
        STREAM_DELETE({ streamKey }: { streamKey?: string; }) {
            const eu = UserStore.getCurrentUser()?.id;
            if (eu != null && typeof streamKey === "string" && streamKey.includes(eu)) pararDeObservarAgora();
        }
    },

    start() {
        forceRegion();
        // D9: em quem transmite o tunel e permanente enquanto o plugin estiver ligado. Nao
        // porque a autorizacao precise -- ela sobrevive a queda -- mas porque alternar o tunel e
        // o que derruba conexao do Discord.
        if (settings.store.exigirTunel) void this.subirOTunel();
    },

    stop() {
        restoreRegion();
        pararDeObservarAgora();
        void Native.derrubarTunel();
    }
});
