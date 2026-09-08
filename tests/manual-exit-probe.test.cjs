// Cobre a validacao da saida manual: leitura do pais no trace da Cloudflare e a segunda
// tentativa. O Tor passava nos dois testes de conectividade e era descartado na leitura do
// pais, porque a Cloudflare responde `loc=T1` no lugar de um codigo ISO.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const { resolve } = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const TOR = "socks5://127.0.0.1:9050";

// `trace` responde ao probe da Cloudflare e `gateway` ao de gateway.discord.gg. Ambos recebem
// o prazo da chamada, para que um teste possa falhar so quando o prazo for curto.
function harness({ proxy = TOR, trace = () => "HTTP/1.1 200 OK\n\nip=1.2.3.4\nloc=US\n", gateway = () => "HTTP/1.1 404 Not Found\n\n", tunnel = () => true } = {}) {
    class Socket extends EventEmitter {
        destroyed = false;
        write() { return true; }
        pipe() { return this; }
        destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
    }
    const upstream = new Socket();
    const settings = { store: { plugins: {} }, plain: { plugins: { StreamFix: { enabled: true, proxy, excludedCountries: "BR" } } } };
    const source = stripTypeScriptTypes(readFileSync(resolve(__dirname, "../streamFix/native.ts"), "utf8"))
        .replace(/^import .*;\r?$/gm, "").replace(/^export /gm, "");

    const probes = [];
    const api = runInNewContext(source + `
        openTunnel = async (proxy, host, port, timeoutMs) => (tunnel(host, timeoutMs) ? upstream : null);
        readOverTls = async (socket, host, path, timeoutMs) => {
            probes.push({ host, timeoutMs });
            return host === "cloudflare.com" ? trace(timeoutMs) : gateway(timeoutMs);
        };
        settleExit = value => { settled.push(value); return value; };
        autoExit = async () => { settled.push("AUTO"); return "AUTO"; };
        ({ measure, pickExit, getLog });
    `, {
        Buffer, setTimeout, clearTimeout, NativeSettings: settings, RendererSettings: settings,
        app: { whenReady: () => new Promise(() => {}) },
        session: { defaultSession: { setProxy: async () => {}, closeAllConnections: async () => {}, resolveProxy: async () => "DIRECT" } },
        upstream, trace, gateway, tunnel, probes, settled: [],
    });

    return { api, probes };
}

test("loc=T1 da Cloudflare (saida Tor) e aceito como localizacao valida", async () => {
    const { api } = harness({ trace: () => "HTTP/1.1 200 OK\n\nip=109.70.100.7\nloc=T1\n" });
    const result = await api.measure(TOR, 6000);

    assert.notEqual(result, null, "o Tor alcancou o trace e o gateway; nao pode ser descartado");
    assert.equal(result.country, "T1");
});

test("codigo de pais ISO comum continua sendo aceito", async () => {
    const { api } = harness({ trace: () => "HTTP/1.1 200 OK\n\nip=1.2.3.4\nloc=de\n" });
    const result = await api.measure("socks5://exemplo:1080", 6000);

    assert.equal(result.country, "DE", "o codigo e normalizado em maiusculas");
});

test("trace sem loc continua sendo recusado", async () => {
    const { api } = harness({ trace: () => "HTTP/1.1 200 OK\n\nip=1.2.3.4\n" });
    assert.equal(await api.measure(TOR, 6000), null);
});

test("trace que nao responde 200 e recusado antes de olhar o pais", async () => {
    const { api } = harness({ trace: () => "HTTP/1.1 403 Forbidden\n\nloc=US\n" });
    assert.equal(await api.measure(TOR, 6000), null);
});

test("saida que alcanca o trace mas nao o gateway e recusada", async () => {
    const { api } = harness({ gateway: () => "" });
    assert.equal(await api.measure(TOR, 6000), null, "uma rede que bloqueia so o Discord nao pode passar");
});

test("a saida manual ganha uma segunda tentativa com prazo maior", async () => {
    // Responde so quando o prazo passa de 2500ms, imitando o circuito frio do Tor.
    const lento = timeoutMs => (timeoutMs > 2500 ? "HTTP/1.1 200 OK\n\nip=109.70.100.7\nloc=T1\n" : null);
    const { api, probes } = harness({ trace: lento });

    assert.equal(await api.measure(TOR, 2500), null, "a primeira tentativa curta falha");

    const segunda = await api.measure(TOR, 6000);
    assert.notEqual(segunda, null, "a segunda tentativa, mais longa, recupera a saida");
    assert.ok(probes.some(p => p.timeoutMs > 2500), "a segunda tentativa usa prazo maior que o curto");
});
