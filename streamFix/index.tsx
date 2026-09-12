/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Constants, MaskedLink, RestAPI, SearchableSelect, showToast, Toasts, UserStore } from "@webpack/common";

import { aAmostra, ConexaoBruta } from "./tunnel/coletor";
import { EstadoTunel } from "./tunnel/controle";
import { criarEmprestimos, FOLGA_NASCIMENTO_MS, Motivo, Nivel, nivel, PRAZO_NASCIMENTO_MS } from "./tunnel/emprestimos";
import { decidirEntrada, PRAZO_ATE_DEVOLVER_MS } from "./tunnel/entrada";
import { Estado, Veredito } from "./tunnel/monitor";
import { observar } from "./tunnel/observador";
import { perfilDeControle } from "./tunnel/perfil";
import { aviso, conferirNascimento, decidirClique, donoDoStream, hostDoEndpoint } from "./tunnel/porteiro";
import { decidirTrava, descreverTrava, ESPERA_DEPOIS_DO_GATEWAY_MS, LeituraTrava, lerTrava, recargaRecente, VIDEO_GUARD } from "./tunnel/trava";
import { AVISO_VOZ_FORA, decidirVoz, EstadoVoz, EventoVoz, PRAZO_VOZ_MS, VOZ_INICIAL } from "./tunnel/voz";

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

// ---------------------------------------------------------------------------------------------
// O tunel em dois niveis
//
// docs/superpowers/specs/2026-09-11-tunel-em-dois-niveis-design.md. O normal e o perfil de
// controle, que leva so o gateway e a API: sem ele a Trava 1 volta. O completo e emprestado por
// segundos a cada conexao de midia que nasce, porque o Discord so confere o IP no nascimento.
// As decisoes vivem em unidades puras (`emprestimos`, `voz`, `entrada`); o que sobra aqui e
// fiacao, e ela e provada na fase 8 do plano.
// ---------------------------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;

/** Entre o `start` e o `stop`. Desligado, o nivel e sempre o completo (plano, fase 5, item 8). */
let ligado = false;

/** Se o perfil de controle existe. `null` enquanto o `start` nao perguntou: vale como `false`. */
let temControle: boolean | null = null;

/** A Trava 1 veio com o controle no ar (E6): completo ate o Discord fechar. */
let travaComControle = false;

/** Ja houve uma recarga por causa da trava nesta abertura do Discord. */
let recarregouPorTrava = false;

/** A espera entre o `CONNECTION_OPEN` e a leitura da atribuicao. */
let esperaDaTrava: ReturnType<typeof setTimeout> | null = null;

/**
 * A marca de "recarreguei por causa da trava", no DataStore do Vencord. O Discord apaga
 * `localStorage` e `sessionStorage` do renderer (conferido em 12/09), e a marca precisa
 * atravessar a recarga: sem ela, o plugin recarregado voltaria ao controle e recarregaria de novo.
 */
const MARCA_DA_RECARGA = "StreamFix_recargaPorTrava";

let emprestimos = criarEmprestimos();

/**
 * O perfil no ar, pelo que a ultima troca deixou.
 *
 * O gancho de entrar numa transmissao e **sincrono** -- nao da para perguntar ao WireSock no
 * meio dele. Entao a entrada le este cache. Durante uma troca ele vale `desconhecido`, e a
 * entrada aborta e repete depois dela, que e exatamente o desenho.
 */
let perfilNoAr: string | null | "desconhecido" = "desconhecido";

/** A fila das trocas: uma por vez, sempre. */
let filaDeTrocas: Promise<unknown> = Promise.resolve();

/** Ja avisamos que a volta ao controle falhou. Um aviso so, ate uma volta dar certo. */
let avisouVolta = false;

/** As devolucoes agendadas. O `stop` cancela todas. */
const adiadas = new Set<Timer>();

/** O emprestimo do Go Live, do clique ate a conexao de stream nascer. */
let transmissao: { id: number; prazo: Timer; } | null = null;

/** Ha um completo sendo posto no ar por causa de uma entrada. Cobre o intervalo entre abortar e repetir. */
let preparandoEntrada = false;

/** Esta chamada e a repeticao. Uma so, nunca reentrante: e o que impede o laco. */
let repetindoEntrada = false;

/** O emprestimo que a preparacao pegou, e que a repeticao herda. */
let emprestimoDaEntrada: number | null = null;

let estadoVoz: EstadoVoz = VOZ_INICIAL;
let emprestimoDaVoz: number | null = null;
let prazoDaVoz: Timer | null = null;
let filaDaVoz: Promise<unknown> = Promise.resolve();

/** As ultimas coisas que o tunel fez, para o `/streamfix`. Sem IP de casa: vai para suporte. */
const registro: string[] = [];

function anotar(texto: string) {
    const hora = new Date().toTimeString().slice(0, 8);
    registro.push(`${hora} ${texto}`);
    if (registro.length > 15) registro.shift();
}

function perfis() {
    const completo = settings.store.perfilDoTunel;
    return { completo, controle: perfilDeControle(completo) };
}

/** O tunel em dois niveis vale agora. Fora dele, o completo fica no ar o tempo todo. */
function doisNiveis() {
    return ligado && temControle === true && !settings.store.tunelCompletoSempre && !travaComControle;
}

function nivelAgora(): Nivel {
    if (!ligado) return "completo";
    return nivel({
        temControle: temControle === true,
        completoSempre: settings.store.tunelCompletoSempre,
        travaComControle,
        pedido: emprestimos.nivelDesejado()
    });
}

interface Aplicado {
    ok: boolean;
    nivel: Nivel;
    motivo: string | null;
}

/**
 * Poe no ar o perfil do nivel desejado.
 *
 * **Serializada.** Duas trocas ao mesmo tempo seriam dois `disconnect` e dois `connect`
 * intercalados, e o segundo `connect` seria recusado sem log. Cada chamada entra na fila e, na
 * sua vez, **reconfere** o nivel desejado, que pode ter mudado enquanto esperava. Quem chama
 * recebe o resultado da troca que rodou na sua vez.
 */
function aplicarNivel(): Promise<Aplicado> {
    const vez = filaDeTrocas.then(executarTroca, executarTroca);
    filaDeTrocas = vez.catch(() => undefined);
    return vez;
}

async function executarTroca(): Promise<Aplicado> {
    const alvo = nivelAgora();
    const { completo, controle } = perfis();
    const perfil = alvo === "completo" ? completo : controle;
    try {
        if (perfilNoAr !== perfil) perfilNoAr = "desconhecido";
        const r = await Native.trocarTunel(perfil);
        if (r.ok) {
            // Abaixo disso nao houve troca: foi so o `status` dizendo que o perfil ja estava no ar
            // (~220 a 350 ms, medido na fase 8). Anotar isso encheria o registro de nada.
            if (r.duracaoMs > 600) anotar(`${alvo} no ar em ${r.duracaoMs} ms`);
            perfilNoAr = perfil;
            if (alvo === "controle") avisouVolta = false;
            return { ok: true, nivel: alvo, motivo: null };
        }

        // A troca falhou, e o `subir` derruba o que subiu errado: agora pode nao haver tunel
        // nenhum. O outro nivel e melhor do que nada -- o completo funciona, so com mais
        // latencia; o controle ao menos segura a Trava 1.
        anotar(`${alvo} falhou: ${r.motivo}`);
        if (temControle === true) {
            const outro = alvo === "completo" ? controle : completo;
            const r2 = await Native.trocarTunel(outro);
            anotar(r2.ok ? `caiu para ${outro}` : `${outro} tambem falhou: ${r2.motivo}`);
        }
        perfilNoAr = await Native.perfilAtivo([completo, controle]);

        if (alvo === "controle" && perfilNoAr === completo && !avisouVolta) {
            avisouVolta = true;
            showToast("StreamFix nao conseguiu voltar ao tunel de controle. Tudo segue funcionando, so com a latencia mais alta.", Toasts.Type.FAILURE);
        }
        return { ok: false, nivel: alvo, motivo: r.motivo };
    } catch (error) {
        perfilNoAr = "desconhecido";
        const motivo = error instanceof Error ? error.message : String(error);
        anotar(`${alvo} falhou: ${motivo}`);
        return { ok: false, nivel: alvo, motivo };
    }
}

function pegar(motivo: Motivo) {
    const id = emprestimos.pegar(motivo);
    void aplicarNivel();
    return id;
}

function devolver(id: number | null) {
    if (id === null) return;
    emprestimos.devolver(id);
    void aplicarNivel();
}

function devolverDepois(id: number | null, ms: number) {
    if (id === null) return;
    const t = setTimeout(() => {
        adiadas.delete(t);
        devolver(id);
    }, ms);
    adiadas.add(t);
}

function devolverTransmissao() {
    if (transmissao === null) return;
    clearTimeout(transmissao.prazo);
    const { id } = transmissao;
    transmissao = null;
    devolver(id);
}

/** Se a transmissao e nossa, pelo dono na chave do stream. */
function ehMinha(streamKey: string | undefined) {
    const eu = UserStore.getCurrentUser()?.id;
    return eu != null && donoDoStream(streamKey) === eu;
}

// ---------------------------------------------------------------------------------------------
// A voz (spec, 4.6)
// ---------------------------------------------------------------------------------------------

type TipoDeEventoVoz = "entrou" | "saiu" | "conectando" | "conectada" | "expirou";

/** Os eventos da voz em fila: a conferencia le o `getStats`, e a ordem nao pode se perder. */
function eventoDeVoz(tipo: TipoDeEventoVoz) {
    filaDaVoz = filaDaVoz.then(() => processarVoz(tipo)).catch(error => {
        // Nada daqui pode lancar para dentro do Discord. Falha vira devolucao.
        anotar(`voz: ${error instanceof Error ? error.message : String(error)}`);
        encerrarVoz();
    });
}

function encerrarVoz() {
    if (prazoDaVoz !== null) clearTimeout(prazoDaVoz);
    prazoDaVoz = null;
    estadoVoz = VOZ_INICIAL;
    const id = emprestimoDaVoz;
    emprestimoDaVoz = null;
    devolver(id);
}

async function processarVoz(tipo: TipoDeEventoVoz) {
    const saida = hostDoEndpoint(settings.store.enderecoDaSaida);
    const ctx = { ativo: doisNiveis() && saida !== null, saida: saida ?? "" };
    const evento: EventoVoz = tipo === "conectada"
        ? { tipo, localAddress: ctx.ativo ? await enderecoDaConexao(c => c?.context === "default") : null }
        : { tipo };

    const { estado, acao } = decidirVoz(estadoVoz, evento, ctx);
    estadoVoz = estado;

    if (acao.pegar) emprestimoDaVoz = pegar("voz");
    if (acao.devolver !== null) {
        const id = emprestimoDaVoz;
        emprestimoDaVoz = null;
        if (acao.devolver === "agora") devolver(id);
        else devolverDepois(id, FOLGA_NASCIMENTO_MS);
    }

    // O prazo acompanha o emprestimo: renovado a cada evento com ele aberto, desligado sem ele.
    if (prazoDaVoz !== null) clearTimeout(prazoDaVoz);
    prazoDaVoz = estado.emprestimo ? setTimeout(() => eventoDeVoz("expirou"), PRAZO_VOZ_MS) : null;

    if (evento.tipo === "conectada" && ctx.ativo) {
        anotar(evento.localAddress == null ? "voz nasceu sem endereco legivel"
            : evento.localAddress === saida ? "voz nasceu na saida" : "voz nasceu fora da saida");
    }
    if (acao.aviso !== null) showToast(acao.aviso, Toasts.Type.FAILURE);
    if (acao.resgatar) await resgatarVoz();
}

/**
 * Renasce a conexao de voz com o completo no ar, sem sair do canal (E9).
 *
 * Espera a troca, porque um `reconnect()` com o controle no ar nasceria pelo Brasil de novo e
 * custaria ~0,7 s de voz por nada. Sem o completo, desiste com o aviso.
 */
async function resgatarVoz() {
    const aplicado = await aplicarNivel();
    // O plugin foi desligado durante a troca: nada de reconectar a voz de ninguem.
    if (!ligado) return;
    const rtc = (RTCConnectionStore as unknown as { getRTCConnection?(): { reconnect?(): void; } | null; })
        .getRTCConnection?.();

    if (!aplicado.ok || aplicado.nivel !== "completo" || typeof rtc?.reconnect !== "function") {
        // Sem conexao nenhuma, a pessoa saiu no meio: o `saiu` na fila devolve.
        if (rtc == null && aplicado.ok) return;
        anotar(`resgate da voz desistiu: ${aplicado.motivo ?? "sem reconnect()"}`);
        showToast(AVISO_VOZ_FORA, Toasts.Type.FAILURE);
        encerrarVoz();
        return;
    }

    anotar("resgatando a voz");
    rtc.reconnect();
}

/**
 * Confere por onde a nossa transmissao nasceu (fase 6).
 *
 * Lido no `RTC_CONNECTED`, antes da folga: e ali que o `localAddress` e exato. A leitura corre
 * em paralelo com a folga e nao a atrasa -- ele nao muda com a volta ao controle.
 */
async function conferirTransmissao() {
    try {
        const eu = UserStore.getCurrentUser()?.id;
        const local = await enderecoDaConexao(c => c?.context === "stream" && c?.streamUserId === eu);
        const texto = conferirNascimento(local, hostDoEndpoint(settings.store.enderecoDaSaida));
        anotar(local === null ? "transmissao nasceu sem endereco legivel"
            : texto === null ? "transmissao nasceu na saida" : "transmissao nasceu fora da saida");
        if (texto !== null && settings.store.exigirTunel) showToast(texto, Toasts.Type.FAILURE);
    } catch {
        // So avisa. Falha aqui nao pode mexer na transmissao.
    }
}

/** Le a atribuicao da Trava 1 que o servidor mandou. */
function lerTravaAgora(): LeituraTrava | null {
    const user = UserStore.getCurrentUser();
    if (user == null) return null;
    return lerTrava(
        ask(ApexExperimentStore, "getServerAssignment", "user", user.id, VIDEO_GUARD),
        ask(ApexExperimentStore, "getClientOverrides")
    );
}

/**
 * Confere a Trava 1 depois de uma conexao do gateway (E6, fase 7).
 *
 * Com o controle no ar, a trava vir significa que a faixa de controle nao cobriu o gateway
 * desta pessoa. O plugin passa para o completo ate o Discord fechar e recarrega uma vez, para o
 * gateway conectar de novo -- e so um `READY` novo tira a trava.
 */
async function conferirTrava() {
    try {
        if (!ligado) return;
        const leitura = lerTravaAgora();
        if (leitura === null) return;

        const d = decidirTrava({ trava: leitura.trava, doisNiveis: doisNiveis(), jaRecarregou: recarregouPorTrava });
        if (leitura.trava) anotar(`a trava veio (variante ${leitura.servidor})${d.forcarCompleto ? " com o controle no ar" : ""}`);
        if (d.aviso !== null) showToast(d.aviso, Toasts.Type.FAILURE);
        if (!d.forcarCompleto) return;

        travaComControle = true;
        const aplicado = await aplicarNivel();
        if (!d.recarregar) return;
        if (!aplicado.ok || aplicado.nivel !== "completo") {
            // Recarregar sem o completo no ar traria a trava de volta, e gastaria a unica recarga.
            anotar(`nao recarreguei: o completo nao subiu (${aplicado.motivo})`);
            return;
        }

        recarregouPorTrava = true;
        await DataStore.set(MARCA_DA_RECARGA, Date.now());
        anotar("recarregando o Discord pela trava");
        location.reload();
    } catch (error) {
        anotar(`conferencia da trava falhou: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * O `localAddress` de uma conexao do motor de midia, lido no nascimento.
 *
 * Tres tentativas curtas: logo no `RTC_CONNECTED` o `getStats` as vezes ainda vem vazio.
 */
async function enderecoDaConexao(qual: (conexao: any) => boolean): Promise<string | null> {
    for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 300));
        try {
            const motor = (MediaEngineStore as unknown as { getMediaEngine(): { connections: Iterable<any>; } })
                .getMediaEngine();
            const conexao = [...motor.connections].find(qual);
            const endereco = (await conexao?.getStats())?.transport?.localAddress;
            if (typeof endereco === "string" && endereco.length > 0) return endereco;
        } catch {
            // Motor ausente, prazo do getStats estourado: tenta de novo, e no fim vira `null`.
        }
    }
    return null;
}

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
    tunelCompletoSempre: {
        type: OptionType.BOOLEAN,
        description: "Send all of Discord through the tunnel the whole time, like older versions did. Calls go from ~35 ms to ~130 ms. Turn it on only if the lighter tunnel misbehaves for you.",
        default: false,
        onChange: () => void aplicarNivel()
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
    const dados: ConexaoBruta[] = [];
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
    const lines: string[] = ["StreamFix, diagnostico"];

    lines.push("", "== o servidor te bloqueia? ==");
    // Lida na hora, e nao da ultima conferencia: o `/streamfix` tem de dizer o que vale agora.
    const trava = lerTravaAgora();
    lines.push(...(trava === null ? ["sem usuario logado"] : descreverTrava(trava)));
    if (travaComControle) {
        lines.push(`a trava veio com o tunel leve no ar: completo ate o Discord fechar${recarregouPorTrava ? " (ja recarreguei uma vez)" : ""}`);
    }

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
    const { exigirTunel, enderecoDaSaida, tunelCompletoSempre } = settings.store;
    const { completo, controle } = perfis();
    const saidaEsperada = hostDoEndpoint(enderecoDaSaida);
    let noAr: string;
    try {
        noAr = String(await Native.perfilAtivo([completo, controle]) ?? "nenhum dos dois");
    } catch (error) {
        noAr = `erro: ${error instanceof Error ? error.message : String(error)}`;
    }
    const localAddress = await enderecoLocalDaMidia();
    const modo = doisNiveis() ? "dois niveis"
        : travaComControle ? "completo ate o Discord fechar (a trava veio com o controle)"
            : tunelCompletoSempre ? "completo sempre (configuracao)"
                : temControle !== true ? "completo sempre (sem perfil de controle)"
                    : "completo sempre";
    lines.push(`porteiro ${exigirTunel ? "ligado" : "desligado"} | modo ${modo}`);
    lines.push(`perfis               "${completo}" e "${controle}" (${temControle === true ? "os dois instalados" : "o de controle nao existe"})`);
    if (temControle !== true) {
        // E5: quem atualizou o plugin e nao o instalador. Funciona, so com a latencia de antes.
        lines.push("                     rode o instalador de novo para baixar a latencia das calls");
    }
    lines.push(`o WireSock diz       ${noAr}`);
    // Divergir disto e o modo de falha a procurar: alguem trocou o tunel por fora do plugin.
    lines.push(`o plugin acha        ${perfilNoAr ?? "nenhum dos dois"}`);
    lines.push(`nivel desejado       ${nivelAgora()} | emprestimos: ${emprestimos.abertos().join(", ") || "nenhum"}`);
    lines.push(`voz                  ${JSON.stringify(estadoVoz)}`);
    lines.push(`o Discord diz        ${localAddress ?? "nada ainda"}`);
    lines.push(`saida esperada       ${saidaEsperada ?? "nenhuma configurada"}`);
    lines.push(`monitor observando   ${pararDeObservar !== null}`);
    lines.push(`entrada preparando   ${preparandoEntrada}`);

    lines.push("", "== o que o tunel fez ==");
    lines.push(...(registro.length > 0 ? registro : ["nada ainda"]));

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
        },
        // O porteiro de quem assiste.
        //
        // A funcao e **sincrona** -- despacha STREAM_WATCH e retorna. Nao da para esperar o
        // tunel dentro dela sem torna-la assincrona e mudar a ordem para quem a chama. Entao o
        // padrao nao e segurar: aborta a entrada, sobe o tunel, e chama a original de novo.
        //
        // **Um patch so, e de proposito.** O modulo exporta A9 (entrar) e Nl (entrar e focar),
        // mas Nl chama A9 por dentro. Patchar as duas dispararia o porteiro duas vezes por
        // entrada e tornaria a repeticao reentrante.
        //
        // O $1 e o nome minificado da propria funcao, e e por ele que a repeticao chama a
        // original. `arguments` dentro da arrow e o da funcao que a contem -- arrow nao tem o
        // proprio. Ver tests/patch-assistir.test.cjs, que roda este mesmo regex contra o modulo
        // real e exige que ele case exatamente uma vez.
        {
            find: "Cannot join a null voice channel",
            replacement: {
                match: /(?<=function (\i)\(\i,\i\)\{)(?=if\(null!=\i\.default\.getRemoteSessionId\(\)\)return)/,
                replace: "if(!$self.antesDeAssistir(()=>$1(...arguments)))return;"
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
    async antesDeTransmitir(): Promise<{ ok: true; } | { ok: false; motivo: string; }> {
        try {
            const { exigirTunel, enderecoDaSaida } = settings.store;

            // Uma transmissao nossa por vez: um clique novo substitui o emprestimo do anterior.
            devolverTransmissao();
            const id = emprestimos.pegar("transmitir");
            transmissao = {
                id,
                // A transmissao pode nao nascer. Sem isto o completo ficaria preso.
                prazo: setTimeout(() => { if (transmissao?.id === id) devolverTransmissao(); }, PRAZO_NASCIMENTO_MS)
            };

            // E4: o clique **espera** a troca. ~1,25 s, e some o "clique de novo em alguns segundos".
            const aplicado = await aplicarNivel();
            const modoDoisNiveis = doisNiveis();
            const veredito = decidirClique({
                exigirTunel,
                doisNiveis: modoDoisNiveis,
                troca: { ok: aplicado.ok, completo: aplicado.nivel === "completo", motivo: aplicado.motivo },
                // So o completo sempre usa a voz, e so ali vale o custo do `getStats`.
                localAddress: exigirTunel && !modoDoisNiveis ? await enderecoLocalDaMidia() : null,
                saidaEsperada: hostDoEndpoint(enderecoDaSaida)
            });
            if (!veredito.ok) {
                devolverTransmissao();
                return veredito;
            }
            return { ok: true };
        } catch (error) {
            // Nao bloqueia por falha propria. A transmissao pode morrer, e ai o monitor avisa --
            // bem melhor do que ninguem conseguir transmitir porque o plugin quebrou.
            showToast(`StreamFix nao conseguiu conferir o tunel: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
            return { ok: true };
        }
    },

    /**
     * Chamado no clique de entrar numa transmissao, antes de o STREAM_WATCH sair.
     *
     * Sincrono de proposito: o gancho e sincrono. Devolve `false` e a entrada nao acontece --
     * que e o mesmo caminho que a funcao ja usa quando ha sessao remota.
     *
     * @param repetir chama a funcao original de novo, com os mesmos argumentos.
     */
    antesDeAssistir(repetir: () => void) {
        try {
            const { completo } = perfis();
            const tunel: EstadoTunel = perfilNoAr === "desconhecido" ? "desconhecido"
                : perfilNoAr === completo ? "conectado" : "fora";
            const decisao = decidirEntrada({
                exigirTunel: settings.store.exigirTunel,
                tunel,
                jaTentou: repetindoEntrada,
                preparando: preparandoEntrada
            });

            if (decisao.aviso !== null) {
                showToast(decisao.aviso, decisao.prepararTunel ? Toasts.Type.MESSAGE : Toasts.Type.FAILURE);
            }

            if (decisao.entrar) {
                // O completo tem de ficar ate a conexao de stream nascer. Se a preparacao pegou
                // um emprestimo, a entrada o herda; se o completo ja estava no ar por outro
                // motivo, pega o seu, para quem o segura nao devolve-lo no meio do nascimento.
                const id = emprestimoDaEntrada ?? pegar("assistir");
                emprestimoDaEntrada = null;
                devolverDepois(id, PRAZO_ATE_DEVOLVER_MS);
                // `repetindoEntrada` nao se zera aqui: quem o zera e o `finally` de
                // prepararERepetir, que e o dono do ciclo inteiro.
                return true;
            }

            if (decisao.prepararTunel) void this.prepararERepetir(repetir);

            return false;
        } catch (error) {
            // Falha nossa nao pode impedir alguem de assistir. Se o tunel nao estiver de pe, a
            // tela fica preta -- mas isso e melhor do que o plugin quebrado travar a entrada.
            preparandoEntrada = false;
            repetindoEntrada = false;
            showToast(`StreamFix nao conseguiu conferir o tunel: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
            return true;
        }
    },

    /**
     * Pega o completo emprestado e repete a entrada. Uma vez so.
     *
     * `preparandoEntrada` vale durante a troca, para que um clique impaciente ouca "ainda
     * subindo" em vez de "desisti". `repetindoEntrada` vale so durante a repeticao, e e ele que
     * impede a repeticao de pedir outra repeticao.
     *
     * O `finally` repete mesmo se a troca falhar: a decisao de entrar ou nao e do porteiro, que
     * vai ver o completo ainda fora e desistir com o aviso certo. E, se ele desistir, o
     * emprestimo que a repeticao nao herdou e devolvido ali mesmo.
     */
    async prepararERepetir(repetir: () => void) {
        preparandoEntrada = true;
        emprestimoDaEntrada = emprestimos.pegar("assistir");
        try {
            await aplicarNivel();
        } finally {
            repetindoEntrada = true;
            try {
                repetir();
            } finally {
                repetindoEntrada = false;
                preparandoEntrada = false;
                const sobrou = emprestimoDaEntrada;
                emprestimoDaEntrada = null;
                devolver(sobrou);
            }
        }
    },

    commands: [
        {
            name: "streamfix",
            description: "Copia um diagnostico do plugin para voce colar no suporte.",
            async execute(_args, ctx) {
                const report = await buildReport();
                copyWithToast(report, "Diagnostico copiado. Cole no canal de suporte.");
                // Em partes, quebrando por linha: cortado em 1800 caracteres, o chat perdia justo
                // o fim, que e o registro do tunel -- a parte que mais explica o que aconteceu.
                const partes: string[] = [];
                for (const linha of report.split("\n")) {
                    const ultima = partes.length - 1;
                    if (ultima >= 0 && partes[ultima].length + linha.length + 1 <= 1800) partes[ultima] += `\n${linha}`;
                    else partes.push(linha.slice(0, 1800));
                }
                for (const parte of partes) sendBotMessage(ctx.channel.id, { content: `\`\`\`\n${parte}\n\`\`\`` });
            }
        }
    ],

    flux: {
        // O monitor so roda enquanto ha transmissao nossa no ar. Observar sempre custaria uma
        // leitura do motor de midia a cada meio segundo por nada.
        STREAM_CREATE({ streamKey }: { streamKey?: string; }) {
            if (!ehMinha(streamKey)) return;
            comecarAObservar();
        },
        STREAM_DELETE({ streamKey }: { streamKey?: string; }) {
            if (!ehMinha(streamKey)) return;
            pararDeObservarAgora();
            // Acabou antes de nascer: o emprestimo do clique nao tem mais para que ficar.
            devolverTransmissao();
        },

        // Cada conexao do gateway traz uma avaliacao nova da Trava 1 no `READY` (E6). A espera e
        // para a store processar o mesmo evento antes da leitura.
        CONNECTION_OPEN() {
            if (esperaDaTrava !== null) clearTimeout(esperaDaTrava);
            esperaDaTrava = setTimeout(() => {
                esperaDaTrava = null;
                void conferirTrava();
            }, ESPERA_DEPOIS_DO_GATEWAY_MS);
        },

        // Entrar e sair da call. O emprestimo sai no clique, **sem segurar** a entrada (E8): a
        // troca ganha a corrida contra o nascimento da voz, e quando perde o resgate cobre.
        VOICE_CHANNEL_SELECT({ channelId }: { channelId?: string | null; }) {
            try {
                eventoDeVoz(channelId ? "entrou" : "saiu");
            } catch {
                // Nada daqui pode lancar para dentro do Discord.
            }
        },

        // O nascimento das conexoes de midia. A de stream traz a `streamKey` (conferido no
        // bundle 1.0.9257); a de voz vem com `context: "default"`.
        RTC_CONNECTION_STATE({ state, context, streamKey }: { state?: string; context?: string; streamKey?: string; }) {
            try {
                if (typeof streamKey === "string") {
                    // A nossa transmissao nasceu. O veredito ja esta dado (12i); a folga e margem.
                    if (state !== "RTC_CONNECTED" || !ehMinha(streamKey) || transmissao === null) return;
                    const { id, prazo } = transmissao;
                    clearTimeout(prazo);
                    transmissao = null;
                    devolverDepois(id, FOLGA_NASCIMENTO_MS);
                    void conferirTransmissao();
                    return;
                }
                if (context !== "default") return;
                // Toda conexao de voz nova passa pelo CONNECTING, venha ou nao de um clique: e
                // assim que uma reconexao sozinha tambem pega o completo.
                if (state === "CONNECTING") eventoDeVoz("conectando");
                else if (state === "RTC_CONNECTED") eventoDeVoz("conectada");
            } catch {
                // Idem.
            }
        }
    },

    start() {
        forceRegion();
        ligado = true;
        void this.prepararNiveis();
    },

    /**
     * Descobre se o perfil de controle existe e poe no ar o nivel certo.
     *
     * Sem o perfil de controle (quem atualizou o plugin e nao rodou o instalador), o nivel e o
     * completo, que e o comportamento de antes (E5). Enquanto a pergunta nao volta, tambem.
     */
    async prepararNiveis() {
        try {
            temControle = await Native.perfilExiste(perfis().controle);
        } catch {
            temControle = false;
        }
        anotar(temControle ? "perfil de controle encontrado" : "sem perfil de controle: completo sempre");

        // Esta abertura veio de uma recarga pela trava: completo ate o Discord fechar, e nada de
        // recarregar de novo. A marca e apagada na leitura, entao a proxima abertura tenta o
        // tunel leve outra vez.
        try {
            const marca = await DataStore.get(MARCA_DA_RECARGA);
            if (marca !== undefined) await DataStore.del(MARCA_DA_RECARGA);
            if (recargaRecente(marca, Date.now())) {
                travaComControle = true;
                recarregouPorTrava = true;
                anotar("aberto por uma recarga pela trava: completo ate o Discord fechar");
            }
        } catch {
            // Sem saber se esta abertura veio de uma recarga, nao recarrega nesta: sem a marca,
            // uma recarga poderia puxar outra, e laco de recarga e o pior modo de falha aqui.
            recarregouPorTrava = true;
        }

        await aplicarNivel();

        // O gateway pode ter conectado antes de o plugin ligar, e ai o CONNECTION_OPEN ja passou.
        void conferirTrava();

        // Ligado com a call ja no ar (o Discord volta sozinho ao canal, ou o plugin foi ligado
        // no meio dela): a voz nasceu antes de haver quem a conferisse. Confere agora, e o
        // resgate cobre se ela nasceu pelo Brasil.
        if (ask(RTCConnectionStore, "getState") === "RTC_CONNECTED") eventoDeVoz("conectada");
    },

    stop() {
        restoreRegion();
        pararDeObservarAgora();

        // Desligar o plugin nao pode deixar a pessoa no controle sem porteiro nenhum: o nivel
        // desligado e o completo, que funciona sem o plugin. Tudo o que estava aberto e
        // descartado antes, para nenhuma devolucao atrasada trocar o tunel depois.
        ligado = false;
        if (esperaDaTrava !== null) clearTimeout(esperaDaTrava);
        esperaDaTrava = null;
        for (const t of adiadas) clearTimeout(t);
        adiadas.clear();
        if (transmissao !== null) clearTimeout(transmissao.prazo);
        transmissao = null;
        if (prazoDaVoz !== null) clearTimeout(prazoDaVoz);
        prazoDaVoz = null;
        estadoVoz = VOZ_INICIAL;
        emprestimoDaVoz = null;
        emprestimoDaEntrada = null;
        emprestimos = criarEmprestimos();
        repetindoEntrada = false;
        preparandoEntrada = false;
        void aplicarNivel();
    }
});
