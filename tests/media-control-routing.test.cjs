// Local experiment tests; these do NOT reproduce Discord's remote video failure.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const { resolve } = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function harness({ tunnel = true, selected = "socks5://private-proxy.example:1080", experiment = true, mediaProbeFails = false } = {}) {
    const calls = [];
    class Socket extends EventEmitter {
        destroyed = false;
        write() { return true; }
        pipe() { return this; }
        destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
    }
    const upstream = new Socket();
    const settings = { store: { plugins: {} }, plain: { plugins: {} } };
    // Run the real native module with only its external boundaries stubbed out.
    const source = stripTypeScriptTypes(readFileSync(resolve(__dirname, "../streamFix/native.ts"), "utf8")
        // Casa os dois valores: o experimento fica desligado na main, e cada teste escolhe o
        // estado que quer exercitar em vez de depender do padrao do arquivo.
        .replace(/const MEDIA_CONTROL_EXPERIMENT = (?:true|false);/, `const MEDIA_CONTROL_EXPERIMENT = ${experiment};`))
        .replace(/^import .*;\r?$/gm, "").replace(/^export /gm, "");
    const api = runInNewContext(source + `
        currentExit = async () => selected;
        openTunnel = async (...args) => { calls.push(["tunnel", ...args]); return tunnel ? upstream : null; };
        openDirect = async (...args) => { calls.push(["direct", ...args]); return upstream; };
        dropExit = () => calls.push(["drop"]);
        socks = { address: () => ({ port: 61778 }) };
        ({ pacScript, serveRequest, getLog, installPac, getScope: () => scope, setScope: value => scope = value,
           setFallback: value => fallbackRule = value, routedHosts });
    `, { Buffer, setTimeout, clearTimeout, NativeSettings: settings, RendererSettings: settings,
        app: { whenReady: () => new Promise(() => {}) },
        session: { defaultSession: {
            setProxy: async () => {}, closeAllConnections: async () => {},
            resolveProxy: async url => {
                if (mediaProbeFails && url.includes("discord.media")) throw new Error("probe failed");
                return "SOCKS5 127.0.0.1:61778";
            }
        } }, selected, tunnel, upstream, calls });
    api.setScope("gateway");
    return { api, calls, upstream, client: new Socket() };
}

function route(api, host, login = []) {
    return runInNewContext(api.pacScript(61778, login) + "\nFindProxyForURL('wss://' + target, target)", { target: host });
}

function requestFor(host, command = 1) {
    const name = Buffer.from(host);
    const port = Buffer.from([1, 187]); // 443
    return Buffer.concat([Buffer.from([5, command, 0, 3, name.length]), name, port]);
}

test("media subdomains use the gateway relay, including normalized host names", () => {
    const { api } = harness();
    for (const host of ["c-iad21-test.discord.media", "nested.host.discord.media", "C-IAD21-TEST.DISCORD.MEDIA."])
        assert.equal(route(api, host), "SOCKS5 127.0.0.1:61778");
});

test("unrelated hosts retain the system rule; gateway and login retain routing", () => {
    const { api } = harness();
    api.setFallback("PROXY corporate.example:8080");
    for (const host of ["discord.media.example.com", "notdiscord.media", "discord.media", "cdn.discordapp.com", "discord.com"])
        assert.equal(route(api, host), "PROXY corporate.example:8080");
    for (const host of ["gateway.discord.gg", "remote-auth-gateway.discord.gg", "gateway-us-east1-c.discord.gg"])
        assert.equal(route(api, host), "SOCKS5 127.0.0.1:61778");
    assert.equal(route(api, "discord.com", ["discord.com"]), "SOCKS5 127.0.0.1:61778");
});

test("disabled scope does not route media or gateway", () => {
    const { api } = harness();
    api.setScope("off");
    assert.equal(route(api, "c-test.discord.media"), "DIRECT");
    assert.equal(route(api, "gateway.discord.gg"), "DIRECT");
    assert.equal(api.routedHosts().length, 0);
});

test("media uses selected proxy and reports bytes without private endpoints or payloads", async () => {
    const { api, client, calls, upstream } = harness();
    await api.serveRequest(client, requestFor("c-test.discord.media"));
    assert.equal(calls[0][0], "tunnel");
    assert.equal(calls[0][1], "socks5://private-proxy.example:1080");
    client.emit("data", Buffer.from("secret-client-payload"));
    upstream.emit("data", Buffer.from("secret-server-payload"));
    assert.match(api.getLog(), /tx=21 rx=21/);
    client.destroy();
    assert.match(api.getLog(), /encerrada/);
    assert.doesNotMatch(api.getLog(), /private-proxy|secret-|c-test/);
});

test("media refusal falls back explicitly without discarding the gateway exit", async () => {
    const { api, client, calls } = harness({ tunnel: false });
    await api.serveRequest(client, requestFor("c-test.discord.media"));
    assert.deepEqual(calls.map(call => call[0]), ["tunnel", "direct"]);
    assert.match(api.getLog(), /inconclusivo.*DIRECT/);
    client.destroy();
});

test("missing exit is explicitly inconclusive", async () => {
    const { api, client, calls } = harness({ selected: null });
    await api.serveRequest(client, requestFor("c-test.discord.media"));
    assert.equal(calls[0][0], "direct");
    assert.match(api.getLog(), /inconclusivo.*DIRECT/);
    client.destroy();
});

test("gateway still drops failed exits and login still fails closed", async () => {
    for (const [host, expected] of [["gateway.discord.gg", ["tunnel", "drop", "direct"]], ["discord.com", ["tunnel", "drop"]]]) {
        const { api, client, calls } = harness({ tunnel: false });
        await api.serveRequest(client, requestFor(host));
        assert.deepEqual(calls.map(call => call[0]), expected);
        client.destroy();
    }
});

test("SOCKS UDP commands are rejected without opening a connection", async () => {
    const { api, client, calls } = harness();
    await api.serveRequest(client, requestFor("c-test.discord.media", 3));
    assert.equal(client.destroyed, true);
    assert.equal(calls.length, 0);
});

test("compile-time rollback leaves media direct and removes experimental logs", async () => {
    const { api, client } = harness({ experiment: false });
    assert.equal(route(api, "c-test.discord.media"), "DIRECT");
    assert.equal(route(api, "gateway.discord.gg"), "SOCKS5 127.0.0.1:61778");
    await api.serveRequest(client, requestFor("gateway.discord.gg"));
    assert.doesNotMatch(api.getLog(), /DEBUG-media-control/);
    client.destroy();
});

test("PAC probe confirms local routing without exposing the destination", async () => {
    const { api } = harness();
    assert.equal(await api.installPac(false), true);
    assert.match(api.getLog(), /PAC media=roteador local/);
});

test("diagnostic probe failure never disables a working gateway route", async () => {
    const { api } = harness({ mediaProbeFails: true });
    assert.equal(await api.installPac(false), true);
    assert.equal(api.getScope(), "gateway");
    assert.match(api.getLog(), /PAC media nao pode ser conferido; inconclusivo/);
});
