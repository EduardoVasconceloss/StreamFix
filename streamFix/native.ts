/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NativeSettings, RendererSettings } from "@main/settings";
import { app, IpcMainInvokeEvent, session } from "electron";
import { request } from "https";
import { AddressInfo, connect, createServer as createSocksServer, Server as SocksServer, Socket } from "net";
import { connect as connectTls } from "tls";

const FREE_PROXY_API = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=json&timeout=1500";
const DISCORD_HOST = "discord.com";

// O trace da Cloudflare (~200 bytes) confirma tunel SOCKS, TLS valido e pais de saida numa
// unica conexao, em vez de duas (discord.com + ifconfig.co) como antes.
const TRACE_HOST = "cloudflare.com";
const TRACE_PATH = "/cdn-cgi/trace";

// gateway.discord.gg e remote-auth-gateway.discord.gg cobrem a conexao inicial, mas o resume
// automatico (_handleClose -> _connect, quando a internet do usuario oscila) usa resumeUrl, um
// host regional por shard (ex.: gateway-us-east1-c.discord.gg) que uma lista exata nunca cobre.
// O padrao casa os dois hosts fixos e qualquer variante regional, sem casar o discord.gg puro
// (dominio de convites, que nao deve ser roteado).
const GATEWAY_HOSTS = ["gateway.discord.gg", "remote-auth-gateway.discord.gg"];
// Fonte de texto, nao RegExp: e interpolada dentro do PAC script, que roda no Chromium, nao no
// processo principal -- aqui ela nunca e avaliada como regex de verdade.
const GATEWAY_HOST_PATTERN_SOURCE = "^(remote-auth-)?gateway(-[a-z0-9]+)*\\.discord\\.gg$";
const LOGIN_HOSTS = ["discord.com", "canary.discord.com", "ptb.discord.com"];

// Experimento de 2026-09-08, DESLIGADO porque a hipotese foi refutada: alinhar o controle TCP
// de midia a saida do gateway nao devolve o video. Com `*.discord.media` saindo por outro pais
// e trafego bidirecional confirmado, o servidor negou a entrega assim mesmo -- ele valida o IP
// da midia UDP, nao o do controle TCP. Ver docs/research/regressao-encoder-inativo-2026-09-03.md,
// secao 12b, item 5.
//
// Ligado, custa latencia no estabelecimento do stream e entrega metadados das conexoes de midia
// a uma saida de terceiro, sem nenhum ganho em troca. O codigo e a instrumentacao ficam para
// quem precisar reinvestigar; nao religar sem uma hipotese nova.
// Apenas TCP via PAC: nao implementa SOCKS UDP ASSOCIATE nem muda a rede do sistema.
const MEDIA_CONTROL_EXPERIMENT = false;
const MEDIA_HOST_PATTERN_SOURCE = "^([a-z0-9-]+\\.)+discord\\.media$";
const MEDIA_HOST_PATTERN = new RegExp(MEDIA_HOST_PATTERN_SOURCE);
const GATEWAY_HOST_PATTERN = new RegExp(GATEWAY_HOST_PATTERN_SOURCE);
const MEDIA_DEBUG = "[DEBUG-media-control]";
const debugExits = new Map<string, number>();
const debugConnections = new Map<number, { kind: string; route: string; tx: number; rx: number; }>();
let debugConnectionId = 0;

function debugExit(value: string | null) {
    if (value === null) return "DIRECT";
    if (!debugExits.has(value)) debugExits.set(value, debugExits.size + 1);
    return `saida#${debugExits.get(value)}`;
}

function debugConnectionLine(id: number, state: { kind: string; route: string; tx: number; rx: number; }) {
    return `${MEDIA_DEBUG} conexao#${id} ${state.kind} ${state.route} tx=${state.tx} rx=${state.rx}`;
}

const MAX_LIST_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 6000;

// Prazo curto pras checagens no caminho de abertura: cada segundo aqui sai do orcamento que
// segura o gateway.
const WARM_PROBE_TIMEOUT_MS = 2500;

const PARALLEL_PROBES = 12;
const MAX_CANDIDATES = 48;
const MIN_UPTIME = 90;
const MAX_LISTED_TIMEOUT = 1500;

// O Vencord indexa settings pelo campo "name:" do plugin -- trocar esse campo sozinho comeca
// do zero pra quem ja tinha o plugin instalado sob o nome antigo, perdendo proxy escolhido,
// paises excluidos e o pote de saidas guardadas. Move (nao copia) uma vez, no carregamento do
// modulo (o mais cedo possivel, antes do renderer ler as proprias settings) e de novo no
// inicio de enable() como reforco. So move se o destino ainda nao existe -- nunca sobrescreve.
// Apagar a origem depois de copiar e essencial, nao cosmetico: achado num review adversarial
// que apagar mesmo apos copiar previne um plugin antigo (rollback) reativando em silencio um
// proxy/roteamento que a pessoa ja tinha desligado no StreamFix -- duas copias vivas da mesma
// configuracao, uma delas nunca mais atualizada, e exatamente esse buraco.
function migrateLegacySettings() {
    const rendererPlugins = (RendererSettings.store.plugins ??= {});
    if (rendererPlugins.GoLiveBypass && !rendererPlugins.StreamFix) {
        rendererPlugins.StreamFix = { ...rendererPlugins.GoLiveBypass };
        delete rendererPlugins.GoLiveBypass;
    }

    const nativePlugins = (NativeSettings.store.plugins ??= {});
    if (nativePlugins.GoLiveBypass && !nativePlugins.StreamFix) {
        nativePlugins.StreamFix = { ...nativePlugins.GoLiveBypass };
        delete nativePlugins.GoLiveBypass;
    }
}
migrateLegacySettings();

// Portas SOCKS de Tor em ordem de preferencia; 9052 primeiro por ser a que o instalador
// configura com bridge meek (atravessa rede censurada).
const TOR_PORTS = [9052, 9150, 9050, 9250];
const TOR_PORT_TIMEOUT_MS = 400;

const POOL_SIZE = 5;
const POOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_LOG_LINES = 200;

// Orcamento que se renova, nao teto vitalicio: uma sessao longa com internet instavel nao pode
// desistir de vez depois das duas primeiras quedas. A janela reabre sozinha; sucesso tambem
// zera o contador na hora, via sessionWorked().
const MAX_RETRIES_PER_WINDOW = 3;
const RETRY_WINDOW_MS = 5 * 60_000;

// Se estourar, o gateway sai direto: perde-se o Go Live daquela sessao, nunca o Discord.
const STALL_BUDGET_MS = 12_000;

// Menores que o teste de candidata: uma saida agonizante que demora a falhar faz o Chromium
// desistir do roteador inteiro.
const RELAY_TUNNEL_TIMEOUT_MS = 2500;
const RELAY_DIRECT_TIMEOUT_MS = 8000;

const INTERCEPTING_PORTS = new Set([4145]);
const PROXY_RULES_RE = /^(socks5|https?):\/\/([a-z0-9.-]{1,253}):(\d{1,5})$/;

export type Scope = "login" | "gateway" | "off";

interface PoolEntry {
    proxy: string;
    country: string;
    ms: number;
    at: number;
}

const history: string[] = [];

let retries = 0;
let retryWindowStart = 0;
let retryWindowTimer: ReturnType<typeof setTimeout> | null = null;

function log(message: string) {
    const line = `${new Date().toISOString().slice(11, 19)} ${message}`;
    history.push(line);
    if (history.length > MAX_LOG_LINES) history.shift();
}

function parseProxy(proxyRules: string) {
    const match = PROXY_RULES_RE.exec(proxyRules);
    if (!match) return null;

    const port = Number(match[3]);
    if (port < 1 || port > 65535) return null;

    return { scheme: match[1], host: match[2], port };
}

function pluginSettings() {
    return RendererSettings.plain.plugins?.StreamFix;
}

function pluginEnabled() {
    return pluginSettings()?.enabled === true;
}

// Tres respostas: campo vazio (procure sozinho), endereco bom (use este), lixo (nao invente
// uma saida que a pessoa nao escolheu).
function manualProxy(): { proxy: string; } | "auto" | "invalid" {
    const proxy = pluginSettings()?.proxy;
    if (typeof proxy !== "string" || proxy.trim() === "") return "auto";

    const trimmed = proxy.trim();
    return parseProxy(trimmed) === null ? "invalid" : { proxy: trimmed };
}

function excludedCountries() {
    const raw: unknown = pluginSettings()?.excludedCountries;
    const codes = typeof raw === "string" ? raw.split(",") : ["BR"];

    return new Set(codes.map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code)));
}

// O renderer manda a propria lista nas chamadas que ele inicia. O nome do parametro cobre o
// da funcao acima dentro daquelas funcoes, entao a leitura precisa de nome proprio.
function requestedCountries(raw: unknown) {
    return new Set(
        typeof raw === "string"
            ? raw.split(",").map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code))
            : []
    );
}

function routesLogin() {
    return pluginSettings()?.sessionRouting === "login";
}

function readPool(): PoolEntry[] {
    let stored: unknown;
    try {
        stored = NativeSettings.plain.plugins?.StreamFix?.pool;
    } catch {
        return [];
    }

    if (!Array.isArray(stored)) return [];

    return stored.filter((entry): entry is PoolEntry => {
        if (typeof entry !== "object" || entry === null) return false;

        const { proxy, country, ms, at } = entry as Partial<PoolEntry>;
        return typeof proxy === "string" && parseProxy(proxy) !== null
            && typeof country === "string" && typeof ms === "number"
            && typeof at === "number" && Date.now() - at < POOL_MAX_AGE_MS;
    });
}

// Duas instancias do Discord dividem este arquivo; gravar pode falhar por disputa. Perder o
// pote custa uma busca a mais no proximo boot -- deixar a excecao subir custava o processo.
function writePool(entries: PoolEntry[]) {
    try {
        NativeSettings.store.plugins.StreamFix ??= {};
        NativeSettings.store.plugins.StreamFix.pool = entries
            .sort((a, b) => a.ms - b.ms)
            .slice(0, POOL_SIZE);
    } catch {
        // sem pote guardado, o proximo boot procura de novo
    }
}

function readFrame(socket: Socket, size: (buffer: Buffer) => number, done: (frame: Buffer | null) => void) {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (frame: Buffer | null) => {
        if (settled) return;
        settled = true;
        socket.off("data", onData);
        socket.off("close", onClose);
        done(frame);
    };

    const onClose = () => finish(null);

    const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const wanted = size(buffer);
        if (wanted < 0 || buffer.length < wanted) return;

        socket.pause();
        if (buffer.length > wanted) socket.unshift(buffer.subarray(wanted));
        finish(buffer.subarray(0, wanted));
    };

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.resume();
}

function socksReplySize(buffer: Buffer) {
    if (buffer.length < 4) return -1;
    if (buffer[3] === 1) return 10;
    if (buffer[3] === 4) return 22;
    return buffer.length < 5 ? -1 : 7 + buffer[4];
}

function negotiateSocks5(socket: Socket, host: string, port: number, done: (ok: boolean) => void) {
    readFrame(socket, buffer => buffer.length < 2 ? -1 : 2, greeting => {
        if (greeting === null || greeting[1] !== 0) return done(false);

        readFrame(socket, socksReplySize, reply => done(reply !== null && reply[1] === 0));

        const target = Buffer.from(host, "latin1");
        socket.write(Buffer.concat([
            Buffer.from([5, 1, 0, 3, target.length]),
            target,
            Buffer.from([port >> 8, port & 0xff])
        ]));
    });

    socket.write(Buffer.from([5, 1, 0]));
}

function negotiateConnect(socket: Socket, host: string, port: number, done: (ok: boolean) => void) {
    readFrame(socket, buffer => {
        const end = buffer.indexOf("\r\n\r\n");
        return end < 0 ? -1 : end + 4;
    }, reply => done(reply !== null && /^HTTP\/1\.[01] 200/.test(reply.toString("latin1"))));

    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
}

function openDirect(host: string, port: number, timeoutMs: number): Promise<Socket | null> {
    return new Promise(resolve => {
        const socket = connect({ host, port });
        let settled = false;

        const finish = (result: Socket | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            socket.setTimeout(0);
            if (result === null) socket.destroy();
            resolve(result);
        };

        const guard = setTimeout(() => finish(null), timeoutMs);
        socket.setTimeout(timeoutMs, () => finish(null));
        socket.on("error", () => finish(null));
        socket.once("connect", () => finish(socket));
    });
}

function openTunnel(proxy: string, host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Socket | null> {
    const parsed = parseProxy(proxy);
    if (parsed === null) return Promise.resolve(null);

    return new Promise(resolve => {
        const socket = connect({ host: parsed.host, port: parsed.port });
        let settled = false;

        const finish = (tunnel: Socket | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            socket.setTimeout(0);
            if (tunnel === null) socket.destroy();
            resolve(tunnel);
        };

        const guard = setTimeout(() => finish(null), timeoutMs);
        socket.setTimeout(timeoutMs, () => finish(null));
        socket.on("error", () => finish(null));
        socket.once("connect", () => {
            const done = (ok: boolean) => finish(ok ? socket : null);
            if (parsed.scheme === "socks5") negotiateSocks5(socket, host, port, done);
            else negotiateConnect(socket, host, port, done);
        });
    });
}

function readOverTls(socket: Socket, host: string, path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
    return new Promise(resolve => {
        let body = "";
        let settled = false;

        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tls.destroy();
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), timeoutMs);
        const tls = connectTls({ socket, servername: host, host }, () => {
            tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
        });

        tls.setEncoding("latin1");
        tls.on("error", () => finish(null));
        tls.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 65536) finish(body);
        });
        tls.on("end", () => finish(body));
    });
}

function listening(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect({ host: "127.0.0.1", port });
        const finish = (open: boolean) => {
            socket.destroy();
            resolve(open);
        };

        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.on("error", () => finish(false));
    });
}

function downloadText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = request(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error("Unexpected response status"));
                return;
            }

            const chunks: Buffer[] = [];
            let size = 0;
            let settled = false;

            res.on("data", (chunk: Buffer) => {
                if (settled) return;

                size += chunk.length;
                if (size > MAX_LIST_BYTES) {
                    settled = true;
                    res.destroy();
                    reject(new Error("Response too large"));
                    return;
                }

                chunks.push(chunk);
            });

            res.on("end", () => {
                if (settled) return;
                settled = true;
                resolve(Buffer.concat(chunks).toString("utf8"));
            });
        });

        req.on("error", reject);
        req.setTimeout(15_000, () => req.destroy(new Error("Request timed out")));
        req.end();
    });
}

// O trace da Cloudflare prova que a saida chega na internet, nao que alcanca o Discord --
// uma rede que bloqueia so dominios do Discord passaria no Cloudflare e falharia aqui. Nao
// exige HTTP 200 (gateway.discord.gg responde 404 a um GET comum): qualquer status valido
// ja prova que a conexao e o TLS chegaram la.
async function reachesGateway(proxy: string, timeoutMs: number) {
    const socket = await openTunnel(proxy, GATEWAY_HOSTS[0], 443, timeoutMs);
    if (socket === null) return false;

    const response = await readOverTls(socket, GATEWAY_HOSTS[0], "/", timeoutMs);
    return response !== null && /^HTTP\/1\.[01] \d{3}/.test(response);
}

async function measure(proxy: string, timeoutMs = PROBE_TIMEOUT_MS) {
    const started = Date.now();

    const socket = await openTunnel(proxy, TRACE_HOST, 443, timeoutMs);
    if (socket === null) return null;

    const response = await readOverTls(socket, TRACE_HOST, TRACE_PATH, timeoutMs);
    if (response === null || !/^HTTP\/1\.[01] 200/.test(response)) return null;

    const country = /(?:^|\n)loc=([A-Za-z]{2})/.exec(response);
    if (country === null) return null;

    const ip = /(?:^|\n)ip=(\S+)/.exec(response);

    if (!(await reachesGateway(proxy, timeoutMs))) return null;

    return { proxy, country: country[1].toUpperCase(), ip: ip?.[1] ?? "", ms: Date.now() - started };
}

// Todo o lote anda junto, a primeira que responder bem ganha -- testar candidata por candidata
// podia somar um minuto sozinho.
function firstUsable(candidates: string[], excluded: Set<string>, timeoutMs: number) {
    return new Promise<PoolEntry | null>(resolve => {
        let pending = candidates.length;
        if (pending === 0) return resolve(null);

        let settled = false;

        // candidates.map(measure) pareceria igual mas nao e: map passa (item, indice, array),
        // e o indice cairia em timeoutMs, dando zero ms pra candidata numero zero.
        for (const candidate of candidates) {
            measure(candidate, timeoutMs).then(result => {
                if (!settled && result !== null && !excluded.has(result.country)) {
                    settled = true;
                    log(`${result.proxy} passou: ${result.ms}ms, saida em ${result.country}`);
                    resolve({ proxy: result.proxy, country: result.country, ms: result.ms, at: Date.now() });
                    return;
                }

                if (result !== null && excluded.has(result.country)) log(`${result.proxy} recusada: saida em ${result.country}`);
                if (--pending === 0 && !settled) resolve(null);
            });
        }
    });
}

async function torExit(excluded: Set<string>, timeoutMs: number) {
    for (const port of TOR_PORTS) {
        const proxy = `socks5://127.0.0.1:${port}`;
        if (!await listening(port, TOR_PORT_TIMEOUT_MS)) continue;

        const found = await firstUsable([proxy], excluded, timeoutMs);
        if (found !== null) {
            log(`Tor local encontrado na porta ${port}`);
            return found;
        }

        log(`porta ${port} aberta mas nao respondeu como proxy, ignorando`);
    }

    return null;
}

function rankFreeProxies(body: string, excluded: Set<string>) {
    const data: unknown = JSON.parse(body);
    const { proxies } = data as { proxies?: unknown; };
    if (!Array.isArray(proxies)) return [];

    const usable: { proxy: string; uptime: number; timeout: number; }[] = [];

    for (const item of proxies) {
        if (typeof item !== "object" || item === null) continue;

        const entry = item as {
            proxy?: unknown;
            alive?: unknown;
            uptime?: unknown;
            timeout?: unknown;
            ip_data?: { countryCode?: unknown; };
        };

        if (typeof entry.proxy !== "string" || entry.alive !== true) continue;

        const parsed = parseProxy(entry.proxy);
        if (parsed === null || INTERCEPTING_PORTS.has(parsed.port)) continue;

        const uptime = typeof entry.uptime === "number" ? entry.uptime : 0;
        const timeout = typeof entry.timeout === "number" ? entry.timeout : MAX_LISTED_TIMEOUT;
        if (uptime < MIN_UPTIME || timeout > MAX_LISTED_TIMEOUT) continue;

        const country = typeof entry.ip_data?.countryCode === "string" ? entry.ip_data.countryCode.toUpperCase() : "";
        if (excluded.has(country)) continue;

        usable.push({ proxy: entry.proxy, uptime, timeout });
    }

    return usable
        .sort((a, b) => b.uptime - a.uptime || a.timeout - b.timeout)
        .slice(0, MAX_CANDIDATES)
        .map(entry => entry.proxy);
}

async function freeExit(excluded: Set<string>, want: number) {
    let candidates: string[];
    try {
        candidates = rankFreeProxies(await downloadText(FREE_PROXY_API), excluded);
    } catch {
        return [];
    }

    log(`${candidates.length} candidatas depois do ranqueamento`);

    const found: PoolEntry[] = [];

    for (let i = 0; i < candidates.length && found.length < want; i += PARALLEL_PROBES) {
        const batch = candidates.slice(i, i + PARALLEL_PROBES);
        const winner = await firstUsable(batch, excluded, PROBE_TIMEOUT_MS);
        if (winner !== null) found.push(winner);
    }

    return found;
}

// Reabastecer o pote e uma escolha nova podem correr ao mesmo tempo; duas buscas paralelas
// dobram o tempo ate a saida ficar pronta. Quem chegar depois espera a que ja esta correndo.
let hunting: Promise<PoolEntry[]> | null = null;

function sharedFreeExit(excluded: Set<string>, want: number) {
    hunting ??= freeExit(excluded, want).finally(() => { hunting = null; });
    return hunting;
}

let exit: string | null = null;
let exitSettled = false;
let waiting: ((value: string | null) => void)[] = [];

function settleExit(value: string | null) {
    exit = value;
    exitSettled = true;

    const pending = waiting;
    waiting = [];
    for (const resume of pending) resume(value);
}

// O gateway chega aqui antes de existir saida escolhida. Segurando so este socket (nao a
// sessao inteira), o Discord carrega normal enquanto a busca acontece.
function currentExit(): Promise<string | null> {
    if (exitSettled) return Promise.resolve(exit);

    return new Promise(resolve => {
        const resume = (value: string | null) => {
            clearTimeout(guard);
            resolve(value);
        };

        const guard = setTimeout(() => {
            waiting = waiting.filter(entry => entry !== resume);
            log("nenhuma saida ficou pronta a tempo, esta conexao vai direta");
            resolve(null);
        }, STALL_BUDGET_MS);

        waiting.push(resume);
    });
}

// Saida que falhou no trafego vivo sai do pote e a busca recomeca. Ate a nova chegar o
// roteador manda direto, que custa o Go Live e nunca a conexao.
function dropExit(dead: string, excluded?: Set<string>) {
    if (exit !== dead) return;

    log(`${dead} parou de entregar, tirando do pote e procurando outra`);
    writePool(readPool().filter(entry => entry.proxy !== dead));
    exit = null;
    chooseExit(excluded);
}

// Guarda a promessa, nao um booleano: retryWithProxy precisa esperar o resultado antes de
// recarregar, senao veria "ja tem alguem escolhendo" e recarregaria sem saida nenhuma.
let choosing: Promise<void> | null = null;

function chooseExit(excluded?: Set<string>) {
    choosing ??= runChoice(excluded ?? excludedCountries()).finally(() => { choosing = null; });
    return choosing;
}

// Nada aqui pode escapar: no processo principal do Discord, uma promessa rejeitada sem
// tratamento derruba o processo inteiro.
async function runChoice(excluded: Set<string>) {
    try {
        await pickExit(excluded);
    } catch {
        // Quem ja escolheu nao perde a saida por um erro vindo depois.
        if (!exitSettled) settleExit(null);
    }
}

async function pickExit(excluded: Set<string>) {
    const manual = manualProxy();
    if (manual === "invalid") {
        log("o endereco do campo Proxy nao e valido, nenhuma saida foi usada");
        return settleExit(null);
    }

    if (manual !== "auto") {
        // Sem testar, uma saida fora do ar viraria conexao direta dentro do roteador e o
        // bypass falharia em silencio, que foi exatamente o que aconteceu com o Tor fechado.
        const started = Date.now();
        if (await measure(manual.proxy, WARM_PROBE_TIMEOUT_MS) !== null) {
            log(`seu proxy respondeu em ${Date.now() - started}ms: ${manual.proxy}`);
            return settleExit(manual.proxy);
        }

        log(`seu proxy nao respondeu: ${manual.proxy}`);
        log("se for Tor, ele precisa estar aberto ANTES do Discord. Procurando alternativa.");
    }

    return autoExit(excluded);
}

async function autoExit(excluded: Set<string>) {
    const pool = readPool();
    if (pool.length > 0) {
        const warm = await firstUsable(pool.map(entry => entry.proxy), excluded, WARM_PROBE_TIMEOUT_MS);
        if (warm !== null) {
            log(`saida guardada revalidada em ${warm.ms}ms: ${warm.proxy}`);
            settleExit(warm.proxy);

            // Solta sem esperar: o pote so serve pro proximo boot, prender a escolha ate
            // encher deixaria uma saida morta sem substituta na sessao atual.
            refillPool(excluded, warm).catch(() => { });
            return;
        }

        log("as saidas guardadas morreram, procurando outra");
    }

    const tor = await torExit(excluded, PROBE_TIMEOUT_MS);
    if (tor !== null) return settleExit(tor.proxy);

    log(`procurando uma saida nova, o gateway fica segurado por ate ${Math.round(STALL_BUDGET_MS / 1000)}s`);
    const [first] = await sharedFreeExit(excluded, 1);
    log(first === undefined ? "nenhuma saida passou nos testes" : `saida escolhida: ${first.proxy}`);

    settleExit(first?.proxy ?? null);
    if (first !== undefined) writePool([first]);
}

// Busca cara acontece com a sessao ja aberta, pro proximo boot ter opcao pronta -- diferenca
// entre abrir em dois segundos e esperar meio minuto por uma lista.
async function refillPool(excluded: Set<string>, keep: PoolEntry) {
    try {
        const found = await sharedFreeExit(excluded, POOL_SIZE);
        writePool([keep, ...found.filter(entry => entry.proxy !== keep.proxy)]);
        log(`pote guardado com ${Math.min(found.length + 1, POOL_SIZE)} saida(s)`);
    } catch {
        writePool([keep]);
    }
}

let socks: SocksServer | undefined;
let scope: Scope = "off";
let fallbackRule = "DIRECT";

function refuse(client: Socket) {
    if (!client.destroyed) client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
    client.destroy();
}

function readTarget(request: Buffer) {
    if (request[3] === 1) {
        return { host: Array.from(request.subarray(4, 8)).join("."), port: request.readUInt16BE(8) };
    }

    if (request[3] === 3) {
        const size = request[4];
        return { host: request.subarray(5, 5 + size).toString("latin1"), port: request.readUInt16BE(5 + size) };
    }

    return null;
}

function serveSocks(client: Socket) {
    client.on("error", () => client.destroy());

    readFrame(client, buffer => buffer.length < 2 ? -1 : 2 + buffer[1], greeting => {
        if (greeting === null || greeting[0] !== 5) return client.destroy();
        client.write(Buffer.from([5, 0]));

        readFrame(client, socksReplySize, request => {
            // Cada conexao e isolada: o que der errado aqui fecha este socket e mais nada.
            // Sem o catch, um erro em qualquer await abaixo viraria rejeicao nao tratada e
            // levaria junto o processo principal do Discord.
            serveRequest(client, request).catch(() => client.destroy());
        });
    });
}

async function serveRequest(client: Socket, request: Buffer | null) {
    if (request === null || request[0] !== 5 || request[1] !== 1) return client.destroy();

    const target = readTarget(request);
    if (target === null) return refuse(client);
    target.host = target.host.toLowerCase().replace(/\.$/, "");

    const isMediaHost = MEDIA_CONTROL_EXPERIMENT && MEDIA_HOST_PATTERN.test(target.host);
    const debugKind = MEDIA_CONTROL_EXPERIMENT
        ? (isMediaHost ? "media" : GATEWAY_HOST_PATTERN.test(target.host) ? "gateway" : null)
        : null;
    const debugId = debugKind === null ? 0 : ++debugConnectionId;
    if (debugKind !== null) log(`${MEDIA_DEBUG} conexao#${debugId} ${debugKind} solicitada porta=${target.port}`);

    // Sucesso respondido antes de saber a saida, de proposito: o Chromium para de usar um
    // roteador que responda lento/negativo, sem avisar. Uma saida que falhe vira conexao
    // fechada (problema do destino, nao do proxy) -- o socket segue pausado pelo readFrame.
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));

    const through = await currentExit();
    if (client.destroyed) return;
    let actualRoute = through;
    if (debugKind !== null) log(`${MEDIA_DEBUG} conexao#${debugId} tentativa ${debugExit(through)}`);

    // Login (autenticacao) falha fechado -- diferente do gateway, onde cair pra direto e
    // proposital. Vazar o IP real no login seria o oposto do que a setting promete.
    const isLoginHost = LOGIN_HOSTS.includes(target.host);

    let upstream = through === null
        ? (isLoginHost ? null : await openDirect(target.host, target.port, RELAY_DIRECT_TIMEOUT_MS))
        : await openTunnel(through, target.host, target.port, RELAY_TUNNEL_TIMEOUT_MS);

    // Descartada na hora, senao toda conexao seguinte paga o mesmo tempo de espera.
    if (upstream === null && through !== null) {
        // Uma recusa do destino/porta de midia nao prova que o gateway perdeu sua saida.
        if (!isMediaHost) dropExit(through);
        actualRoute = null;
        upstream = isLoginHost ? null : await openDirect(target.host, target.port, RELAY_DIRECT_TIMEOUT_MS);
    }

    if (debugKind !== null && actualRoute === null)
        log(`${MEDIA_DEBUG} conexao#${debugId} inconclusivo: fallback DIRECT`);

    if (upstream === null) {
        if (debugKind !== null) log(`${MEDIA_DEBUG} conexao#${debugId} falhou: nenhum transporte estabelecido`);
        return client.destroy();
    }

    if (client.destroyed) {
        upstream.destroy();
        return;
    }

    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());

    if (debugKind !== null) {
        const state = { kind: debugKind, route: debugExit(actualRoute), tx: 0, rx: 0 };
        debugConnections.set(debugId, state);
        log(`${debugConnectionLine(debugId, state)} TCP estabelecido; nao comprova WebSocket autenticado`);
        client.on("data", (chunk: Buffer) => { state.tx += chunk.length; });
        upstream.on("data", (chunk: Buffer) => { state.rx += chunk.length; });
        client.once("close", () => {
            log(`${debugConnectionLine(debugId, state)} encerrada`);
            debugConnections.delete(debugId);
        });
    }

    upstream.pipe(client);
    client.pipe(upstream);
}

function pacScript(socksPort: number, loginHosts: string[]) {
    const list = loginHosts.map(host => `"${host}"`).join(",");
    if (scope === "off") return `function FindProxyForURL(url, host) { return ${JSON.stringify(fallbackRule)}; }`;

    // O host roteado sai pelo roteador, sem alternativa: uma vez que o Chromium marca o SOCKS
    // como ruim ele passa a usar a alternativa do PAC sem avisar. A rede de seguranca real e
    // o proprio roteador caindo pra conexao direta, nao uma regra que o Chromium decide sozinho.
    // Quem nao esta na lista mantem a regra que o sistema ja usava (proxy corporativo/PAC).
    return `var gatewayPattern = /${GATEWAY_HOST_PATTERN_SOURCE}/;\n`
        + `var mediaPattern = /${MEDIA_HOST_PATTERN_SOURCE}/;\n`
        + `var loginHosts = [${list}];\n`
        + "function FindProxyForURL(url, host) {\n"
        + "    host = host.toLowerCase().replace(/\\.$/, '');\n"
        + `    if (gatewayPattern.test(host)) return "SOCKS5 127.0.0.1:${socksPort}";\n`
        + (MEDIA_CONTROL_EXPERIMENT ? `    if (mediaPattern.test(host)) return "SOCKS5 127.0.0.1:${socksPort}";\n` : "")
        + "    for (var i = 0; i < loginHosts.length; i++)\n"
        + `        if (host === loginHosts[i]) return "SOCKS5 127.0.0.1:${socksPort}";\n`
        + `    return "${fallbackRule}";\n`
        + "}\n";
}

// So para log/diagnostico -- o roteamento de verdade acontece pelo padrao dentro do pacScript.
function routedHosts(): string[] {
    if (scope === "off") return [];
    const hosts = ["gateway*.discord.gg", ...(MEDIA_CONTROL_EXPERIMENT ? ["*.discord.media (TCP experimental)"] : [])];
    return scope === "login" ? [...hosts, ...LOGIN_HOSTS] : hosts;
}

// PAC embutido na propria URL, nao servido de um HTTP local: buscar o arquivo com a rede
// ainda montando ja derrubou o processo principal em silencio numa build de Electron antiga.
function pacDataUrl(socksPort: number) {
    const script = pacScript(socksPort, scope === "login" ? LOGIN_HOSTS : []);
    return "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(script, "utf8").toString("base64");
}

async function installPac(redial: boolean) {
    if (socks === undefined) return false;

    try {
        const socksPort = (socks.address() as AddressInfo | null)?.port;
        if (socksPort === undefined) return false;

        await session.defaultSession.setProxy({ mode: "pac_script", pacScript: pacDataUrl(socksPort) });

        // Confere o endereco inteiro, nao so a porta: a regra do sistema (quando o PAC e
        // ignorado) pode conter os mesmos digitos da porta por coincidencia.
        const route = await session.defaultSession.resolveProxy(`https://${GATEWAY_HOSTS[0]}`);
        if (typeof route !== "string" || !route.includes(`127.0.0.1:${socksPort}`)) {
            log("o Chromium ignorou o PAC, voltando para a regra do sistema");

            // "system", nao "direct": arrancaria o proxy de quem esta atras de VPN/corporativo.
            await session.defaultSession.setProxy({ mode: "system" });

            // Escopo tem que refletir que nada ficou roteado, senao retryWithProxy recarrega
            // atras de uma rota que nao existe e queima a tentativa a toa.
            scope = "off";
            return false;
        }

        if (MEDIA_CONTROL_EXPERIMENT) {
            // resolveProxy avalia o PAC; nao precisa resolver DNS/conectar este host sentinela.
            try {
                const mediaRoute = await session.defaultSession.resolveProxy("wss://streamfix-probe.discord.media:443");
                const routed = mediaRoute === `SOCKS5 127.0.0.1:${socksPort}`;
                log(`${MEDIA_DEBUG} build experimental ativa; UDP inalterado; PAC media=${routed ? "roteador local" : "nao confirmado, inconclusivo"}`);
            } catch {
                // Instrumentacao nao pode derrubar o roteamento funcional do gateway.
                log(`${MEDIA_DEBUG} PAC media nao pode ser conferido; inconclusivo`);
            }
        }

        // Regra nova nao muda socket que ja nasceu -- so no boot; derrubar apos o login
        // reconectaria a sessao recem autenticada a toa.
        if (redial) await session.defaultSession.closeAllConnections();
    } catch {
        // O setProxy pode ter pegado mesmo com uma etapa seguinte lancando excecao -- reverter
        // aqui tambem, senao o PAC fica roteando trafego enquanto a funcao devolve falha.
        log("nao consegui aplicar a regra de rota, revertendo para a regra do sistema");
        try { await session.defaultSession.setProxy({ mode: "system" }); } catch { }
        scope = "off";
        return false;
    }

    log(`rota aplicada: ${routedHosts().join(", ")} pelo roteador local, o resto em ${fallbackRule}`);
    return true;
}

async function startRouter(next: Scope) {
    scope = next;

    if (socks === undefined) {
        const server = createSocksServer(serveSocks);
        server.on("error", () => { });

        // Resolve tambem no erro: esperar um listen que nunca acontece penduraria o boot.
        const started = await new Promise<boolean>(resolve => {
            server.once("error", () => resolve(false));
            server.listen(0, "127.0.0.1", () => resolve(true));
        });

        if (!started) {
            log("nao consegui subir o roteador local, a sessao inteira continua direta");
            return false;
        }

        socks = server;
        log(`roteador local de pe na porta ${(server.address() as AddressInfo).port}`);
    }

    if (await installPac(true)) return true;

    // Mesmo motivo do installPac: no boot nao havia rota pra sobreviver a uma falha.
    scope = "off";
    return false;
}

async function stopRouter() {
    scope = "off";

    try {
        // "system", nao "direct": arrancaria o proxy de quem esta atras de VPN/corporativo.
        await session.defaultSession.setProxy({ mode: "system" });
        await session.defaultSession.closeAllConnections();
    } catch {
        // sessao ja fechando, nada a fazer
    }

    socks?.close();
    socks = undefined;
    log("roteador desligado, tudo volta a sair direto");
}

// Extraida do app.whenReady original pra ser chamavel de novo: sem isso, um plugin ativado
// depois do boot (nao atado ao evento de abertura do app) nunca disparava o roteador.
export async function enable(_?: IpcMainInvokeEvent) {
    migrateLegacySettings();
    if (scope !== "off") return { success: true as const };

    try {
        // So da pra embutir UMA regra fixa no PAC pro resto do trafego, mas um PAC/auto-detect
        // de verdade pode variar por host (proxy corporativo, DLP). Compara 3 alvos bem
        // diferentes: se baterem, a regra do sistema provavelmente e fixa e seguro reaplicar.
        // Falha fechado se o resolveProxy nao responder nada confiavel -- melhor nao ligar o
        // bypass do que arriscar ignorar a politica de proxy da empresa.
        const probeUrls = [`https://${DISCORD_HOST}`, "https://cdn.discordapp.com", "https://www.google.com"];
        let rules: (string | null)[];
        try {
            rules = await Promise.all(probeUrls.map(url => session.defaultSession.resolveProxy(url)));
        } catch {
            log("nao consegui ler a regra de proxy do sistema; nao vou arriscar ligar o roteador as cegas");
            return { success: false as const };
        }

        const discordRule = rules[0];
        if (typeof discordRule !== "string" || discordRule.trim() === "") {
            log("o sistema nao devolveu uma regra de proxy usavel; nao vou arriscar ligar o roteador as cegas");
            return { success: false as const };
        }

        const trimmed = discordRule.trim();
        const varies = rules.slice(1).some(rule => typeof rule === "string" && rule.trim() !== "" && rule.trim() !== trimmed);
        if (varies) {
            log("a regra do sistema varia por host (proxy corporativo ou PAC de verdade); nao vou arriscar substituir por uma regra fixa");
            return { success: false as const };
        }

        fallbackRule = trimmed;

        // Roteador sobe em milissegundos, antes do gateway nascer; a saida e escolhida depois.
        const started = await startRouter(routesLogin() ? "login" : "gateway");
        if (!started) return { success: false as const };

        chooseExit();
        return { success: true as const };
    } catch {
        // Falhar aqui e abrir o Discord sem bypass. Deixar a excecao subir no boot era abrir
        // o Discord sem processo principal, ou seja, nao abrir.
        await stopRouter();
        return { success: false as const };
    }
}

// As protecoes da versao que aplicava proxy na sessao inteira (prazo de 2min, marca de boot
// pendente, did-fail-load) saem daqui: so o gateway depende da saida agora, o resto cai pra
// direto sozinho dentro do roteador. Manter aquele prazo hoje arrancaria uma sessao funcionando.
app.whenReady().then(async () => {
    if (pluginEnabled()) await enable();
}).catch(() => { });

export async function sessionOpened(_: IpcMainInvokeEvent) {
    // Escopo encolhe pro gateway apos o login; ele continua roteado de proposito, entao uma
    // reconexao (rede oscilando) nasce pela mesma saida e a liberacao sobrevive.
    if (scope === "login") await installPacWithScope("gateway");
    return { exit, scope, mediaControlExperiment: MEDIA_CONTROL_EXPERIMENT && scope !== "off" };
}

export async function sessionClosed(_: IpcMainInvokeEvent) {
    if (routesLogin() && scope !== "off") await installPacWithScope("login");
}

// Escopo descreve o que esta instalado, nao o que foi pedido -- se a troca falhar, a rota
// antiga continua valendo, e diagnostico/retryWithProxy precisam enxergar isso.
async function installPacWithScope(next: Scope) {
    const installed = scope;
    scope = next;

    if (await installPac(false)) return true;

    if (scope === next) scope = installed;
    return false;
}

export async function shutdown(_: IpcMainInvokeEvent) {
    await stopRouter();
    settleExit(null);
    return { success: true as const };
}

export function getActiveProxy(_: IpcMainInvokeEvent) {
    return exit;
}

export function getLog(_: IpcMainInvokeEvent) {
    const active = Array.from(debugConnections, ([id, state]) => `${debugConnectionLine(id, state)} ativa`);
    return [...history, ...active].join("\n");
}

function clearRetryWindowTimer() {
    if (retryWindowTimer !== null) clearTimeout(retryWindowTimer);
    retryWindowTimer = null;
}

export function sessionWorked(_: IpcMainInvokeEvent) {
    if (retries > 0) log(`sessao liberada depois de ${retries} tentativa(s)`);
    retries = 0;
    retryWindowStart = 0;
    clearRetryWindowTimer();
}

// Script que roda dentro do renderer via executeJavaScript, no mesmo mundo global que o
// DevTools usa (Vencord.* exposto em window). Fechar o socket bruto do gateway simula uma
// queda de rede: dispara o "onclose" que o proprio Discord ja usa pra reconectar sozinho
// (GatewayConnectionStore -> _handleClose -> _connect), sem reload de pagina. A call de voz
// nao e afetada porque roda num RTCControlSocket separado. nextReconnectIsImmediate pula o
// backoff exponencial que o Discord aplicaria numa queda de verdade.
const SILENT_RECONNECT_SCRIPT = `(function () {
    try {
        var store = Vencord.Webpack.findStore("GatewayConnectionStore");
        var sock = store && store.getSocket && store.getSocket();
        if (!sock || !sock.webSocket || typeof sock.webSocket.close !== "function") return false;

        sock.nextReconnectIsImmediate = true;
        sock.webSocket.close();
        return true;
    } catch (error) {
        return false;
    }
})()`;

// Undocumented internal (GatewayConnectionStore.getSocket().webSocket): se o Discord renomear
// isso numa atualizacao, o script devolve false ou executeJavaScript rejeita, e cai no reload
// de sempre -- a recuperacao nunca trava, so perde a discricao.
async function reconnectSession(event: IpcMainInvokeEvent): Promise<boolean> {
    let silent = false;
    try {
        silent = await event.sender.executeJavaScript(SILENT_RECONNECT_SCRIPT);
    } catch {
        // executeJavaScript falhou (janela fechando, CSP, etc.) -- cai no reload abaixo
    }

    if (!silent) event.sender.reload();
    return silent;
}

// O gateway pode nascer antes de existir saida escolhida; reconectar com a saida ja pronta
// resolve. O orcamento se renova por janela de tempo (RETRY_WINDOW_MS), nao e vitalicio: uma
// sessao longa com internet instavel continua sendo curada sozinha depois das primeiras quedas.
export async function retryWithProxy(event: IpcMainInvokeEvent, excludedCountries: unknown) {
    const now = Date.now();
    if (now - retryWindowStart >= RETRY_WINDOW_MS) {
        retries = 0;
        retryWindowStart = now;
        clearRetryWindowTimer();
    }

    if (retries >= MAX_RETRIES_PER_WINDOW) {
        if (retryWindowTimer === null) {
            const retryDelayMs = Math.max(0, retryWindowStart + RETRY_WINDOW_MS - now);
            retryWindowTimer = setTimeout(() => {
                retryWindowTimer = null;
                if (event.sender.isDestroyed()) return;

                // A sessao continua bloqueada, mas CONNECTION_OPEN nao volta a disparar enquanto o
                // gateway fica conectado. Reentra no mesmo caminho para renovar o orcamento e
                // forcar a proxima reconexao sem depender de reinicio manual.
                void retryWithProxy(event, excludedCountries).catch(error => {
                    log(`falhou ao retomar a tentativa automatica: ${error instanceof Error ? error.message : String(error)}`);
                });
            }, retryDelayMs);
            log(`o servidor continuou bloqueando apos ${retries} tentativas nos ultimos ${Math.round(RETRY_WINDOW_MS / 60_000)} min; a proxima tentativa sera feita automaticamente quando a janela renovar`);
        }
        return { retried: false as const, reason: "tentativas esgotadas" };
    }

    // Reserva a vaga antes de qualquer await: reconexoes em rajada disparam chamadas
    // concorrentes que veriam o mesmo "retries" no intervalo entre awaits, furando o teto.
    // Devolve a vaga se a tentativa nao for adiante -- nao e falha do servidor.
    retries++;
    const attempt = retries;

    if (scope === "off") {
        retries--;
        log("o roteador nao esta de pe, recarregar repetiria a mesma falha");
        return { retried: false as const, reason: "roteador desligado" };
    }

    // Vem do renderer, nao do processo principal: e a copia que a pessoa esta vendo agora.
    const requested = requestedCountries(excludedCountries);
    const excluded = requested.size > 0 ? requested : undefined;

    // Se a saida no ar ainda responde, foi corrida: o gateway nasceu antes dela e saiu direto.
    // Recarregar conserta sem reinstalar a rota.
    let through = exit;
    if (through !== null && await measure(through, PROBE_TIMEOUT_MS) === null) {
        log(`${through} parou de responder no meio da sessao`);
        dropExit(through, excluded);

        // Le de volta em vez de assumir null: o trafego vivo pode ja ter achado outra saida.
        through = exit;
    }

    // Sem saida no ar nao ha corrida a ganhar com o gateway -- vale esperar a busca inteira.
    if (through === null) {
        await chooseExit(excluded);
        through = exit;
    }

    if (through === null) {
        retries--;
        log("nenhuma saida respondeu, a sessao continua direta");
        return { retried: false as const, reason: "nenhuma saida respondeu" };
    }

    if (event.sender.isDestroyed()) {
        retries--;
        return { retried: false as const, reason: "janela indisponivel" };
    }

    log(`o servidor bloqueou esta sessao, tentativa ${attempt} atras de ${through}`);

    // event.sender e a janela do plugin -- a primeira janela criada e a tela de abertura, e
    // recarregar (ou reconectar) ela nao afeta o cliente.
    const silent = await reconnectSession(event);
    log(silent ? "gateway reconectado sem reload" : "reconexao silenciosa indisponivel, recarregando a janela");

    return { retried: true as const, attempt };
}

export async function testProxy(_: IpcMainInvokeEvent, proxyRules: unknown) {
    if (typeof proxyRules !== "string" || parseProxy(proxyRules.trim()) === null)
        return { success: false as const, error: "Invalid proxy format. Use socks5://host:port." };

    const result = await measure(proxyRules.trim());
    if (result === null)
        return { success: false as const, error: "The proxy could not carry a real TLS request." };

    return { success: true as const, ms: result.ms, country: result.country, ip: result.ip };
}
