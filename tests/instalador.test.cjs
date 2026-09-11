/*
 * O instalador da fase 7.
 *
 * Duas metades. A primeira roda o `provisiona.mjs` de verdade contra uma saida de mentira: sao
 * os caminhos que uma pessoa instalando vai encontrar -- convite errado, saida fora do ar, a
 * saida devolvendo outra chave.
 *
 * A segunda le o PowerShell como texto. Nao ha harness de teste de PowerShell neste repositorio
 * e montar um custaria mais do que vale; o que estas asercoes pegam sao as **derivas
 * silenciosas** -- o instalador continuar copiando uma lista de arquivos que ficou velha, ou
 * escrever configuracoes que o plugin nao le mais. Foi exatamente isso que as fases 1 a 6
 * provocaram e ninguem notou ate agora.
 */

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { existsSync, readdirSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { after, before, describe, test } = require("node:test");

const RAIZ = resolve(__dirname, "..");
const PROVISIONA = join(RAIZ, "installer", "provisiona.mjs");
const INSTALADOR = readFileSync(join(RAIZ, "installer", "StreamFix-Installer.ps1"), "utf8");

// ============================================================================ a saida de mentira

const CONVITE_BOM = "convite-de-teste";
const CHAVE_DA_SAIDA = "aWc4Tm9kZUtleUZha2VGYWtlRmFrZUZha2VGYWtlMTI=";

/** Responde no mesmo formato do servidor real (`{ codigo, erro }`), senao nao testa nada. */
function saidaDeMentira() {
    return createServer((req, res) => {
        let corpo = "";
        req.on("data", p => corpo += p);
        req.on("end", () => {
            const responde = (status, obj) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(obj));
            };
            if (req.url !== "/registrar" || req.method !== "POST") {
                return responde(404, { codigo: "nao_encontrado" });
            }
            let pedido;
            try { pedido = JSON.parse(corpo); } catch {
                return responde(400, { codigo: "corpo_invalido" });
            }
            // O que a saida recebe fica guardado para o teste conferir depois.
            servidorRecebeu.push(pedido);
            if (pedido.convite !== CONVITE_BOM) {
                return responde(403, { codigo: "convite_invalido", erro: "convite invalido" });
            }
            responde(200, {
                endereco: "10.8.0.7/32",
                chavePublicaDoServidor: CHAVE_DA_SAIDA,
                endpoint: "159.112.151.37:39743",
                faixa: "10.8.0.0/24"
            });
        });
    });
}

let servidor = null;
let url = "";
let pasta = "";
const servidorRecebeu = [];

/** Roda o provisionador como o instalador roda: convite por stdin, JSON em stdout. */
function provisionar(convite, extras = []) {
    return new Promise(resolvePromessa => {
        const p = spawn(process.execPath, [PROVISIONA, "--url", url, "--mtu-do-caminho", "1492", ...extras], {
            stdio: ["pipe", "pipe", "pipe"]
        });
        let saida = "";
        let erro = "";
        p.stdout.on("data", d => saida += d);
        p.stderr.on("data", d => erro += d);
        p.stdin.end(convite);
        p.on("close", codigo => {
            const linha = saida.split("\n").find(l => l.trim().startsWith("{"));
            resolvePromessa({ codigo, saida, erro, json: linha ? JSON.parse(linha) : null });
        });
    });
}

describe("provisionamento", () => {
    before(async () => {
        pasta = join(tmpdir(), `sf-teste-${process.pid}`);
        require("node:fs").mkdirSync(pasta, { recursive: true });
        servidor = saidaDeMentira();
        await new Promise(r => servidor.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${servidor.address().port}/registrar`;
    });

    after(() => {
        servidor?.close();
        rmSync(pasta, { recursive: true, force: true });
    });

    test("com um convite bom, escreve o perfil e conta o que fez", async () => {
        const arquivo = join(pasta, "streamfix-bom.conf");
        const r = await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);

        assert.equal(r.codigo, 0, r.saida + r.erro);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.endereco, "10.8.0.7/32");
        assert.equal(r.json.mtuDoTunel, 1412, "1492 de caminho menos os 80 do WireGuard");
        // O nome do perfil sai do nome do ARQUIVO -- e assim que o WireSock decide.
        assert.equal(r.json.perfil, "streamfix-bom");
        assert.ok(existsSync(arquivo));
    });

    test("a chave privada nunca aparece na saida, so dentro do arquivo", async () => {
        // O modo de falha a evitar e a privada vazar para o log do instalador, que as pessoas
        // colam em canal de suporte quando algo da errado.
        const arquivo = join(pasta, "streamfix-sigilo.conf");
        const r = await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);

        const conf = readFileSync(arquivo, "utf8");
        const privada = /^PrivateKey = (.+)$/m.exec(conf)[1].trim();
        assert.match(privada, /^[A-Za-z0-9+/]{43}=$/, "o arquivo tem uma chave de verdade");

        assert.ok(!r.saida.includes(privada), "a privada vazou para stdout");
        assert.ok(!r.erro.includes(privada), "a privada vazou para stderr");
    });

    test("a saida recebe a chave publica, e nunca a privada", async () => {
        servidorRecebeu.length = 0;
        await provisionar(CONVITE_BOM, ["--arquivo", join(pasta, "streamfix-corpo.conf")]);

        assert.equal(servidorRecebeu.length, 1);
        const pedido = servidorRecebeu[0];
        assert.match(pedido.chavePublica, /^[A-Za-z0-9+/]{43}=$/);
        assert.deepEqual(Object.keys(pedido).sort(), ["chavePublica", "convite"]);
    });

    test("convite errado para antes de escrever qualquer coisa", async () => {
        const arquivo = join(pasta, "streamfix-ruim.conf");
        const r = await provisionar("nao-sou-convite", ["--arquivo", arquivo]);

        assert.equal(r.codigo, 1);
        assert.equal(r.json.ok, false);
        assert.match(r.json.erro, /convite nao existe/);
        assert.ok(!existsSync(arquivo), "falha nao pode deixar perfil pela metade");
    });

    test("convite vazio e um erro com nome, nao um registro que falha la na frente", async () => {
        const r = await provisionar("   ", ["--arquivo", join(pasta, "streamfix-vazio.conf")]);
        assert.equal(r.json.ok, false);
        assert.match(r.json.erro, /convite vazio/);
    });

    test("saida fora do ar da um motivo que aponta a rede", async () => {
        const arquivo = join(pasta, "streamfix-semrede.conf");
        const p = await new Promise(r => {
            const s = spawn(process.execPath, [
                PROVISIONA, "--url", "http://127.0.0.1:1/registrar",
                "--mtu-do-caminho", "1492", "--arquivo", arquivo
            ], { stdio: ["pipe", "pipe", "pipe"] });
            let out = "";
            s.stdout.on("data", d => out += d);
            s.stdin.end(CONVITE_BOM);
            s.on("close", () => r(JSON.parse(out.split("\n").find(l => l.trim().startsWith("{")))));
        });

        assert.equal(p.ok, false);
        assert.match(p.erro, /nao consegui falar com a saida/);
        assert.ok(!existsSync(arquivo));
    });

    test("chave da saida diferente da esperada e recusada: e a defesa sem TLS", async () => {
        // O registro vai por HTTP puro (a saida e um IP, sem dominio). O risco serio nao e o
        // convite vazar: e alguem no meio devolver a propria saida e levar a midia junto.
        const arquivo = join(pasta, "streamfix-trocada.conf");
        const r = await provisionar(CONVITE_BOM, [
            "--arquivo", arquivo,
            "--chave-da-saida", "bm90LXRoZS1yZWFsLWtleS1ub3QtdGhlLXJlYWwta2V5MTI="
        ]);

        assert.equal(r.json.ok, false);
        assert.match(r.json.erro, /chave publica diferente da esperada/);
        assert.ok(!existsSync(arquivo));
    });

    test("com a chave certa, passa", async () => {
        const r = await provisionar(CONVITE_BOM, [
            "--arquivo", join(pasta, "streamfix-fixada.conf"),
            "--chave-da-saida", CHAVE_DA_SAIDA
        ]);
        assert.equal(r.json.ok, true);
    });

    test("o perfil gerado leva o AllowedApps: sem ele o tunel levaria a maquina inteira", async () => {
        const arquivo = join(pasta, "streamfix-apps.conf");
        await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);
        const conf = readFileSync(arquivo, "utf8");

        assert.match(conf, /^#@ws:AllowedApps = Discord$/m);
        assert.ok(conf.indexOf("[Peer]") < conf.indexOf("#@ws:AllowedApps"), "a diretiva vive no [Peer]");
        assert.match(conf, /^MTU = 1412$/m);
    });
});

// ============================================================================ o PowerShell

describe("instalador", () => {
    test("copia todo modulo do plugin que existe em disco", () => {
        // A deriva que isto pega: as fases 1 a 6 quebraram o plugin em modulos e a lista do
        // instalador ficou nos dois arquivos originais. Quem instalasse receberia um plugin que
        // nem compila, porque os imports de ./tunnel/ nao resolveriam.
        const emDisco = [
            ...readdirSync(join(RAIZ, "streamFix"))
                .filter(f => /\.(ts|tsx)$/.test(f))
                .map(f => `streamFix/${f}`),
            ...readdirSync(join(RAIZ, "streamFix", "tunnel"))
                .filter(f => /\.ts$/.test(f))
                .map(f => `streamFix/tunnel/${f}`)
        ];

        for (const arquivo of emDisco) {
            assert.ok(
                INSTALADOR.includes(`'${arquivo}'`),
                `${arquivo} existe mas o instalador nao o copia`
            );
        }
    });

    test("preserva o caminho relativo ao copiar, senao os imports nao resolvem", () => {
        assert.ok(
            !/Save-Text \(Join-Path \$target \(Split-Path -Leaf \$file\)\)/.test(INSTALADOR),
            "Split-Path -Leaf achataria ./tunnel/coletor.ts em ./coletor.ts"
        );
    });

    test("escreve exatamente as configuracoes que o plugin declara", () => {
        // A outra deriva: o instalador escrevia `proxy` e `excludedCountries`, que sairam na
        // fase 0. Configuracao que o plugin nao le e lixo; configuracao que ele le e o
        // instalador nao escreve e uma instalacao que nasce sem saida configurada.
        const plugin = readFileSync(join(RAIZ, "streamFix", "index.tsx"), "utf8");
        const bloco = /definePluginSettings\(\{([\s\S]*?)\n\}\);/.exec(plugin)[1];
        const declaradas = [...bloco.matchAll(/^ {4}(\w+): \{$/gm)].map(m => m[1]);

        assert.ok(declaradas.includes("exigirTunel"), "o teste achou o bloco errado");

        // As de regiao sao componentes de interface: o instalador nao tem o que escrever nelas.
        const escritas = declaradas.filter(nome => !["voiceRegion", "streamRegion"].includes(nome));
        for (const nome of escritas) {
            assert.ok(
                new RegExp(`-NotePropertyName ${nome}\\b`).test(INSTALADOR),
                `o plugin declara "${nome}" e o instalador nao escreve`
            );
        }

        for (const morta of ["proxy", "excludedCountries"]) {
            assert.ok(
                !new RegExp(`-NotePropertyName ${morta}\\b`).test(INSTALADOR),
                `o instalador ainda escreve "${morta}", que o plugin nao le mais`
            );
        }
    });

    test("o tunel sobe antes de o plugin ser copiado, e as configuracoes vem por ultimo", () => {
        // Este e o criterio de aceitacao da fase: uma instalacao interrompida no meio nao pode
        // deixar a pessoa com o plugin ligado e sem tunel -- estado pior que nao ter nada,
        // porque parece pronto. A garantia e a ordem, entao a ordem e o que se testa.
        const fluxo = /function Invoke-Install\([\s\S]*?\n\}/.exec(INSTALADOR)[0];

        const tunel = fluxo.indexOf("Install-Tunnel");
        const copia = fluxo.indexOf("Copy-Plugin");
        const build = fluxo.indexOf("Build-Mod");
        const config = fluxo.indexOf("Set-PluginSettings");

        assert.ok(tunel > 0 && copia > 0 && build > 0 && config > 0, "faltou um passo no fluxo");
        assert.ok(tunel < copia, "o tunel tem que vir antes de copiar o plugin");
        assert.ok(copia < build);
        assert.ok(build < config, "ativar o plugin e o ultimo passo");
    });

    test("o toolchain vem antes do tunel: o provisionador roda em Node", () => {
        const fluxo = /function Invoke-Install\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.ok(fluxo.indexOf("Install-Toolchain") < fluxo.indexOf("Install-Tunnel"));
    });

    test("o convite vai por stdin, nunca por argumento de linha de comando", () => {
        // Argumento aparece na lista de processos para qualquer conta da maquina.
        const chamada = /function Invoke-Provisioner\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.ok(chamada.includes("StandardInput.Write($invite)"), "o convite deveria ir por stdin");
        assert.ok(!/ArgumentList.Add\(.*invite/i.test(chamada), "o convite foi parar num argumento");
    });

    test("o .conf com a chave privada e apagado mesmo quando algo falha no meio", () => {
        const fn = /function Install-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.ok(fn.includes("finally"), "sem finally, uma falha deixaria a privada em disco");
        const finallyBlock = fn.slice(fn.indexOf("finally"));
        assert.match(finallyBlock, /Remove-Item -LiteralPath \$confPath/);
    });

    test("instalar de novo nao provisiona de novo", () => {
        // Atualizar o plugin passa por Install-Tunnel toda vez. Sem esta guarda, cada
        // atualizacao geraria uma chave nova, gastaria um uso do convite e deixaria o peer
        // anterior orfao ocupando endereco na saida -- e trocaria um perfil que funciona.
        const fn = /function Install-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];

        const guarda = fn.indexOf("Get-ExistingTunnel");
        const pedido = fn.indexOf("Read-Invite");
        assert.ok(guarda > 0, "nao ha checagem de perfil existente");
        assert.ok(pedido > 0, "nao ha pedido de convite");
        assert.ok(guarda < pedido, "a checagem tem que vir antes de pedir o convite");
        assert.match(fn, /if \(-not \$Reprovision\)/, "falta a valvula de escape");
    });

    test("o perfil exportado, que carrega a chave privada, e apagado sempre", () => {
        // `export` escreve o perfil inteiro em disco. Se ele sobrar, a privada fica largada
        // numa pasta temporaria do usuario.
        const fn = /function Get-ExistingTunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.ok(fn.includes("finally"), "sem finally, uma falha deixaria a privada em disco");
        assert.match(fn.slice(fn.indexOf("finally")), /Remove-Item -LiteralPath \$dir -Recurse/);
    });

    test("o instalador nao se auto-eleva", () => {
        // Medido em 11/09: o CLI do WireSock (list, status, import, delete, connect) funciona
        // sem elevacao. A unica coisa que precisa e a instalacao do WireSock, e quem levanta o
        // UAC dela e o proprio winget. Auto-elevar faria o pnpm e o build rodarem como
        // administrador, deixando arquivos que o dono da conta nao consegue apagar.
        assert.ok(!/-Verb\s+RunAs/i.test(INSTALADOR), "apareceu uma auto-elevacao");
    });

    test("a lista do provisionador e o fecho dos imports, senao nada resolve na maquina de quem instala", () => {
        // O provisionador e baixado para um diretorio temporario junto com o que ele importa.
        // Faltar um modulo so aparece na maquina da pessoa, no meio da instalacao.
        const fonte = readFileSync(PROVISIONA, "utf8");
        const cliente = readFileSync(join(RAIZ, "provisionamento", "cliente.ts"), "utf8");

        const importados = [
            ...[...fonte.matchAll(/from "\.\.\/(.+?)"/g)].map(m => m[1]),
            ...[...cliente.matchAll(/from "\.\/(.+?)"/g)].map(m => `provisionamento/${m[1]}`)
        ];

        assert.ok(importados.length >= 3, "o teste nao achou os imports");
        for (const rel of importados) {
            assert.ok(INSTALADOR.includes(`'${rel}'`), `${rel} e importado mas nao e baixado`);
        }
    });
});
