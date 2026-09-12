/*
 * Testes do controle do tunel.
 *
 * As saidas usadas aqui foram copiadas do CLI real (WireSock 3.4.8.1) em 11/09/2026, em
 * portugues, que e como ele responde nesta maquina. Sao proposital: um teste escrito com saida
 * em ingles passaria enquanto a producao falha no idioma do usuario.
 *
 * O teste central e "recusa e derruba quando o AllowedApps nao foi aplicado". Ele cobre o pior
 * modo de falha do projeto -- o tunel de pe levando a maquina inteira enquanto tudo parece bem.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    controleWireSock, appsAplicados, mensagensDoLog, estadoDoStatus, saidaDoStatus,
    perfilDoArquivo, PRAZO_CONEXAO_MS, PRAZO_CURTO_MS,
    contemPerfil, perfilAtivoDoStatus,
} = require("../streamFix/tunnel/controle.ts");
const { perfilDeControle } = require("../streamFix/tunnel/perfil.ts");

const PERFIL = "streamfix-santiago";

const STATUS_CONECTADO =
    "Conectado ao servidor usando o perfil streamfix-santiago\n" +
    "Endereço externo: 159.112.151.37, Chile, Santiago\n";

const STATUS_SEM_GEO =
    "Conectado ao servidor usando o perfil streamfix-santiago\nEndereço externo: , ,\n";

const STATUS_FORA = "Não conectado\n";

function log(...mensagens) {
    return "Conectando a streamfix-santiago\n"
        + mensagens.map(m => `{"date":"2026-09-11 01:20:03.9547","logger":"${PERFIL}", `
            + `"log_level":"info","message":${JSON.stringify(m)}}`).join("\n")
        + "\nConexão estabelecida\n";
}

const LOG_BOM = log("Connecting to remote peer using streamfix-santiago, endpoint=1.2.3.4:39743",
    "Kill switch is off", "AllowedIPs=0.0.0.0/0", "AllowedApps=Discord");

/** Um CLI dublado. `roteiro` mapeia o primeiro argumento para a saida. */
function cliFalso(roteiro) {
    const chamadas = [];
    const executar = async (_exe, args, opcoes) => {
        chamadas.push(Object.assign([...args], { prazo: opcoes?.tempoLimiteMs }));
        const r = roteiro[args[0]];
        if (r === undefined) throw new Error(`comando nao roteirizado: ${args[0]}`);
        if (r instanceof Error) throw r;
        return typeof r === "function" ? r(chamadas.length) : r;
    };
    return { executar, chamadas };
}

function controleDe(roteiro, extra) {
    const { executar, chamadas } = cliFalso(roteiro);
    return {
        c: controleWireSock({ executar, dormir: async () => {}, ...extra }),
        chamadas,
    };
}

// --------------------------------------------------------------------------------------------
// Leitura
// --------------------------------------------------------------------------------------------

test("le as mensagens JSON e ignora o texto solto ao redor", () => {
    const msgs = mensagensDoLog(LOG_BOM);
    assert.ok(msgs.includes("AllowedApps=Discord"));
    assert.ok(!msgs.some(m => m.includes("Conectando a")), "o texto traduzido nao entra");
});

test("linha truncada ou quase-JSON nao derruba a leitura", () => {
    const sujo = '{"message":"AllowedApps=Discord"}\n{"message":"Kill switch\n{ nao e json }\n';
    assert.deepEqual(appsAplicados(sujo), ["Discord"]);
});

test("le a lista de apps aplicados, com varios", () => {
    assert.deepEqual(appsAplicados(log("AllowedApps=Discord, DiscordPTB")), ["Discord", "DiscordPTB"]);
});

test("ausencia de AllowedApps e null, nao lista vazia", () => {
    // A diferenca decide o comportamento: `null` e "o CLI nao disse nada", que o `subir` trata
    // como perigo, nao como "sem restricao configurada".
    assert.equal(appsAplicados(log("Kill switch is off")), null);
    assert.equal(appsAplicados(""), null);
    assert.deepEqual(appsAplicados(log("AllowedApps=")), []);
});

test("o estado vem do nome do perfil, nao da frase traduzida", () => {
    assert.equal(estadoDoStatus(STATUS_CONECTADO, PERFIL), "conectado");
    assert.equal(estadoDoStatus(STATUS_FORA, PERFIL), "fora");
    // Conectado em outro perfil nao e este tunel de pe.
    assert.equal(estadoDoStatus(STATUS_CONECTADO, "spike-full"), "fora");
});

test("saida vazia do CLI e desconhecido, nunca fora", () => {
    // Tratar "nao sei" como "fora" faria o porteiro liberar uma transmissao condenada.
    assert.equal(estadoDoStatus("", PERFIL), "desconhecido");
    assert.equal(estadoDoStatus("   \n", PERFIL), "desconhecido");
});

test("extrai o endereco externo, e aguenta ele vir vazio", () => {
    assert.equal(saidaDoStatus(STATUS_CONECTADO), "159.112.151.37");
    assert.equal(saidaDoStatus(STATUS_SEM_GEO), "");
});

// --------------------------------------------------------------------------------------------
// subir
// --------------------------------------------------------------------------------------------

test("sobe quando o AllowedApps foi mesmo aplicado", async () => {
    const { c } = controleDe({ connect: LOG_BOM, status: STATUS_CONECTADO });
    assert.deepEqual(await c.subir(PERFIL), { ok: true, saida: "159.112.151.37" });
});

test("recusa e DERRUBA quando o AllowedApps nao foi aplicado", async () => {
    // O pior modo de falha do projeto: o tunel sobe, a transmissao funciona, o espectador ve a
    // tela -- e a maquina inteira esta saindo pelo Chile. Recusar sem derrubar deixaria o
    // usuario lendo a mensagem de erro com a VPN de maquina inteira ligada.
    const { c, chamadas } = controleDe({
        connect: log("Kill switch is off", "AllowedIPs=0.0.0.0/0"),
        status: STATUS_CONECTADO,
        disconnect: "Conexão encerrada",
    });
    const r = await c.subir(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /maquina inteira/);
    assert.ok(chamadas.some(a => a[0] === "disconnect"), "o tunel errado ficou de pe");
});

test("recusa quando o AllowedApps aplicado nao inclui o Discord", async () => {
    const { c, chamadas } = controleDe({
        connect: log("AllowedApps=Chrome"),
        status: STATUS_CONECTADO,
        disconnect: "",
    });
    const r = await c.subir(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /Discord/);
    assert.match(r.motivo, /aplicado: Chrome/);
    assert.ok(chamadas.some(a => a[0] === "disconnect"));
});

test("recusa quando o AllowedApps veio vazio", async () => {
    const { c } = controleDe({ connect: log("AllowedApps="), status: STATUS_CONECTADO, disconnect: "" });
    assert.equal((await c.subir(PERFIL)).ok, false);
});

test("recusa e derruba quando o CLI diz conectado mas o status nao confirma", async () => {
    const { c, chamadas } = controleDe({ connect: LOG_BOM, status: STATUS_FORA, disconnect: "" });
    const r = await c.subir(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /nao ficou conectado/);
    assert.ok(chamadas.some(a => a[0] === "disconnect"));
});

test("perfil inexistente e 'nao conectou', nao 'conectou errado'", async () => {
    // Medido: o CLI responde "Perfil X nao encontrado" -- frase traduzida, codigo de saida 0, e
    // nenhuma linha de log JSON. A ausencia de log e o sinal que nao depende de idioma. Sem
    // isto, um erro de digitacao no nome do perfil sai como alarme de VPN de maquina inteira.
    const naoEncontrado = "Conectando a x\nPerfil x não encontrado\n";
    const { c } = controleDe({ connect: naoEncontrado, disconnect: "" });
    const r = await c.subir("x");
    assert.equal(r.ok, false);
    assert.match(r.motivo, /nao chegou a conectar/);
    assert.doesNotMatch(r.motivo, /maquina inteira/);
});

test("tunel ja de pe nao e erro -- e o estado que distingue, nao o texto", async () => {
    // Medido em 11/09, com o tunel de pe: o CLI responde exatamente isto, sem nenhuma linha de
    // log JSON. E a MESMA ausencia de log do perfil inexistente logo acima, entao o texto nao
    // serve para separar os dois -- ele e traduzido. O estado serve.
    //
    // Tratar este caso como erro fazia a primeira abertura do Discord depois de instalar
    // reclamar "o WireSock nao chegou a conectar" com o tunel funcionando. Alarme falso ensina
    // a pessoa a ignorar o aviso, que e pior do que nao avisar.
    const jaConectado = "Conectando a streamfix-santiago\nOutra conexão já está em andamento.\n";
    const { c, chamadas } = controleDe({ connect: jaConectado, status: STATUS_CONECTADO });

    const r = await c.subir(PERFIL);
    assert.equal(r.ok, true);
    assert.equal(r.saida, "159.112.151.37");
    assert.ok(!chamadas.some(a => a[0] === "disconnect"), "nao pode derrubar um tunel que esta bom");
});

test("sem log e sem conexao continua sendo erro", async () => {
    // A outra metade do par: se o estado nao confirma, a ausencia de log volta a ser falha.
    const jaConectado = "Conectando a streamfix-santiago\nOutra conexão já está em andamento.\n";
    const { c } = controleDe({ connect: jaConectado, status: STATUS_FORA, disconnect: "" });

    const r = await c.subir(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /nao chegou a conectar/);
});

test("CLI ausente vira motivo, nao excecao", async () => {
    const { c } = controleDe({ connect: new Error("ENOENT") });
    const r = await c.subir(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /ENOENT/);
});

test("espera o endereco externo aparecer, e sobe mesmo se ele nunca vier", async () => {
    // Medido em 11/09: logo apos conectar o CLI mostra "Endereço externo: , ,". A consulta de
    // geo demora. Nao e motivo para falhar -- a verificacao que vale e a do proprio Discord.
    let n = 0;
    const { c } = controleDe({
        connect: LOG_BOM,
        status: () => (++n >= 3 ? STATUS_CONECTADO : STATUS_SEM_GEO),
    });
    assert.deepEqual(await c.subir(PERFIL), { ok: true, saida: "159.112.151.37" });

    const { c: c2 } = controleDe({ connect: LOG_BOM, status: STATUS_SEM_GEO });
    assert.deepEqual(await c2.subir(PERFIL), { ok: true, saida: "" });
});

test("o connect pede log-level info: nao depende do padrao do CLI", async () => {
    // As linhas de AllowedApps sao a unica confirmacao do split tunnel. Depender do nivel padrao
    // deixaria a verificacao morrer em silencio numa atualizacao do WireSock.
    const { c, chamadas } = controleDe({ connect: LOG_BOM, status: STATUS_CONECTADO });
    await c.subir(PERFIL);
    const connect = chamadas.find(a => a[0] === "connect");
    assert.deepEqual([...connect], ["connect", PERFIL, "-log-level", "info", "-exit"]);
    assert.ok(connect.includes("-exit"), "sem -exit o CLI nao devolve o controle");
});

// --------------------------------------------------------------------------------------------
// estado, derrubar, importar
// --------------------------------------------------------------------------------------------

test("estado nao explode quando o CLI falha", async () => {
    const { c } = controleDe({ status: new Error("nao encontrado") });
    assert.equal(await c.estado(PERFIL), "desconhecido");
});

test("derrubar ignora o codigo de saida do CLI", async () => {
    // Medido: `disconnect` bem-sucedido devolve 2. Qualquer leitura de codigo de saida aqui
    // reportaria erro no caminho feliz.
    const { c, chamadas } = controleDe({ disconnect: "Conexão encerrada" });
    await c.derrubar();
    assert.deepEqual(chamadas.map(a => [...a]), [["disconnect"]]);
});

test("derrubar o que ja esta fora nao e erro", async () => {
    const { c } = controleDe({ disconnect: new Error("nada a desconectar") });
    await c.derrubar();
});

test("importar confere pela list, porque o import falha com codigo 0", async () => {
    // Medido: `import` de um caminho inexistente responde com frase traduzida e sai com 0.
    const { c } = controleDe({ import: "Falha ao importar o perfil de X: ...", list: "Perfis:\n - outro" });
    const r = await c.importar(`C:/tmp/${PERFIL}.conf`, PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /nao aparece na lista/);
});

test("importar aceita quando o perfil aparece na list", async () => {
    const { c } = controleDe({
        import: "Perfil importado",
        list: `Perfis disponíveis:\n - spike-full\n - ${PERFIL}\n`,
    });
    assert.equal((await c.importar(`C:/tmp/${PERFIL}.conf`, PERFIL)).ok, true);
});

// --------------------------------------------------------------------------------------------
// O que o CLI real ensinou em 11/09
// --------------------------------------------------------------------------------------------

test("todo comando leva prazo: o connect pode nao voltar nunca", () => {
    // Medido: `connect -exit` num perfil cujo handshake nao fecha fica pendurado para sempre --
    // saida fora do ar, chave revogada, UDP bloqueado. Sem prazo o porteiro congela em vez de
    // recusar, que e o pior lugar possivel para travar: o clique do Go Live.
    assert.ok(PRAZO_CONEXAO_MS >= 5000, "a conexao boa levou 793 ms; o prazo tem que ter folga");
    assert.ok(PRAZO_CURTO_MS > 0);
});

test("o connect leva o prazo longo e o resto o curto", async () => {
    const { c, chamadas } = controleDe({ connect: LOG_BOM, status: STATUS_CONECTADO });
    await c.subir(PERFIL);
    assert.equal(chamadas.find(a => a[0] === "connect").prazo, PRAZO_CONEXAO_MS);
    assert.equal(chamadas.find(a => a[0] === "status").prazo, PRAZO_CURTO_MS);
});

test("o prazo estourado vira recusa, e derruba o que possa ter subido", async () => {
    // No prazo estourado nao se sabe o que ficou de pe: o CLI foi morto no meio, e o handshake
    // pode fechar depois. Deixar assim seria um tunel nao verificado ligado -- exatamente o que
    // esta unidade existe para impedir.
    const { c, chamadas } = controleDe({ connect: new Error("ETIMEDOUT"), disconnect: "" });
    const r = await c.subir(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /ETIMEDOUT/);
    assert.ok(chamadas.some(x => x[0] === "disconnect"), "ficou tunel de pe sem verificacao");
});

test("o nome do perfil sai do nome do arquivo", () => {
    // Medido, e nao documentado em lugar nenhum: `import teste.conf` cria o perfil `teste`,
    // ignorando qualquer nome que se queira dar.
    assert.equal(perfilDoArquivo(String.raw`C:\ProgramData\StreamFix\streamfix-santiago.conf`),
        "streamfix-santiago");
    assert.equal(perfilDoArquivo("/etc/wg/streamfix.CONF"), "streamfix");
    assert.equal(perfilDoArquivo("streamfix-santiago"), "streamfix-santiago");
});

test("importar recusa antes de executar quando o arquivo nao tem o nome do perfil", async () => {
    const { c, chamadas } = controleDe({});
    const r = await c.importar(String.raw`C:\tmp\teste.conf`, "streamfix-santiago");
    assert.equal(r.ok, false);
    assert.match(r.motivo, /viraria "teste"/);
    assert.deepEqual(chamadas.map(a => [...a]), [], "nao adianta importar: o CLI ignoraria o nome pedido");
});

// --------------------------------------------------------------------------------------------
// Tunel em dois niveis: dois perfis, um contido no nome do outro
// --------------------------------------------------------------------------------------------

const CONTROLE = "streamfix-santiago-controle";
const STATUS_CONTROLE =
    "Conectado ao servidor usando o perfil streamfix-santiago-controle\r\n" +
    "Endereço externo: 177.42.223.136, Brazil, Salvador\r\n";

test("o perfil de controle e o completo com -controle no fim", () => {
    assert.equal(perfilDeControle(PERFIL), CONTROLE);
});

test("o nome casa inteiro: o completo nao esta no ar quando o controle esta", () => {
    // O defeito que o `includes` tinha: `streamfix-santiago` esta contido em
    // `streamfix-santiago-controle`. Com o controle de pe, o plugin acharia que o completo
    // estava no ar e liberaria um Go Live que nasceria pelo Brasil.
    assert.equal(estadoDoStatus(STATUS_CONTROLE, PERFIL), "fora");
    assert.equal(estadoDoStatus(STATUS_CONTROLE, CONTROLE), "conectado");
    assert.equal(estadoDoStatus(STATUS_CONECTADO, CONTROLE), "fora");
    assert.equal(estadoDoStatus(STATUS_CONECTADO, PERFIL), "conectado");
});

test("o nome casa inteiro nas duas pontas, e com o \\r do CLI", () => {
    assert.equal(contemPerfil("perfil streamfix-santiago\r\n", PERFIL), true);
    assert.equal(contemPerfil("perfil streamfix-santiago2", PERFIL), false);
    assert.equal(contemPerfil("perfil xstreamfix-santiago", PERFIL), false);
    assert.equal(contemPerfil("perfil pre_streamfix-santiago", PERFIL), false);
    assert.equal(contemPerfil("perfil streamfix-santiago.", PERFIL), true);
    assert.equal(contemPerfil("qualquer coisa", ""), false);
});

test("o nome com caractere de regex e casado literalmente", () => {
    assert.equal(contemPerfil("perfil a.b", "a.b"), true);
    assert.equal(contemPerfil("perfil axb", "a.b"), false);
});

test("perfilAtivo diz qual dos dois esta no ar, ou nenhum, ou que nao sabe", () => {
    assert.equal(perfilAtivoDoStatus(STATUS_CONTROLE, [PERFIL, CONTROLE]), CONTROLE);
    assert.equal(perfilAtivoDoStatus(STATUS_CONECTADO, [PERFIL, CONTROLE]), PERFIL);
    assert.equal(perfilAtivoDoStatus(STATUS_FORA, [PERFIL, CONTROLE]), null);
    assert.equal(perfilAtivoDoStatus("", [PERFIL, CONTROLE]), "desconhecido");
});

test("perfilAtivo com o CLI falhando e desconhecido", async () => {
    const { c } = controleDe({ status: new Error("sem servico") });
    assert.equal(await c.perfilAtivo([PERFIL, CONTROLE]), "desconhecido");
});

test("importar nao confunde o perfil com outro que o contem no nome", async () => {
    // Na list real, os nomes vem um por linha. Com so o de controle importado, o completo nao
    // pode ser dado por presente.
    const { c } = controleDe({
        import: "Falha ao importar",
        list: `Perfis disponíveis:\r\n - spike-full\r\n - ${CONTROLE}\r\n`,
    });
    const r = await c.importar(`C:/tmp/${PERFIL}.conf`, PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /nao aparece na lista/);
});

/** Um CLI com estado: o `status` responde o perfil que o `connect` pos no ar. */
function cliComEstado(inicial) {
    let noAr = inicial;
    const chamadas = [];
    const executar = async (_exe, args) => {
        chamadas.push([...args]);
        if (args[0] === "status") {
            return noAr
                ? `Conectado ao servidor usando o perfil ${noAr}\r\nEndereço externo: 159.112.151.37, Chile, Santiago\r\n`
                : "Não conectado\r\n";
        }
        if (args[0] === "disconnect") { noAr = null; return "Conexão encerrada"; }
        if (args[0] === "connect") {
            // Medido em 11/09: com outro perfil de pe, o connect e recusado sem log.
            if (noAr) return "Outra conexão já está em andamento.\r\n";
            noAr = args[1];
            return LOG_BOM;
        }
        throw new Error(`comando nao roteirizado: ${args[0]}`);
    };
    let t = 0;
    const c = controleWireSock({ executar, dormir: async () => {}, agora: () => (t += 100) });
    return { c, chamadas, noAr: () => noAr };
}

test("trocar derruba antes de conectar, porque o connect com outro de pe e recusado sem log", async () => {
    const { c, chamadas, noAr } = cliComEstado(CONTROLE);
    const r = await c.trocar(PERFIL);
    assert.equal(r.ok, true);
    assert.equal(noAr(), PERFIL);
    assert.deepEqual(chamadas.map(a => a[0]).filter(x => x !== "status"), ["disconnect", "connect"]);
    assert.ok(r.duracaoMs > 0);
});

test("trocar para o perfil que ja esta no ar nao derruba nem conecta", async () => {
    const { c, chamadas } = cliComEstado(CONTROLE);
    assert.equal((await c.trocar(CONTROLE)).ok, true);
    assert.deepEqual(chamadas.map(a => a[0]), ["status"]);
});

test("no controle, pedir o completo troca de verdade", async () => {
    // O lado perigoso do nome contido: com o `includes`, o completo parecia no ar com o
    // controle de pe, o `trocar` nao faria nada, e o Go Live nasceria pelo Brasil.
    const { c, chamadas, noAr } = cliComEstado(CONTROLE);
    assert.equal((await c.trocar(PERFIL)).ok, true);
    assert.equal(noAr(), PERFIL);
    assert.equal((await c.trocar(CONTROLE)).ok, true);
    assert.equal(noAr(), CONTROLE);
    assert.equal(chamadas.filter(a => a[0] === "connect").length, 2);
});

test("trocar que falha no connect devolve o motivo e nao deixa tunel sem conferir", async () => {
    const { c, chamadas } = controleDe({
        status: STATUS_CONTROLE,
        disconnect: "",
        connect: log("Kill switch is off", "AllowedIPs=0.0.0.0/0"),
    });
    const r = await c.trocar(PERFIL);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /maquina inteira/);
    assert.equal(chamadas.filter(a => a[0] === "disconnect").length, 2, "derruba o controle e o completo errado");
});

test("trocar nao espera o endereco externo: dois status e mais nada", async () => {
    // Medido na fase 8 (12/09): cada `status` leva ~220 ms, e o endereco externo so aparece
    // segundos depois do `connect`. Esperar por ele custava de 1 a 1,5 s em cada troca -- no
    // clique do Go Live, espera pura -- e ninguem o usa: no controle, ele e o IP de casa.
    const { c, chamadas } = controleDe({
        status: n => n === 1 ? STATUS_CONTROLE : STATUS_SEM_GEO,
        disconnect: "",
        connect: LOG_BOM,
    });
    const r = await c.trocar(PERFIL);
    assert.equal(r.ok, true);
    assert.equal(chamadas.filter(a => a[0] === "status").length, 2, "o de antes da troca e o que confirma");
});

test("subir continua esperando o endereco externo", async () => {
    // O `subir` sozinho e o que o instalador e o diagnostico usam; la o endereco e informacao.
    const { c, chamadas } = controleDe({ status: STATUS_SEM_GEO, connect: LOG_BOM }, { tentativasDeSaida: 3 });
    await c.subir(PERFIL);
    assert.ok(chamadas.filter(a => a[0] === "status").length > 2);
});

test("existe casa o nome inteiro na list", async () => {
    // Com so o completo importado, o controle nao existe -- e o plugin tem de ficar no completo.
    const { c } = controleDe({ list: `Perfis disponíveis:\r\n - ${PERFIL}\r\n` });
    assert.equal(await c.existe(PERFIL), true);
    assert.equal(await c.existe(CONTROLE), false);
});

test("existe com o CLI falhando e false: sem saber, o plugin fica no completo", async () => {
    const { c } = controleDe({ list: new Error("sem servico") });
    assert.equal(await c.existe(CONTROLE), false);
});
