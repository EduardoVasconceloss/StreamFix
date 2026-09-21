/*
 * Testes do perfil e da medicao de MTU.
 *
 * O teste que mais importa aqui nao e sobre o formato do texto: e a assercao de que a linha
 * `#@ws:AllowedApps` cai dentro do `[Peer]`. Ela e a unica defesa automatica contra o pior modo
 * de falha do projeto -- o tunel levando a maquina inteira enquanto todo teste de ponta a ponta
 * passa, porque o espectador ve a tela do mesmo jeito.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    gerarPerfil, medirMtuDoCaminho, mtuDoTunel, comandoPing, respostaChegou,
    medirMtuComAlternativas, FAIXA_CONTROLE, perfilDeControle,
    CABECALHO_ICMP, SOBRECARGA_WIREGUARD, CARGA_MAXIMA,
} = require("../streamFix/tunnel/perfil.ts");

const BASE = {
    chavePrivada: "cHJpdmFkYQ==",
    endereco: "10.8.0.2/32",
    chavePublicaDoServidor: "fbv+rSWSp36QfVdcNvPHdtEFzeOvCrzB1cyNBfGSvWY=",
    endpoint: "159.112.151.37:51820",
    mtu: 1412,
};

function linhas(texto) {
    return texto.split("\n");
}

test("AllowedApps cai dentro do [Peer], depois do comentario das extensoes", () => {
    const l = linhas(gerarPerfil(BASE));
    const iface = l.indexOf("[Interface]");
    const peer = l.indexOf("[Peer]");
    const comentario = l.indexOf("# [Peer] WireSock extensions");
    const apps = l.findIndex(x => x.startsWith("#@ws:AllowedApps"));

    assert.ok(iface < peer, "o [Interface] vem primeiro");
    assert.ok(peer < comentario, "o comentario das extensoes esta no bloco do peer");
    assert.equal(apps, comentario + 1, "AllowedApps vem logo depois do comentario");
    assert.ok(apps > peer, "AllowedApps NAO pode estar no [Interface]: la e ignorado em silencio");
});

test("o perfil tem o que o WireSock exige, e o MTU medido", () => {
    const texto = gerarPerfil(BASE);
    assert.match(texto, /^\[Interface\]$/m);
    assert.match(texto, /^PrivateKey = cHJpdmFkYQ==$/m);
    assert.match(texto, /^Address = 10\.8\.0\.2\/32$/m);
    assert.match(texto, /^MTU = 1412$/m);
    assert.match(texto, /^Endpoint = 159\.112\.151\.37:51820$/m);
    assert.match(texto, /^AllowedIPs = 0\.0\.0\.0\/0$/m);
    assert.match(texto, /^PersistentKeepalive = 25$/m);
    assert.match(texto, /^#@ws:AllowedApps = Discord$/m);
});

test("o app padrao casa por nome de processo, sem caminho e sem .exe", () => {
    // O Discord abre varios processos e o caminho carrega o numero da versao, que muda a cada
    // atualizacao. Casar por caminho quebraria sozinho na proxima.
    const texto = gerarPerfil(BASE);
    assert.match(texto, /^#@ws:AllowedApps = Discord$/m);
    assert.doesNotMatch(texto, /\.exe/i);
    assert.doesNotMatch(texto, /app-\d/);
});

test("varios apps entram separados por virgula", () => {
    const texto = gerarPerfil({ ...BASE, apps: ["Discord", "DiscordPTB"] });
    assert.match(texto, /^#@ws:AllowedApps = Discord, DiscordPTB$/m);
});

test("lista de apps vazia e recusada, nao tratada como 'todos'", () => {
    // Um `[]` que virasse linha vazia daria tunel de maquina inteira -- o modo de falha que
    // este arquivo existe para impedir.
    assert.throws(() => gerarPerfil({ ...BASE, apps: [] }), /vazia/);
});

test("campo com quebra de linha e recusado", () => {
    // Sem isso, um endpoint contaminado escreveria diretiva propria no perfil.
    assert.throws(() => gerarPerfil({ ...BASE, endpoint: "1.2.3.4:51820\nAllowedApps = " }),
        /endpoint tem caractere invalido/);
});

test("a mensagem de erro nunca mostra o valor do campo", () => {
    // Um dos campos e a chave privada. Erro que vaza valor vira credencial em log.
    const segredo = "NAOPODEAPARECER\n";
    try {
        gerarPerfil({ ...BASE, chavePrivada: segredo });
        assert.fail("deveria ter recusado");
    } catch (e) {
        assert.match(e.message, /chavePrivada/);
        assert.ok(!e.message.includes("NAOPODEAPARECER"), "o valor vazou na mensagem");
    }
});

test("MTU fora da faixa e recusado", () => {
    assert.throws(() => gerarPerfil({ ...BASE, mtu: 1600 }), /fora da faixa/);
    assert.throws(() => gerarPerfil({ ...BASE, mtu: 0 }), /fora da faixa/);
    assert.throws(() => gerarPerfil({ ...BASE, mtu: 1412.5 }), /fora da faixa/);
});

// ------------------------------------------------------------------------------------------

/** Um caminho dublado: passa tudo que couber no MTU dado. */
function caminhoDe(mtu) {
    return async carga => carga + CABECALHO_ICMP <= mtu;
}

test("acha o MTU do link PPPoE de casa, que e onde o 1420 fixo errava", () => {
    // 1492 e o numero real do link de teste. O perfil antigo dizia 1420, oito bytes grande
    // demais, e descartava pacote cheio de video sem aviso.
    return medirMtuDoCaminho(caminhoDe(1492)).then(m => {
        assert.equal(m, 1492);
        assert.equal(mtuDoTunel(m), 1412);
    });
});

test("caminho de 1500 devolve 1500 sem precisar procurar", async () => {
    let sondas = 0;
    const m = await medirMtuDoCaminho(async carga => { sondas++; return carga <= CARGA_MAXIMA; });
    assert.equal(m, 1500);
    assert.equal(sondas, 1, "o teto e testado primeiro, e resolve o caso comum numa sonda");
});

test("acerta nas bordas da faixa de busca", async () => {
    assert.equal(await medirMtuDoCaminho(caminhoDe(576)), 576);
    assert.equal(await medirMtuDoCaminho(caminhoDe(1499)), 1499);
    assert.equal(await medirMtuDoCaminho(caminhoDe(577)), 577);
});

test("caminho estreito demais devolve null, nunca um chute", async () => {
    // ICMP bloqueado, saida fora do ar, rede caida -- tudo chega aqui igual. Devolver um numero
    // seria repetir o erro do 1420 fixo, so que com mais confianca.
    assert.equal(await medirMtuDoCaminho(caminhoDe(500)), null);
    assert.equal(await medirMtuDoCaminho(async () => false), null);
});

test("a busca e binaria, nao linear", async () => {
    let sondas = 0;
    const caminho = caminhoDe(1300);
    await medirMtuDoCaminho(async c => { sondas++; return caminho(c); });
    assert.ok(sondas <= 12, `${sondas} sondas: a busca degradou para linear`);
});

test("tunel aninhado desconta a sobrecarga duas vezes", () => {
    // O WSL2 atras do WireSock. Custou uma noite inteira, atribuida a MSS e a WSLg antes de ser
    // o que era.
    assert.equal(mtuDoTunel(1492), 1492 - SOBRECARGA_WIREGUARD);
    assert.equal(mtuDoTunel(1492, true), 1492 - SOBRECARGA_WIREGUARD * 2);
});

// ------------------------------------------------------------------------------------------

test("o ping do Windows nao fragmenta", () => {
    const { exe, args } = comandoPing("159.112.151.37", 1464, "win32");
    assert.equal(exe, "ping");
    assert.ok(args.includes("-f"), "sem -f o ping fragmenta e a medicao devolve sempre o teto");
    assert.deepEqual(args.slice(args.indexOf("-l")), ["-l", "1464", "159.112.151.37"]);
});

test("o ping do Linux nao fragmenta", () => {
    const { args } = comandoPing("159.112.151.37", 1464, "linux");
    assert.deepEqual(args.slice(args.indexOf("-M")), ["-M", "do", "-s", "1464", "159.112.151.37"]);
});

test("o host do ping e validado antes de virar argumento", () => {
    assert.throws(() => comandoPing("1.2.3.4 && calc", 100, "win32"), /host/);
});

test("le o sucesso do ping, nao a mensagem de erro traduzida", () => {
    // Casar com "Packet needs to be fragmented" daria "cabe" em toda maquina em portugues.
    assert.equal(respostaChegou("Resposta de 159.112.151.37: bytes=1464 tempo=79ms TTL=52"), true);
    assert.equal(respostaChegou("1472 bytes from 159.112.151.37: icmp_seq=1 ttl=52 time=79 ms"), true);
    assert.equal(respostaChegou("Pacote necessita ser fragmentado, mas o sinalizador DF esta ativado."), false);
    assert.equal(respostaChegou("Packet needs to be fragmented but DF set."), false);
    assert.equal(respostaChegou("ping: local error: message too long"), false);
    assert.equal(respostaChegou(""), false);
});

test("a medicao pula o alvo que nao responde e diz por qual acabou passando", async () => {
    // O caso real: a VPS de Santiago nao responde echo -- o host aceita ICMP, a security list da
    // OCI e que descarta o tipo 8. O instalador nao pode travar por causa disso.
    const tentados = [];
    const r = await medirMtuComAlternativas(["159.112.151.37", "8.8.8.8"], alvo => {
        tentados.push(alvo);
        return alvo === "8.8.8.8" ? caminhoDe(1492) : async () => false;
    });
    assert.deepEqual(r, { mtu: 1492, alvo: "8.8.8.8" });
    assert.deepEqual(tentados, ["159.112.151.37", "8.8.8.8"]);
});

test("a medicao para no primeiro alvo que responde", async () => {
    const tentados = [];
    const r = await medirMtuComAlternativas(["a", "b"], alvo => {
        tentados.push(alvo);
        return caminhoDe(1492);
    });
    assert.equal(r.alvo, "a");
    assert.deepEqual(tentados, ["a"], "nao sondou o segundo alvo a toa");
});

test("nenhum alvo respondendo continua sendo null", async () => {
    assert.equal(await medirMtuComAlternativas(["a", "b"], () => async () => false), null);
    assert.equal(await medirMtuComAlternativas([], () => async () => true), null);
});

// --------------------------------------------------------------------------------------------
// Tunel em dois niveis
// --------------------------------------------------------------------------------------------

test("o perfil de controle difere do completo SO na linha AllowedIPs", () => {
    // Mesma chave, mesmo endereco, mesmo peer, mesmo AllowedApps. E isso que deixa o gateway do
    // Discord sobreviver a troca entre os dois (pesquisa, 12h). Qualquer outra diferenca -- um
    // AllowedApps esquecido, sobretudo -- e defeito.
    const completo = linhas(gerarPerfil(BASE));
    const controle = linhas(gerarPerfil({ ...BASE, destinos: FAIXA_CONTROLE }));
    assert.equal(completo.length, controle.length);
    const diferentes = completo.map((l, i) => [l, controle[i]]).filter(([a, b]) => a !== b);
    assert.deepEqual(diferentes, [["AllowedIPs = 0.0.0.0/0", `AllowedIPs = ${FAIXA_CONTROLE}`]]);
});

test("a faixa de controle leva o gateway do Discord e o DNS do perfil, e nao a rota padrao", () => {
    const faixas = FAIXA_CONTROLE.split(",").map(x => x.trim());
    assert.deepEqual(faixas, ["162.159.128.0/17", "1.1.1.1/32"]);
    assert.ok(!faixas.includes("0.0.0.0/0"), "com a rota padrao, o controle levaria a midia junto");
    // O DNS do perfil tem de estar dentro da faixa: resolver pelo Brasil devolve servidor
    // brasileiro (GeoDNS), mesmo com o gateway saindo pelo Chile.
    const dns = /^DNS = (.+)$/m.exec(gerarPerfil(BASE))[1];
    assert.ok(faixas.includes(`${dns}/32`), `o DNS ${dns} ficou fora da faixa de controle`);
});

test("o nome do perfil de controle e o do completo com -controle no fim", () => {
    assert.equal(perfilDeControle("streamfix-santiago"), "streamfix-santiago-controle");
});

// ---------------------------------------------------------------------------------------------
// O perfil do macOS: sem split por aplicativo
// ---------------------------------------------------------------------------------------------

test("no macOS o perfil sai sem a linha de AllowedApps", () => {
    // Emitir a linha nao quebraria nada -- o wg-quick ignora comentario -- e seria pior do que
    // inutil: o arquivo prometeria uma restricao que ninguem aplica.
    const texto = gerarPerfil({ ...BASE, semSplitPorApp: true });
    assert.equal(/AllowedApps/.test(texto), false);
    assert.equal(/WireSock extensions/.test(texto), false);
});

test("sem split por app, o AllowedIPs continua sendo a defesa -- e continua la", () => {
    const texto = gerarPerfil({ ...BASE, semSplitPorApp: true, destinos: FAIXA_CONTROLE });
    assert.match(texto, /^AllowedIPs = 162\.159\.128\.0\/17, 1\.1\.1\.1\/32$/m);
});

test("sem split por app, lista de apps vazia deixa de ser erro", () => {
    // No Windows uma lista vazia levaria a maquina inteira, e por isso e recusada. No macOS nao
    // existe split por aplicativo nenhum: a lista vazia nao significa "sem restricao", significa
    // "esta dimensao nao existe aqui".
    assert.doesNotThrow(() => gerarPerfil({ ...BASE, semSplitPorApp: true, apps: [] }));
    assert.throws(
        () => gerarPerfil({ ...BASE, apps: [] }),
        /levaria a maquina inteira/,
        "no Windows a recusa continua valendo"
    );
});

test("o perfil do macOS continua terminando em linha vazia", () => {
    // Nao e estetica: um arquivo sem quebra no fim ja custou uma noite em outros projetos, e o
    // teste e barato.
    assert.equal(gerarPerfil({ ...BASE, semSplitPorApp: true }).endsWith("\n"), true);
});

test("o padrao continua sendo COM split por app: so o macOS pede o contrario", () => {
    assert.match(gerarPerfil(BASE), /^#@ws:AllowedApps = Discord$/m);
});

// ---------------------------------------------------------------------------------------------
// O ping de cada sistema
//
// Tres pings diferentes, e nao dois. Custou uma instalacao inteira descobrir: na primeira
// tentativa num Mac, em 20/09, o provisionamento morreu em "nao consegui medir o MTU" porque o
// ping do macOS e BSD e nao entende as flags do GNU.
// ---------------------------------------------------------------------------------------------

test("o macOS tem o seu proprio ping, e nao o do Linux", () => {
    const mac = comandoPing("8.8.8.8", 1472, "darwin").args;

    // `-M do` NAO existe no ping do macOS: ele recusa a linha inteira, nenhum alvo responde, e a
    // medicao devolve null. O equivalente la e `-D`.
    assert.ok(!mac.includes("-M"), "-M nao existe no ping do macOS");
    assert.ok(mac.includes("-D"), "no macOS, nao-fragmentar e -D");

    // `-W` e em MILISSEGUNDOS no macOS e em SEGUNDOS no Linux. Um `-W 2` la e um prazo de dois
    // milissegundos -- curto demais para qualquer resposta, e sem erro nenhum para denunciar.
    assert.equal(mac[mac.indexOf("-W") + 1], "2000", "no macOS o -W e em milissegundos");
});

test("o Linux continua com as flags do GNU", () => {
    const linux = comandoPing("8.8.8.8", 1472, "linux").args;
    assert.ok(linux.includes("-M"), "no Linux, nao-fragmentar e -M do");
    assert.equal(linux[linux.indexOf("-M") + 1], "do");
    assert.equal(linux[linux.indexOf("-W") + 1], "2", "no Linux o -W e em segundos");
});

test("o Windows continua com as flags dele", () => {
    const win = comandoPing("8.8.8.8", 1472, "win32").args;
    assert.ok(win.includes("-f"), "no Windows, nao-fragmentar e -f");
    assert.ok(win.includes("-l"), "e a carga e -l");
});

test("os tres pedem UM pacote e dizem a carga", () => {
    // Errar isto faz a busca binaria medir outra coisa, e o erro aparece semanas depois como
    // "as vezes a stream trava".
    for (const [plataforma, flagConta, flagCarga] of [
        ["darwin", "-c", "-s"], ["linux", "-c", "-s"], ["win32", "-n", "-l"]
    ]) {
        const args = comandoPing("8.8.8.8", 1400, plataforma).args;
        assert.equal(args[args.indexOf(flagConta) + 1], "1", `${plataforma}: um pacote so`);
        assert.equal(args[args.indexOf(flagCarga) + 1], "1400", `${plataforma}: a carga pedida`);
        assert.equal(args[args.length - 1], "8.8.8.8", `${plataforma}: o host por ultimo`);
    }
});
