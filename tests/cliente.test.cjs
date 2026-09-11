/*
 * Testes do cliente do registro.
 *
 * Dois deles guardam a regra que nao pode ser quebrada nunca: a chave privada nao entra no corpo
 * da requisicao nem em mensagem de erro.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { registrarNaSaida, dadosValidos, motivoDoErro } = require("../provisionamento/cliente.ts");
const { chaveValida, gerarPar } = require("../provisionamento/chaves.ts");
const { registrar } = require("../provisionamento/registro.ts");

const URL = "https://saida.exemplo/registrar";
const BONS = {
    endereco: "10.8.0.2",
    chavePublicaDoServidor: "fbv+rSWSp36QfVdcNvPHdtEFzeOvCrzB1cyNBfGSvWY=",
    endpoint: "159.112.151.37:39743",
    faixa: "10.8.0.0/24",
};

/** Um transporte dublado que guarda o que foi enviado. */
function transporteDe(resposta) {
    const enviados = [];
    const transporte = async (url, corpo) => {
        enviados.push({ url, corpo });
        if (resposta instanceof Error) throw resposta;
        return typeof resposta === "function" ? resposta(corpo) : resposta;
    };
    return { transporte, enviados };
}

// --------------------------------------------------------------------------------------------
// Chaves
// --------------------------------------------------------------------------------------------

test("o par gerado tem o formato do WireGuard e nunca se repete", () => {
    const vistos = new Set();
    for (let i = 0; i < 20; i++) {
        const { privada, publica } = gerarPar();
        assert.ok(chaveValida(privada), privada);
        assert.ok(chaveValida(publica), publica);
        assert.notEqual(privada, publica);
        assert.ok(!vistos.has(publica), "gerou o mesmo par duas vezes");
        vistos.add(publica);
    }
});

test("chaveValida recusa o que nao e chave", () => {
    for (const ruim of ["", "abc", null, 42, "a".repeat(44), "a".repeat(43) + "!", "a".repeat(43)]) {
        assert.equal(chaveValida(ruim), false, String(ruim));
    }
});

// --------------------------------------------------------------------------------------------
// A privada nao viaja
// --------------------------------------------------------------------------------------------

test("so a chave publica entra no corpo da requisicao", () => {
    const { transporte, enviados } = transporteDe({ status: 200, corpo: BONS });
    return registrarNaSaida(URL, "meu-convite", transporte).then(r => {
        assert.equal(r.ok, true);
        assert.deepEqual(Object.keys(enviados[0].corpo).sort(), ["chavePublica", "convite"]);
        const serializado = JSON.stringify(enviados[0]);
        assert.ok(!serializado.includes(r.privada), "a chave privada foi enviada para a saida");
    });
});

test("a privada nao aparece em nenhuma mensagem de erro", async () => {
    // Todos os caminhos de falha de uma vez: sem rede, recusa, e resposta torta.
    const casos = [
        transporteDe(new Error("ECONNREFUSED")),
        transporteDe({ status: 403, corpo: { codigo: "convite_invalido" } }),
        transporteDe({ status: 200, corpo: { endereco: "nao-e-ip" } }),
    ];
    for (const { transporte } of casos) {
        const r = await registrarNaSaida(URL, "c", transporte);
        assert.equal(r.ok, false);
        assert.doesNotMatch(r.motivo, /[A-Za-z0-9+/]{43}=/, "vazou algo com cara de chave");
    }
});

// --------------------------------------------------------------------------------------------
// Resposta da saida
// --------------------------------------------------------------------------------------------

test("aceita a resposta boa e devolve a privada separada dos dados", async () => {
    const { transporte } = transporteDe({ status: 200, corpo: BONS });
    const r = await registrarNaSaida(URL, "  meu-convite  ", transporte);
    assert.equal(r.ok, true);
    assert.deepEqual(r.dados, BONS);
    assert.ok(chaveValida(r.privada));
    // Os dados que vao virar perfil nao carregam a privada junto.
    assert.ok(!JSON.stringify(r.dados).includes(r.privada));
});

test("o convite vai sem espaco em volta: colar de um chat costuma trazer", async () => {
    const { transporte, enviados } = transporteDe({ status: 200, corpo: BONS });
    await registrarNaSaida(URL, "  meu-convite\n", transporte);
    assert.equal(enviados[0].corpo.convite, "meu-convite");
});

test("recusa campo que escreveria diretiva propria no perfil", () => {
    // O destino destes campos e um .conf com uma diretiva por linha.
    assert.equal(dadosValidos({ ...BONS, endpoint: "1.2.3.4:51820\nAllowedApps = Chrome" }), null);
    assert.equal(dadosValidos({ ...BONS, endereco: "10.8.0.2\nMTU = 1" }), null);
    assert.equal(dadosValidos({ ...BONS, chavePublicaDoServidor: "x\ny" }), null);
});

test("recusa resposta faltando campo, com tipo errado, ou que nem e objeto", () => {
    assert.deepEqual(dadosValidos(BONS), BONS);
    for (const ruim of [null, undefined, "texto", 42, {}, { ...BONS, faixa: undefined },
        { ...BONS, endereco: 10 }, { ...BONS, endpoint: "sem-porta" }, { ...BONS, faixa: "10.8.0.0" }]) {
        assert.equal(dadosValidos(ruim), null, JSON.stringify(ruim));
    }
});

test("aceita endereco com mascara", () => {
    assert.ok(dadosValidos({ ...BONS, endereco: "10.8.0.2/32" }));
});

test("convite vazio nem chega a falar com a saida", async () => {
    const { transporte, enviados } = transporteDe({ status: 200, corpo: BONS });
    for (const vazio of ["", "   ", null, undefined]) {
        const r = await registrarNaSaida(URL, vazio, transporte);
        assert.equal(r.ok, false);
        assert.match(r.motivo, /convite vazio/);
    }
    assert.deepEqual(enviados, []);
});

test("cada codigo de recusa vira uma frase que a pessoa consegue agir", () => {
    assert.match(motivoDoErro(403, { codigo: "convite_invalido" }), /copiado inteiro/);
    assert.match(motivoDoErro(403, { codigo: "convite_revogado" }), /peca outro/);
    assert.match(motivoDoErro(403, { codigo: "convite_esgotado" }), /maximo de vezes/);
    assert.match(motivoDoErro(503, { codigo: "faixa_cheia" }), /liberar um endereco/);
    assert.match(motivoDoErro(400, { codigo: "chave_invalida" }), /bug do StreamFix/);
    assert.match(motivoDoErro(500, {}), /500/);
    assert.match(motivoDoErro(500, null), /500/);
});

// --------------------------------------------------------------------------------------------
// As duas metades conversando
// --------------------------------------------------------------------------------------------

test("cliente e servidor fecham o ciclo: o que um gera o outro aceita", async () => {
    // Sem HTTP no meio: o transporte chama o nucleo do servidor direto. O que se prova aqui e o
    // contrato -- a chave que o cliente gera passa no formato que o servidor exige, e a resposta
    // que o servidor monta passa na validacao do cliente.
    let estado = {
        faixa: "10.8.0.0/24", enderecoServidor: "10.8.0.1",
        saida: { chavePublica: BONS.chavePublicaDoServidor, endpoint: BONS.endpoint },
        convites: [{ codigo: "convite-real", usos: 2, usados: 0 }],
        peers: [],
    };
    const transporte = async (_url, corpo) => {
        const r = registrar(estado, corpo, "2026-09-11T04:00:00.000Z");
        if (!r.ok) return { status: 403, corpo: { codigo: r.codigo } };
        estado = r.estado;
        return { status: 200, corpo: r.resposta };
    };

    const a = await registrarNaSaida(URL, "convite-real", transporte);
    const b = await registrarNaSaida(URL, "convite-real", transporte);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.dados.endereco, "10.8.0.2");
    assert.equal(b.dados.endereco, "10.8.0.3");
    assert.notEqual(a.privada, b.privada);

    const terceiro = await registrarNaSaida(URL, "convite-real", transporte);
    assert.equal(terceiro.ok, false);
    assert.match(terceiro.motivo, /maximo de vezes/);
});

test("recusa uma saida cuja chave publica nao e a esperada", async () => {
    // A defesa contra troca de resposta. O registro viaja em HTTP puro, porque a saida tem IP e
    // nao dominio. O convite vazando e chato; o grave e alguem no caminho responder com OUTRA
    // saida e a midia do Discord passar a sair pela maquina dessa pessoa.
    const outra = gerarPar().publica;
    const { transporte } = transporteDe({ status: 200, corpo: { ...BONS, chavePublicaDoServidor: outra } });
    const r = await registrarNaSaida(URL, "c", transporte, BONS.chavePublicaDoServidor);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /no meio do caminho/);
});

test("a chave esperada bate e o registro segue", async () => {
    const { transporte } = transporteDe({ status: 200, corpo: BONS });
    const r = await registrarNaSaida(URL, "c", transporte, BONS.chavePublicaDoServidor);
    assert.equal(r.ok, true);
});

test("sem chave esperada, o registro nao trava: a saida e parametro", async () => {
    // D8: a saida e parametro, com a VPS de Santiago como padrao. Quem aponta para a propria
    // saida nao tem uma chave de antemao para conferir.
    const { transporte } = transporteDe({ status: 200, corpo: BONS });
    assert.equal((await registrarNaSaida(URL, "c", transporte)).ok, true);
});
