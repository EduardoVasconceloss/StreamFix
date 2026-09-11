/*
 * Testes do nucleo do provisionador.
 *
 * Dois deles cobrem o que o plano marcou como facil de esquecer: dois registros seguidos nunca
 * recebem o mesmo endereco, e a faixa cheia recusa em vez de entregar lixo.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    registrar, remover, proximoEndereco, enderecosDaFaixa, paraNumero, paraIp, blocoDoPeer,
} = require("../provisionamento/registro.ts");
const { gerarPar } = require("../provisionamento/chaves.ts");

const AGORA = "2026-09-11T04:00:00.000Z";

function estadoDe(extra = {}) {
    return {
        faixa: "10.8.0.0/24",
        enderecoServidor: "10.8.0.1",
        saida: { chavePublica: "fbv+rSWSp36QfVdcNvPHdtEFzeOvCrzB1cyNBfGSvWY=", endpoint: "159.112.151.37:39743" },
        convites: [{ codigo: "convite-de-teste-longo", usos: 3, usados: 0 }],
        peers: [],
        ...extra,
    };
}

const chave = () => gerarPar().publica;

// --------------------------------------------------------------------------------------------
// Enderecos
// --------------------------------------------------------------------------------------------

test("converte IP para numero e de volta", () => {
    assert.equal(paraNumero("10.8.0.1"), 10 * 2 ** 24 + 8 * 2 ** 16 + 1);
    assert.equal(paraIp(paraNumero("255.255.255.255")), "255.255.255.255");
    assert.equal(paraIp(paraNumero("0.0.0.0")), "0.0.0.0");
});

test("recusa IP malformado em vez de inventar um numero", () => {
    for (const ruim of ["10.8.0", "10.8.0.256", "10.8.0.a", "", "10.08.0.1.2", "nao-e-ip"]) {
        assert.equal(paraNumero(ruim), null, ruim);
    }
});

test("a faixa exclui rede e broadcast", () => {
    const e = enderecosDaFaixa("10.8.0.0/24");
    assert.equal(e.length, 254);
    assert.equal(paraIp(e[0]), "10.8.0.1");
    assert.equal(paraIp(e[e.length - 1]), "10.8.0.254");
});

test("faixa que nao comporta ninguem devolve lista vazia, nao endereco invalido", () => {
    assert.deepEqual(enderecosDaFaixa("10.8.0.1/32"), []);
    assert.deepEqual(enderecosDaFaixa("10.8.0.0/31"), []);
    assert.deepEqual(enderecosDaFaixa("nao-e-faixa"), []);
    assert.deepEqual(enderecosDaFaixa("10.8.0.0/33"), []);
});

test("o endereco do servidor nunca e entregue a ninguem", () => {
    assert.equal(proximoEndereco(estadoDe()), "10.8.0.2");
});

// --------------------------------------------------------------------------------------------
// Registro
// --------------------------------------------------------------------------------------------

test("registra e devolve os dados da saida", () => {
    const r = registrar(estadoDe(), { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA);
    assert.equal(r.ok, true);
    assert.deepEqual(r.resposta, {
        endereco: "10.8.0.2",
        chavePublicaDoServidor: "fbv+rSWSp36QfVdcNvPHdtEFzeOvCrzB1cyNBfGSvWY=",
        endpoint: "159.112.151.37:39743",
        faixa: "10.8.0.0/24",
    });
    assert.equal(r.estado.convites[0].usados, 1);
    assert.equal(r.peerNovo.endereco, "10.8.0.2");
});

test("registrar nao altera o estado que recebeu", () => {
    const antes = estadoDe();
    registrar(antes, { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA);
    assert.deepEqual(antes.peers, []);
    assert.equal(antes.convites[0].usados, 0);
});

test("dois registros seguidos NUNCA recebem o mesmo endereco", () => {
    // O que o plano marcou como facil de esquecer. A garantia vem de `registrar` ser sincrona e
    // devolver estado novo: o segundo so decide depois que o primeiro devolveu.
    let e = estadoDe();
    const vistos = new Set();
    for (let i = 0; i < 3; i++) {
        const r = registrar(e, { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA);
        assert.equal(r.ok, true);
        assert.ok(!vistos.has(r.resposta.endereco), `endereco repetido: ${r.resposta.endereco}`);
        vistos.add(r.resposta.endereco);
        e = r.estado;
    }
    assert.deepEqual([...vistos], ["10.8.0.2", "10.8.0.3", "10.8.0.4"]);
});

test("registrar a mesma chave de novo devolve o mesmo endereco e nao gasta nada", () => {
    // Reinstalar e comum. Sem isto, a faixa encolheria a cada reinstalacao de alguem, e o
    // convite se esgotaria com uma pessoa so.
    const k = chave();
    const r1 = registrar(estadoDe(), { convite: "convite-de-teste-longo", chavePublica: k }, AGORA);
    const r2 = registrar(r1.estado, { convite: "convite-de-teste-longo", chavePublica: k }, AGORA);
    assert.equal(r2.ok, true);
    assert.equal(r2.resposta.endereco, r1.resposta.endereco);
    assert.equal(r2.estado.convites[0].usados, 1, "gastou um uso de convite a toa");
    assert.equal(r2.estado.peers.length, 1);
    assert.equal(r2.peerNovo, null, "o servidor nao precisa mexer na interface");
});

test("a chave repetida vale mesmo com convite invalido: quem ja entrou, entrou", () => {
    const k = chave();
    const r1 = registrar(estadoDe(), { convite: "convite-de-teste-longo", chavePublica: k }, AGORA);
    const r2 = registrar(r1.estado, { convite: "nao-existe", chavePublica: k }, AGORA);
    assert.equal(r2.ok, true);
});

test("recusa chave publica malformada", () => {
    for (const ruim of ["", "abc", null, 42, "a".repeat(44), chave().slice(0, -1) + "!"]) {
        const r = registrar(estadoDe(), { convite: "convite-de-teste-longo", chavePublica: ruim }, AGORA);
        assert.equal(r.ok, false, String(ruim));
        assert.equal(r.codigo, "chave_invalida");
    }
});

test("a chave e conferida antes do convite: nao vaza se o convite existe", () => {
    // Quem manda lixo nos dois campos recebe "chave invalida". Responder "convite invalido"
    // primeiro transformaria o endpoint num oraculo de convites.
    const r = registrar(estadoDe(), { convite: "chute", chavePublica: "lixo" }, AGORA);
    assert.equal(r.codigo, "chave_invalida");
});

test("recusa convite que nao existe", () => {
    const r = registrar(estadoDe(), { convite: "nao-existe", chavePublica: chave() }, AGORA);
    assert.equal(r.codigo, "convite_invalido");
});

test("recusa convite ausente ou de tipo errado", () => {
    for (const ruim of [undefined, null, 42, {}]) {
        assert.equal(registrar(estadoDe(), { convite: ruim, chavePublica: chave() }, AGORA).codigo,
            "convite_invalido", String(ruim));
    }
});

test("recusa convite esgotado", () => {
    const e = estadoDe({ convites: [{ codigo: "c", usos: 1, usados: 1 }] });
    assert.equal(registrar(e, { convite: "c", chavePublica: chave() }, AGORA).codigo, "convite_esgotado");
});

test("recusa convite revogado", () => {
    const e = estadoDe({ convites: [{ codigo: "c", usos: 5, usados: 0, revogado: true }] });
    assert.equal(registrar(e, { convite: "c", chavePublica: chave() }, AGORA).codigo, "convite_revogado");
});

test("revogar um convite nao mexe em quem ja entrou", () => {
    const r1 = registrar(estadoDe(), { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA);
    const revogado = { ...r1.estado, convites: r1.estado.convites.map(c => ({ ...c, revogado: true })) };
    assert.equal(revogado.peers.length, 1, "o peer continua la");
    assert.equal(registrar(revogado, { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA).codigo,
        "convite_revogado");
});

test("recusa quando a faixa enche, em vez de entregar endereco invalido", () => {
    // /29: 6 atribuiveis, menos o servidor, sobram 5.
    let e = estadoDe({
        faixa: "10.8.0.0/29", enderecoServidor: "10.8.0.1",
        convites: [{ codigo: "c", usos: 99, usados: 0 }],
    });
    for (let i = 0; i < 5; i++) {
        const r = registrar(e, { convite: "c", chavePublica: chave() }, AGORA);
        assert.equal(r.ok, true, `entrada ${i}`);
        e = r.estado;
    }
    const cheio = registrar(e, { convite: "c", chavePublica: chave() }, AGORA);
    assert.equal(cheio.codigo, "faixa_cheia");
    assert.match(cheio.erro, /10\.8\.0\.0\/29/);
});

test("o endereco liberado por uma remocao e reaproveitado", () => {
    const k = chave();
    let e = registrar(estadoDe(), { convite: "convite-de-teste-longo", chavePublica: k }, AGORA).estado;
    e = registrar(e, { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA).estado;
    e = remover(e, k);
    assert.equal(e.peers.length, 1);
    assert.equal(registrar(e, { convite: "convite-de-teste-longo", chavePublica: chave() }, AGORA)
        .resposta.endereco, "10.8.0.2");
});

test("remover quem nao existe devolve null, nao estado corrompido", () => {
    assert.equal(remover(estadoDe(), chave()), null);
});

// --------------------------------------------------------------------------------------------
// Saida para o wg0.conf
// --------------------------------------------------------------------------------------------

test("o bloco do peer restringe cada pessoa ao proprio endereco", () => {
    // `/32` e o que impede uma pessoa de alcancar as outras pela saida.
    const k = chave();
    const bloco = blocoDoPeer({ publica: k, endereco: "10.8.0.7", convite: "c", criadoEm: AGORA });
    assert.match(bloco, /^\[Peer\]$/m);
    assert.match(bloco, new RegExp(`^PublicKey = ${k.replace(/[+/=]/g, "\\$&")}$`, "m"));
    assert.match(bloco, /^AllowedIPs = 10\.8\.0\.7\/32$/m);
    assert.doesNotMatch(bloco, /0\.0\.0\.0\/0/, "faixa aberta deixaria uma pessoa alcancar as outras");
});
