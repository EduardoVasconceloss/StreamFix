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

    test("o tunel sobe ANTES de o Discord abrir", () => {
        // O bug que isto guarda: o instalador importava o perfil e nunca conectava. O Discord
        // abria, o WebSocket de gateway nascia pelo IP brasileiro, e so entao o plugin subia o
        // tunel -- tarde demais, porque o WireSock captura conexao nova e nao a que ja existe.
        // A sessao inteira nascia marcada como brasileira e o cliente escondia o botao de
        // transmitir. Como o botao nem chama a funcao que o plugin intercepta, o porteiro nunca
        // era consultado e nada explicava o porque.
        const fluxo = /function Invoke-Install\([\s\S]*?\n\}/.exec(INSTALADOR)[0];
        const tunnel = /function Install-Tunnel\([\s\S]*?\n\}/.exec(INSTALADOR)[0];

        assert.match(tunnel, /Connect-Tunnel/, "Install-Tunnel nao sobe o tunel");
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
