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

    test("no macOS o perfil de controle tem nome curto e nenhum AllowedApps", async () => {
        // As duas coisas que o wg-quick forca (medido em 17/09): nome de ate 15 caracteres, e
        // nenhum split por aplicativo -- `#@ws:AllowedApps` e extensao do WireSock, e emiti-lo
        // aqui prometeria uma restricao que ninguem aplica.
        const arquivo = join(pasta, "streamfix.conf");
        const r = await provisionar(CONVITE_BOM, ["--arquivo", arquivo, "--plataforma", "darwin"]);

        assert.equal(r.codigo, 0, r.saida + r.erro);
        assert.equal(r.json.perfil, "streamfix");
        assert.equal(r.json.perfilControle, "streamfix-ctl", "e nao streamfix-controle, que tem 17");
        assert.ok(r.json.perfilControle.length <= 15);

        const completo = readFileSync(arquivo, "utf8");
        const controle = readFileSync(r.json.arquivoControle, "utf8");
        assert.equal(/AllowedApps/.test(completo), false, "o completo nao pode prometer split por app");
        assert.equal(/AllowedApps/.test(controle), false);

        // O que protege a maquina no macOS sao os destinos, e eles continuam la.
        assert.match(completo, /^AllowedIPs = 0\.0\.0\.0\/0$/m);
        assert.match(controle, /^AllowedIPs = 162\.159\.128\.0\/17, 1\.1\.1\.1\/32$/m);
    });

    test("no macOS, um nome de perfil longo demais e recusado antes de gastar o convite", async () => {
        // Deixar passar daria um par de arquivos que o wg-quick recusaria depois, dizendo que o
        // arquivo nao existe -- e o convite ja teria sido consumido.
        const arquivo = join(pasta, "streamfix-santiago.conf");
        const r = await provisionar(CONVITE_BOM, ["--arquivo", arquivo, "--plataforma", "darwin"]);

        assert.equal(r.json.ok, false);
        assert.match(r.json.erro, /15/);
        assert.equal(existsSync(arquivo), false, "nao pode sobrar arquivo de um perfil recusado");
    });

    test("no Windows o mesmo nome longo continua valendo", async () => {
        // A recusa acima e do wg-quick, nao nossa: o WireSock aceita nome longo sem reclamar.
        const arquivo = join(pasta, "streamfix-santiago-win.conf");
        const r = await provisionar(CONVITE_BOM, ["--arquivo", arquivo, "--plataforma", "win32"]);

        assert.equal(r.json.ok, true, r.json.erro);
        assert.equal(r.json.perfilControle, "streamfix-santiago-win-controle");
        assert.match(readFileSync(arquivo, "utf8"), /^#@ws:AllowedApps = /m);
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

    test("o perfil gerado carrega ROTA, nao so a faixa interna", async () => {
        // O bug que custou mais caro no projeto inteiro. O provisionador passava a `faixa` da
        // saida (10.8.0.0/24) como AllowedIPs -- mas AllowedIPs sao os DESTINOS que o tunel
        // carrega, e nenhum servidor do Discord esta na faixa interna.
        //
        // O resultado e o pior tipo de falha: tudo parece certo. O tunel conecta, o handshake
        // fecha, o peer aparece na saida, o `status` diz "conectado", o AllowedApps e aceito --
        // e nada roteia. Ate o "endereco externo" que o WireSock reporta continua sendo o de
        // casa. Dois amigos instalaram e ficaram assim, e so o contador de bytes da saida
        // (1,5 KiB de keepalive contra centenas de MiB) denunciou.
        //
        // Passou por semanas porque a unica maquina onde se testava de verdade usava um perfil
        // escrito a mao, anterior ao provisionador.
        const arquivo = join(pasta, "streamfix-rota.conf");
        await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);
        const conf = readFileSync(arquivo, "utf8");

        const rota = /^AllowedIPs = (.+)$/m.exec(conf);
        assert.ok(rota, "o perfil saiu sem AllowedIPs");
        assert.equal(rota[1].trim(), "0.0.0.0/0", "o tunel precisa carregar rota padrao");

        // Dito de outro jeito, para o dia em que alguem for "arrumar" isto: uma faixa privada
        // ali nao carrega o Discord a lugar nenhum.
        assert.doesNotMatch(rota[1], /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
            "faixa privada como AllowedIPs monta um tunel que nao carrega nada");
    });

    test("o perfil gerado resolve DNS dentro do tunel", async () => {
        // Sem isto, quem esta no tunel resolve nomes pelo resolvedor do sistema, que sai por
        // fora. O Discord usa GeoDNS: resolver do Brasil devolve servidor brasileiro mesmo com
        // os pacotes saindo pelo Chile. O perfil que funciona desde o spike tem esta linha.
        const arquivo = join(pasta, "streamfix-dns.conf");
        await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);
        const conf = readFileSync(arquivo, "utf8");

        const dns = /^DNS = (.+)$/m.exec(conf);
        assert.ok(dns, "o perfil saiu sem DNS");
        assert.ok(conf.indexOf("[Interface]") < conf.indexOf("DNS ="), "DNS vive no [Interface]");
        assert.ok(conf.indexOf("DNS =") < conf.indexOf("[Peer]"));
    });

    test("grava os dois perfis do mesmo registro, e nenhum outro arquivo", async () => {
        // Tunel em dois niveis: um convite, um peer, dois arquivos. O de controle tem o nome que
        // o plugin procura (perfilDeControle) e so a faixa de controle na rota.
        const sub = join(pasta, "dois");
        require("node:fs").mkdirSync(sub, { recursive: true });
        const arquivo = join(sub, "streamfix-dois.conf");
        const r = await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);

        assert.equal(r.json.ok, true, r.saida + r.erro);
        assert.equal(r.json.perfilControle, "streamfix-dois-controle");
        assert.equal(r.json.arquivoControle, join(sub, "streamfix-dois-controle.conf"));
        assert.deepEqual(readdirSync(sub).sort(), ["streamfix-dois-controle.conf", "streamfix-dois.conf"]);

        const completo = readFileSync(arquivo, "utf8").split("\n");
        const controle = readFileSync(r.json.arquivoControle, "utf8").split("\n");
        const diferentes = completo.map((l, i) => [l, controle[i]]).filter(([a, b]) => a !== b);
        assert.deepEqual(diferentes, [["AllowedIPs = 0.0.0.0/0", "AllowedIPs = 162.159.128.0/17, 1.1.1.1/32"]]);
    });

    test("convite errado nao deixa nenhum dos dois perfis", async () => {
        const arquivo = join(pasta, "streamfix-nenhum.conf");
        await provisionar("nao-sou-convite", ["--arquivo", arquivo]);
        assert.ok(!existsSync(arquivo));
        assert.ok(!existsSync(join(pasta, "streamfix-nenhum-controle.conf")));
    });

    test("o perfil gerado leva o AllowedApps: sem ele o tunel levaria a maquina inteira", async () => {
        const arquivo = join(pasta, "streamfix-apps.conf");
        await provisionar(CONVITE_BOM, ["--arquivo", arquivo]);
        const conf = readFileSync(arquivo, "utf8");

        // O invariante e "tem Discord e nao esta vazio", nao a lista exata: DiscordPTB e
        // DiscordCanary entraram depois, porque quem usa esses clientes ficava com um tunel
        // que nao casava com o proprio Discord.
        const linha = /^#@ws:AllowedApps = (.+)$/m.exec(conf);
        assert.ok(linha, "o perfil saiu sem AllowedApps");
        const listados = linha[1].split(",").map(a => a.trim()).filter(Boolean);
        assert.ok(listados.length > 0, "lista vazia levaria a maquina inteira");
        assert.ok(listados.includes("Discord"), `Discord fora da lista: ${linha[1]}`);
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

        for (const morta of ["proxy", "excludedCountries", "tunelPermanente"]) {
            assert.ok(
                !new RegExp(`-NotePropertyName ${morta}\\b`).test(INSTALADOR),
                `o instalador ainda escreve "${morta}", que o plugin nao le mais`
            );
            // E apaga de quem atualiza: o `tunelPermanente` ligado de uma instalacao antiga nao
            // pode ficar no settings.json fingindo que ainda manda em alguma coisa.
            assert.ok(
                new RegExp(`foreach \\(\\$dead in @\\([^)]*'${morta}'`).test(INSTALADOR),
                `o instalador nao apaga "${morta}" de quem atualiza`
            );
        }

        // O padrao do tunel em dois niveis e o controle. Reinstalar nao pode desligar o completo
        // de quem o ligou de proposito, entao so escreve quando falta.
        assert.match(
            INSTALADOR,
            /if \(-not \$plugin\.PSObject\.Properties\['tunelCompletoSempre'\]\) \{\s*\$plugin \| Add-Member -NotePropertyName tunelCompletoSempre -NotePropertyValue \$false/
        );
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

    test("o tunel sobe ANTES de o Discord abrir", () => {
        // O bug que isto guarda: o instalador importava o perfil e nunca conectava. O Discord
        // abria, o WebSocket de gateway nascia pelo IP brasileiro, e so entao o plugin subia o
        // tunel -- tarde demais, porque o WireSock captura conexao nova e nao a que ja existe.
        // A sessao inteira nascia marcada como brasileira e o cliente escondia o botao de
        // transmitir. Como o botao nem chama a funcao que o plugin intercepta, o porteiro nunca
        // era consultado e nada explicava o porque.
        const fluxo = /function Invoke-Install\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        const tunnel = /function Install-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];

        // A cadeia inteira, porque o nome solto num comentario passaria: Install-Tunnel chama
        // Connect-Normal, que chama Connect-Level, que chama Connect-Tunnel.
        const semComentario = t => t.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
        const normal = /function Connect-Normal\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        const nivel = /function Connect-Level\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(semComentario(tunnel), /Connect-Normal/, "Install-Tunnel nao sobe o tunel");
        assert.match(semComentario(normal), /Connect-Level/);
        assert.match(semComentario(nivel), /Connect-Tunnel/);
        assert.ok(fluxo.indexOf("Install-Tunnel") < fluxo.indexOf("Start-Discord"),
            "o tunel tem que subir antes de o Discord abrir");
    });

    test("conectar tem prazo: sem ele o instalador fica pendurado para sempre", () => {
        // Medido na fase 3: `connect -exit` nunca volta quando o aperto de mao nao fecha.
        const fn = /function Connect-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /WaitForExit\(\d+\)/, "falta o prazo");
        assert.match(fn, /\.Kill\(\)/, "no estouro do prazo o processo tem que morrer");
        // Quem decide se subiu e o status, nao o codigo de saida do connect.
        assert.match(fn, /status/, "precisa confirmar pelo status");
    });

    test("quem sobe o tunel confere que ele leva so o Discord", () => {
        // O plugin passou a aceitar um tunel que ja encontrou de pe, porque nenhum comando do
        // CLI mostra o split tunnel de uma conexao ativa -- so o `connect` o reporta, no log.
        // Isso so e seguro se quem subiu tiver conferido, e quem sobe para o Discord abrir e
        // esta funcao. Sem a conferencia aqui, a defesa contra "o tunel levou a maquina
        // inteira" desaparece para todo mundo que instala do zero.
        const fn = /function Connect-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];

        assert.match(fn, /-log-level', 'info'/, "sem log info o CLI nao reporta os aplicativos");
        assert.match(fn, /AllowedApps/, "nao confere o split tunnel");
        assert.match(fn, /disconnect/, "tunel que subiu errado tem que ser derrubado");
    });

    test("quem sobe o tunel confere a ROTA, nao so os aplicativos", () => {
        // As duas metades da configuracao do split tunnel: AllowedApps diz QUEM entra no
        // tunel, AllowedIPs diz PARA ONDE. Por semanas so a primeira era conferida, e um
        // perfil com o app certo e a rota errada passava como bom -- conectava, apertava a
        // mao, e nao carregava nada.
        const fn = /function Connect-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /AllowedIPs/, "nao confere a rota");
        assert.match(fn, /0\.0\.0\.0\/0/, "nao exige rota padrao");
    });

    test("o diagnostico mostra e confere as duas metades", () => {
        // O relatorio de dois amigos trazia a linha "AllowedIPs=10.8.0.0/24" -- a causa exata
        // do problema -- e o diagnostico a descartava no filtro, imprimindo "[OK]" logo abaixo.
        const diag = readFileSync(join(RAIZ, "installer", "Diagnostico-Tunel.ps1"), "utf8");
        assert.match(diag, /Allowed\(IPs\|Apps\)/, "o filtro ainda deixa uma das duas de fora");
        assert.match(diag, /AllowedIPs=\(/, "nao extrai a rota para julgar");
        assert.match(diag, /0\.0\.0\.0\/0/, "nao sabe qual rota e a certa");
    });

    test("consertar um perfil parado nao derruba o tunel que esta no ar", () => {
        // `disconnect` nao escolhe perfil: derruba o que estiver conectado. Reparar um perfil
        // qualquer nao pode desligar o tunel que a pessoa esta usando naquele momento.
        // Comentario que explica a regra nao e a regra: so o codigo conta. Sem tirar os
        // comentarios, o indexOf abaixo casa com a propria frase que documenta a checagem.
        const fn = /function Repair-TunnelProfile\([\s\S]*?\n\}/.exec(INSTALADOR)[0]
            .split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

        const corte = fn.indexOf("disconnect");
        assert.ok(corte > 0, "o reparo nao derruba nada?");
        assert.match(fn.slice(0, corte), /status/, "derruba sem antes conferir qual perfil esta no ar");
    });

    test("o reparo preserva a chave: ele existe para nao gastar convite", () => {
        // Reprovisionar geraria chave nova, gastaria um uso do convite e deixaria o peer
        // antigo ocupando endereco na saida. A privada ja esta guardada no WireSock, entao o
        // reparo so reescreve a linha errada e reimporta.
        const fn = /function Repair-TunnelProfile\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /export/, "sem exportar nao da para preservar a chave");
        assert.ok(!/Invoke-Provisioner|Read-Invite/.test(fn), "o reparo nao pode provisionar de novo");
        assert.ok(fn.includes("finally"), "o perfil exportado tem a chave privada e precisa morrer");
    });

    test("reinstalar conserta um perfil com a rota errada", () => {
        // E o que faz quem ja instalou no periodo do bug se recuperar sem fazer nada especial.
        const fn = /function Install-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /Repair-TunnelProfile/, "reinstalar nao conserta perfil quebrado");
        assert.match(fn, /rota -ne '0\.0\.0\.0\/0'/, "nao detecta a rota errada");
    });

    test("o log do connect, que carrega o caminho do perfil, e apagado sempre", () => {
        const fn = /function Connect-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.ok(fn.includes("finally"), "sem finally o log fica largado no TEMP");
        assert.match(fn.slice(fn.indexOf("finally")), /Remove-Item/);
    });

    test("falhar ao subir o tunel nao derruba a instalacao, mas avisa", () => {
        // O plugin tenta subir sozinho no start(). O que nao pode e a pessoa achar que esta
        // pronto e descobrir pelo botao cinza.
        const fn = /function Connect-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.ok(!/throw/.test(fn), "Connect-Tunnel nao pode derrubar a instalacao");

        const fluxo = /function Invoke-Install\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fluxo, /\$tunnel\.conectado/, "o fim da instalacao ignora se o tunel subiu");
        assert.match(fluxo, /bandeja/i, "o aviso precisa dizer como reabrir o Discord de verdade");
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

    test("nada que so exista no PowerShell 7 ou no .NET Core", () => {
        // O instalador roda em Windows PowerShell 5.1, que e .NET Framework -- e o .exe da
        // janela e compilado por ps2exe, que tambem e 5.1. Nada disso da erro ao escrever nem
        // ao revisar: `$psi.ArgumentList` simplesmente vem NULA em 5.1, e o `.Add()` estoura
        // na cara de quem esta instalando, no meio do provisionamento.
        //
        // Foi exatamente o que aconteceu na v2.0.0. Este teste existe para nao acontecer de novo.
        const proibidos = [
            [/\$\w+\.ArgumentList\s*\.\s*Add\b/, "ProcessStartInfo.ArgumentList so existe no .NET Core; monte a string com Format-Argument"],
            [/\[System\.IO\.Path\]::GetRelativePath/, "GetRelativePath so existe no .NET Core"],
            [/ConvertFrom-Json[^\n]*-AsHashtable/, "-AsHashtable so existe no PowerShell 6+"],
            [/Get-Content[^\n]*-AsByteStream/, "-AsByteStream so existe no PowerShell 6+; em 5.1 e -Encoding Byte"],
            [/Split-Path[^\n]*-LeafBase/, "-LeafBase so existe no PowerShell 6+"],
            [/\?\?/, "o operador ?? so existe no PowerShell 7+"]
        ];

        for (const arquivo of ["StreamFix-Installer.ps1", "StreamFix-Installer-GUI.ps1", "Verifica-Tunel.ps1"]) {
            const fonte = readFileSync(join(RAIZ, "installer", arquivo), "utf8");
            // Comentario explicando por que algo NAO se usa nao conta como uso.
            const codigo = fonte.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
            for (const [padrao, porque] of proibidos) {
                assert.ok(!padrao.test(codigo), `${arquivo}: ${porque}`);
            }
        }
    });

    test("a chave da saida tem padrao, senao quem instala pela janela fica sem a defesa", () => {
        // A janela nao tem onde digitar a chave, e e por ela que quase todo mundo instala. Sem
        // padrao, o unico que ficaria protegido contra substituicao de resposta seria quem usa
        // o terminal e lembra de passar -ExitKey. O padrao casa com o do -ExitUrl: os dois
        // descrevem a mesma saida.
        const url = /\[string\]\s*\$ExitUrl\s*=\s*'([^']*)'/.exec(INSTALADOR);
        const chave = /\[string\]\s*\$ExitKey\s*=\s*'([^']*)'/.exec(INSTALADOR);

        assert.ok(url && chave, "faltou um dos dois parametros");
        assert.match(chave[1], /^[A-Za-z0-9+/]{43}=$/, "o padrao do ExitKey nao e uma chave WireGuard");
        assert.ok(url[1].length > 0, "o ExitUrl precisa de padrao para o ExitKey fazer sentido");
    });

    test("o diagnostico nunca imprime chave", () => {
        // Ele existe para ser colado em conversa. Uma chave escapando ali e uma credencial
        // publicada por alguem que so queria ajuda.
        const diag = readFileSync(join(RAIZ, "installer", "Diagnostico-Tunel.ps1"), "utf8");
        assert.match(diag, /function Limpar/, "falta a limpeza");
        // Toda saida do CLI passa pela limpeza antes de virar texto na tela.
        for (const m of diag.matchAll(/^\s*(?:foreach.*)?Nota \((.+)\)$/gm)) {
            const arg = m[1];
            if (/\$l|\$linha|status|log/.test(arg)) {
                assert.match(arg, /Limpar/, `saida do CLI impressa sem limpar: ${arg}`);
            }
        }
        assert.ok(!/export/.test(diag), "o diagnostico nunca deve exportar o perfil");
    });

    test("o .NET e conferido antes de qualquer coisa depender do CLI", () => {
        // O wiresock-connect-cli e um programa .NET. Com a instalacao do .NET quebrada ele nem
        // inicia: o Windows mostra "Imagem Incompleta" com status 0xc0000127 e nada funciona
        // dali em diante. Sem esta checagem o instalador segue achando que nao ha perfil, pede
        // convite, provisiona, e falha no import com uma mensagem que nao aponta a causa.
        const fn = /function Get-WireSock \{[\s\S]*?\n\}/.exec(INSTALADOR)[0];
        const check = fn.indexOf("Test-DotNetParaWireSock");
        const uso = fn.indexOf("return $cli");
        assert.ok(check > 0, "o instalador nao confere o .NET");
        assert.ok(check < uso, "confere depois de ja ter devolvido o CLI");
    });

    test("o diagnostico confere o .NET antes de chamar o CLI", () => {
        // Aqui a ordem importa por um motivo pior: chamar o CLI com o .NET quebrado abre uma
        // CAIXA DE DIALOGO do Windows, e o diagnostico ficaria parado esperando um clique.
        const diag = readFileSync(join(RAIZ, "installer", "Diagnostico-Tunel.ps1"), "utf8")
            .split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

        const check = diag.indexOf("Test-DotNetParaWireSock $cli");
        const primeiraChamada = diag.indexOf("& $cli list");
        assert.ok(check > 0, "o diagnostico nao confere o .NET");
        assert.ok(primeiraChamada > 0, "o teste nao achou a primeira chamada ao CLI");
        assert.ok(check < primeiraChamada, "chama o CLI antes de conferir: pode travar num dialogo");
    });

    test("a checagem do .NET sabe dizer o que instalar", () => {
        // Uma mensagem que so diz "erro no .NET" manda a pessoa para o Google. O nome exato do
        // pacote e o link resolvem sozinhos.
        for (const arquivo of ["StreamFix-Installer.ps1", "Diagnostico-Tunel.ps1"]) {
            const fonte = readFileSync(join(RAIZ, "installer", arquivo), "utf8");
            assert.match(fonte, /Desktop Runtime/, `${arquivo} nao diz qual pacote instalar`);
            assert.match(fonte, /dotnet\.microsoft\.com\/download/, `${arquivo} nao diz onde baixar`);
        }
    });

    test("nenhuma chamada ao CLI escapa do Invoke-WireSock", () => {
        // `2>&1` num executavel nativo no PowerShell 5.1 embrulha cada linha de stderr num
        // ErrorRecord, e com ErrorActionPreference=Stop -- que e o desta instalacao -- isso
        // vira erro terminante mesmo quando o comando funcionou. O arquivo ja avisava sobre
        // isso em Invoke-Native, e eu reintroduzi a armadilha em treze lugares: uma falha do
        // servico do WireSock chegou ao usuario como uma caixa falando de "EndInvoke".
        const codigo = INSTALADOR.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
        const diretas = [...codigo.matchAll(/^.*& \$cli .*$/gm)]
            .map(m => m[0].trim())
            .filter(l => !l.includes("@argumentos"));   // a unica legitima e a de dentro do helper

        assert.deepEqual(diretas, [], `chamadas ao CLI fora do Invoke-WireSock:\n${diretas.join("\n")}`);
    });

    test("o Invoke-WireSock protege e devolve o codigo", () => {
        const fn = /function Invoke-WireSock\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /ErrorActionPreference = 'Continue'/, "nao relaxa a checagem do PowerShell");
        assert.match(fn, /finally/, "nao devolve o ErrorActionPreference ao que era");
        assert.match(fn, /codigo = \$LASTEXITCODE/, "quem chama precisa do codigo de saida");
    });

    test("o servico morto vira mensagem, nao pilha de excecao", () => {
        // O CLI conversa com o servico do WireSock por gRPC. Servico parado nao devolve erro:
        // lanca Grpc.Core.RpcException DeadlineExceeded. Acontece logo depois de instalar ou
        // consertar o .NET, porque o servico ficou de pe com o runtime velho.
        const fn = /function Get-WireSock \{[\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /RpcException\|DeadlineExceeded/, "nao reconhece o servico morto");
        assert.match(fn, /Repair-WireSockServico/, "nem tenta reiniciar o servico");
        assert.match(fn, /Reinicie o computador/, "nao diz o que fazer");
    });

    test("o instalador nao se auto-eleva", () => {
        // Medido em 11/09: o CLI do WireSock (list, status, import, delete, connect) funciona
        // sem elevacao. A unica coisa que precisa e a instalacao do WireSock, e quem levanta o
        // UAC dela e o proprio winget. Auto-elevar faria o pnpm e o build rodarem como
        // administrador, deixando arquivos que o dono da conta nao consegue apagar.
        assert.ok(!/-Verb\s+RunAs/i.test(INSTALADOR), "apareceu uma auto-elevacao");
    });

    // ------------------------------------------------------------ tunel em dois niveis

    const semComentario = t => t.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    const SCRIPTS = ["StreamFix-Installer.ps1", "Diagnostico-Tunel.ps1", "Verifica-Tunel.ps1"];
    const fonteDe = arquivo => readFileSync(join(RAIZ, "installer", arquivo), "utf8");

    test("a faixa de controle dos scripts e a mesma do perfil.ts", () => {
        // Drift: o plugin procura o perfil de controle e o provisionador o gera a partir do
        // perfil.ts; o instalador o deriva e confere com a sua copia. Se as duas copias
        // divergirem, o Connect-Tunnel recusa o perfil que o provisionador acabou de gerar.
        const { FAIXA_CONTROLE, perfilDeControle } = require("../streamFix/tunnel/perfil.ts");
        for (const arquivo of ["StreamFix-Installer.ps1", "Diagnostico-Tunel.ps1"]) {
            const m = /\$ControlRange = '([^']+)'/.exec(fonteDe(arquivo));
            assert.ok(m, `${arquivo} nao declara a faixa de controle`);
            assert.equal(m[1], FAIXA_CONTROLE, `${arquivo} diverge do perfil.ts`);
        }
        // O nome tambem: "<perfil>-controle" nos tres scripts e no perfil.ts.
        assert.equal(perfilDeControle("p"), "p-controle");
        assert.match(fonteDe("StreamFix-Installer.ps1"), /function Get-ControlProfileName\(\$profile\) \{ return "\$profile-controle" \}/);
        assert.match(fonteDe("Diagnostico-Tunel.ps1"), /\$Controle = "\$Profile-controle"/);
        assert.match(fonteDe("Verifica-Tunel.ps1"), /\$Controle = "\$Profile-controle"/);
    });

    test("nenhum script procura o nome do perfil como texto solto", () => {
        // `streamfix-santiago` esta contido em `streamfix-santiago-controle`. Com o controle
        // de pe, `-match [regex]::Escape($profile)` daria o completo por conectado.
        for (const arquivo of SCRIPTS) {
            const codigo = semComentario(fonteDe(arquivo));
            const soltos = [...codigo.matchAll(/^.*-(not)?match \[regex\]::Escape\(\$[Pp]rofile\).*$/gm)].map(m => m[0].trim());
            assert.deepEqual(soltos, [], `${arquivo}:\n${soltos.join("\n")}`);
        }
    });

    test("o casamento exato dos scripts e o mesmo do plugin", () => {
        // A mesma borda nos quatro lugares: nada de letra, digito, - ou _ colado ao nome.
        const borda = "(?<![\\p{L}\\p{N}_-])";
        const controle = readFileSync(join(RAIZ, "streamFix", "tunnel", "controle.ts"), "utf8");
        assert.ok(controle.includes("(?<![\\\\p{L}\\\\p{N}_-])"), "o plugin mudou a regra");
        for (const arquivo of SCRIPTS) {
            assert.ok(fonteDe(arquivo).includes(borda), `${arquivo} nao usa a borda do nome inteiro`);
        }
    });

    test("o perfil de controle e derivado do completo, sem convite e sem deixar chave em disco", () => {
        const fn = /function New-ControlProfile\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /'export', \$profile/, "sem exportar o completo nao da para reaproveitar a chave");
        assert.match(fn, /Set-ProfileRoute[^\n]*\$ControlRange/, "a rota do derivado nao e a faixa de controle");
        assert.ok(!/Invoke-Provisioner|Read-Invite/.test(fn), "derivar nao pode provisionar de novo");
        assert.match(fn.slice(fn.indexOf("finally")), /Remove-Item -LiteralPath \$dir -Recurse/,
            "o exportado e o derivado tem a chave e precisam morrer");
    });

    test("reinstalar sem convite cria o perfil de controle de quem ja usa", () => {
        const fn = semComentario(/function Install-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0]);
        const guarda = fn.indexOf("Get-ExistingTunnel");
        const deriva = fn.indexOf("New-ControlProfile");
        const convite = fn.indexOf("Read-Invite");
        assert.ok(guarda > 0 && deriva > guarda && deriva < convite,
            "o controle tem de ser derivado no caminho de quem ja tem perfil, antes de pedir convite");
    });

    test("o estado normal e o controle, e sem ele o completo", () => {
        const fn = semComentario(/function Connect-Normal\([\s\S]*?\n\}/.exec(INSTALADOR)[0]);
        assert.match(fn, /if \(\$temControle\)[\s\S]*Connect-Level \$cli \$controle \$ControlRange/);
        assert.match(fn, /Connect-Level \$cli \$profile '0\.0\.0\.0\/0'/, "sem o controle, o completo");
    });

    test("trocar de perfil so derruba o tunel se ele for nosso", () => {
        const fn = semComentario(/function Connect-Level\([\s\S]*?\n\}/.exec(INSTALADOR)[0]);
        const corte = fn.indexOf("disconnect");
        assert.ok(corte > 0, "sem disconnect o connect e recusado sem log");
        assert.match(fn.slice(0, corte), /foreach \(\$p in \$nossos\)[\s\S]*Test-ProfileName \$status \$p/,
            "derruba sem conferir que o perfil no ar e um dos nossos");
    });

    test("o de controle e conferido contra a sua rota, nao contra a rota padrao", () => {
        const fn = /function Connect-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        assert.match(fn, /Test-SameRoute \$rota \$rotaEsperada/);
    });

    test("o teste negativo do Verifica pergunta a um endereco que esta nas duas rotas", () => {
        // Com o controle no ar, um endereco fora da faixa nem entra no tunel: o teste negativo
        // passaria com o AllowedApps quebrado. 1.1.1.1 esta na faixa de controle.
        const url = /\[string\] \$TraceUrl = '([^']+)'/.exec(fonteDe("Verifica-Tunel.ps1"))[1];
        const host = new URL(url).hostname;
        const { FAIXA_CONTROLE } = require("../streamFix/tunnel/perfil.ts");
        assert.ok(FAIXA_CONTROLE.split(",").map(s => s.trim()).includes(`${host}/32`),
            `${host} nao esta na faixa de controle`);
    });

    test("com o controle no ar, o Verifica nao toma o IP de casa pela saida", () => {
        // O "endereco externo" do status, com o controle de pe, e o de casa. Usa-lo como saida
        // faria o teste negativo acusar a maquina inteira no tunel toda vez.
        const v = semComentario(fonteDe("Verifica-Tunel.ps1"));
        assert.match(v, /if \(\$noControle\) \{\s*\$ExitHost = Get-ExitHostFromProfile/);
        const fn = /function Get-ExitHostFromProfile\([\s\S]*?\n\}/.exec(v)[0];
        assert.match(fn.slice(fn.indexOf("finally")), /Remove-Item -LiteralPath \$dir -Recurse/,
            "o perfil exportado tem a chave e precisa morrer");
    });

    test("os scripts compilam, e as funcoes puras do instalador fazem o que dizem", {
        skip: process.platform !== "win32" && "so ha Windows PowerShell no Windows"
    }, () => {
        // Os testes acima leem texto; este executa. Ele existe porque dois defeitos passaram
        // por todos eles em 12/09: `"perfil $controle: ..."`, que o PowerShell le como variavel
        // com escopo e recusa o arquivo INTEIRO, e um DNS duplicado em todo perfil derivado.
        // Carrega so as funcoes, pela arvore sintatica: o instalador nao roda.
        const { execFileSync } = require("node:child_process");
        const pasta = join(RAIZ, "installer").replace(/'/g, "''");
        const script = `
$ErrorActionPreference = 'Stop'
$erros = 0
foreach ($f in Get-ChildItem -LiteralPath '${pasta}' -Filter *.ps1) {
    $e = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref] $null, [ref] $e)
    foreach ($x in $e) { $erros++; "SINTAXE $($f.Name):$($x.Extent.StartLineNumber) $($x.Message)" }
}
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path '${pasta}' 'StreamFix-Installer.ps1'), [ref] $null, [ref] $null)
foreach ($d in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if (@('Test-ProfileName', 'Test-SameRoute', 'Set-ProfileRoute') -contains $d.Name) { . ([scriptblock]::Create($d.Extent.Text)) }
}
function Confere($ok, $o) { if (-not $ok) { $script:erros++; "FALHA $o" } }
Confere (-not (Test-ProfileName 'perfil streamfix-santiago-controle' 'streamfix-santiago')) 'nome contido'
Confere (Test-ProfileName "perfil streamfix-santiago\`r\`n" 'streamfix-santiago') 'nome com CR'
Confere (-not (Test-ProfileName 'perfil axb' 'a.b')) 'ponto literal'
Confere (Test-SameRoute '162.159.128.0/17,1.1.1.1/32' '162.159.128.0/17, 1.1.1.1/32') 'rota do log'
$r = Set-ProfileRoute @('[Interface]', 'Address = 10.8.0.2/32', 'DNS = 1.1.1.1', '[Peer]', 'AllowedIPs = 0.0.0.0/0') 'X'
Confere (@($r | Where-Object { $_ -match '^DNS' }).Count -eq 1) 'DNS duplicado'
Confere (@($r | Where-Object { $_ -eq 'AllowedIPs = X' }).Count -eq 1) 'rota reescrita'
$r = Set-ProfileRoute @('Address = 10.8.0.2/32', 'AllowedIPs = 10.8.0.0/24') 'X'
Confere ($r[1] -eq 'DNS = 1.1.1.1') 'DNS que faltava entra depois do Address'
"erros=$erros"`;
        const saida = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", timeout: 60000 });
        assert.match(saida, /erros=0\s*$/, saida);
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
