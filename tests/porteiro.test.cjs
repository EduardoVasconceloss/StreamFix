/*
 * Testes do porteiro.
 *
 * O teste que carrega a fase e "endereco errado bloqueia, mesmo com o CLI jurando que esta de
 * pe". Ele guarda a licao que custou mais caro neste projeto: componente que diz "conectado"
 * nao prova nada sobre por onde a midia sai.
 *
 * O irmao dele -- "os dois precisam concordar para liberar" -- guarda a licao oposta, que custou
 * uma medicao em 11/09: o `localAddress` concordar tambem nao prova nada, porque ele envelhece.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { decidir, aviso, hostDoEndpoint } = require("../streamFix/tunnel/porteiro.ts");

const SAIDA = "159.112.151.37";
const BRASIL = "177.42.223.136";

function situacao(extra = {}) {
    return { tunel: "conectado", localAddress: SAIDA, saidaEsperada: SAIDA, exigirTunel: true, ...extra };
}

// --------------------------------------------------------------------------------------------
// O endereco da saida
// --------------------------------------------------------------------------------------------

test("tira a porta do endpoint", () => {
    assert.equal(hostDoEndpoint("159.112.151.37:39743"), SAIDA);
    assert.equal(hostDoEndpoint("saida.exemplo.com:51820"), "saida.exemplo.com");
    assert.equal(hostDoEndpoint(SAIDA), SAIDA);
});

test("endpoint ausente nao vira host vazio", () => {
    for (const ruim of [null, undefined, "", ":51820"]) {
        assert.equal(hostDoEndpoint(ruim), null, String(ruim));
    }
});

// --------------------------------------------------------------------------------------------
// Quem manda
// --------------------------------------------------------------------------------------------

test("libera quando o Discord confirma que a midia sai pela saida", () => {
    assert.deepEqual(decidir(situacao()), { ok: true, nota: null });
});

test("endereco errado bloqueia, mesmo com o CLI jurando que esta de pe", () => {
    // A licao que custou mais caro: componente que diz "conectado" nao prova nada sobre por onde
    // a midia sai. Foi o `localAddress` que provou Santiago em 12d.
    const cliMentindo = decidir(situacao({ tunel: "conectado", localAddress: BRASIL }));
    assert.equal(cliMentindo.ok, false, "o CLI disse conectado e a midia sai pelo Brasil");
    assert.match(cliMentindo.motivo, new RegExp(BRASIL.replace(/\./g, "\\.")));
});

test("os dois precisam concordar para liberar: o localAddress envelhece", () => {
    // Medido em 11/09, derrubando o tunel com uma call no ar: o ping do Discord caiu de 131 ms
    // para 33 ms -- a midia passou a sair direto, pelo Brasil -- e o `localAddress` continuou
    // reportando o endereco da saida pelos 6 segundos inteiros da medicao.
    //
    // Uma versao que confiasse so nele liberaria exatamente o caso que este porteiro existe para
    // pegar: entrar na call com o tunel de pe, o tunel cair, e clicar em Go Live em seguida.
    const tunelCaiu = decidir(situacao({ tunel: "fora", localAddress: SAIDA }));
    assert.equal(tunelCaiu.ok, false, "leitura velha nao pode liberar com o tunel fora");
    assert.match(tunelCaiu.motivo, /nao esta de pe/);

    const semSaberDoTunel = decidir(situacao({ tunel: "desconhecido", localAddress: SAIDA }));
    assert.equal(semSaberDoTunel.ok, false, "sem confirmacao do CLI, a leitura velha nao basta");

    const osDoisConcordam = decidir(situacao({ tunel: "conectado", localAddress: SAIDA }));
    assert.deepEqual(osDoisConcordam, { ok: true, nota: null });
});

test("o endereco procurado e o PUBLICO da saida, nao o interno do tunel", () => {
    // Medido em 11/09: com o tunel de pe, o `localAddress` vale 159.112.151.37, o IP da VPS --
    // nao 10.8.0.2. Uma versao que procurasse a faixa interna recusaria toda transmissao boa.
    assert.equal(decidir(situacao({ localAddress: "10.8.0.2" })).ok, false);
    assert.equal(decidir(situacao({ localAddress: SAIDA })).ok, true);
});

test("o motivo diz por onde a midia esta saindo e o que fazer", () => {
    const r = decidir(situacao({ localAddress: BRASIL }));
    assert.match(r.motivo, /saindo por 177\.42\.223\.136/);
    assert.match(r.motivo, /159\.112\.151\.37/);
    assert.match(r.motivo, /Suba o tunel/);
});

// --------------------------------------------------------------------------------------------
// Quando o Discord nao tem o que dizer
// --------------------------------------------------------------------------------------------

test("sem leitura do Discord, o CLI decide", () => {
    // Acontece nos segundos em que a conexao de voz ainda esta subindo.
    const ok = decidir(situacao({ localAddress: null, tunel: "conectado" }));
    assert.equal(ok.ok, true);
    assert.match(ok.nota, /ainda nao reportou/);

    assert.equal(decidir(situacao({ localAddress: null, tunel: "fora" })).ok, false);
});

test("localAddress vazio conta como ausente, nao como endereco diferente", () => {
    for (const vazio of [null, undefined, ""]) {
        assert.equal(decidir(situacao({ localAddress: vazio, tunel: "conectado" })).ok, true, String(vazio));
        assert.equal(decidir(situacao({ localAddress: vazio, tunel: "fora" })).ok, false, String(vazio));
    }
});

test("CLI mudo bloqueia: nao saber nao e o mesmo que estar tudo bem", () => {
    const r = decidir(situacao({ localAddress: null, tunel: "desconhecido" }));
    assert.equal(r.ok, false);
    assert.match(r.motivo, /instalado por completo/);
});

test("sem saida configurada, o porteiro cai no CLI em vez de travar", () => {
    // D8: a saida e parametro. Quem aponta para a propria saida pode nao ter o endereco a mao.
    const r = decidir(situacao({ saidaEsperada: null, tunel: "conectado" }));
    assert.equal(r.ok, true);
    assert.match(r.nota, /nao ha saida configurada/);

    assert.equal(decidir(situacao({ saidaEsperada: null, tunel: "fora" })).ok, false);
});

test("o porteiro desligado libera tudo, inclusive o caso ruim", () => {
    const r = decidir(situacao({ exigirTunel: false, tunel: "fora", localAddress: BRASIL }));
    assert.equal(r.ok, true);
    assert.match(r.nota, /porteiro desligado/);
});

test("o motivo do bloqueio nunca e vazio: a pessoa precisa saber o que houve", () => {
    const bloqueios = [
        situacao({ localAddress: BRASIL }),
        situacao({ localAddress: null, tunel: "fora" }),
        situacao({ localAddress: null, tunel: "desconhecido" }),
    ];
    for (const s of bloqueios) {
        const r = decidir(s);
        assert.equal(r.ok, false);
        assert.ok(r.motivo.length > 30, `motivo curto demais: ${r.motivo}`);
    }
});

// --------------------------------------------------------------------------------------------
// O aviso do monitor
// --------------------------------------------------------------------------------------------

test("transmissao saudavel nao gera aviso nenhum", () => {
    assert.equal(aviso({ estado: "saudavel", motivo: "entregando" }), null);
    assert.equal(aviso(undefined), null);
    assert.equal(aviso({}), null);
});

test("a causa muda a frase, porque muda o que adianta fazer", () => {
    // Dizer a frase errada manda a pessoa para o lado oposto do conserto.
    const entrega = aviso({ estado: "quebrado", causa: "entrega" });
    assert.match(entrega, /comece de novo/);

    const captura = aviso({ estado: "quebrado", causa: "captura" });
    assert.match(captura, /nao vai resolver/);
    assert.doesNotMatch(captura, /comece de novo/);
});

test("quebrado sem causa avisa como entrega, que e o caso comum", () => {
    assert.match(aviso({ estado: "quebrado" }), /comece de novo/);
});
