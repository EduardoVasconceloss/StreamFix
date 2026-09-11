/*
 * A administracao da saida: criar convites, revogar, e o resumo que quem administra le para
 * decidir alguma coisa.
 *
 * O que estes testes protegem e a operacao, nao o codigo: um convite sobrescrito zera os usos de
 * um que ja esta na rua, e um "revogar" que tira quem ja entrou faz alguem perder acesso sem
 * ninguem ter pedido.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    adotarPeer,
    criarConvite,
    registrar,
    remover,
    resumo,
    revogarConvite,
    USOS_MAXIMOS
} = require("../provisionamento/registro.ts");

const CHAVE_A = "qYzFLmUhB5CePWPBfKMwuTQUdnVfKUasGfDRt2/hDgU=";
const CHAVE_B = "FENQCWc1SIGhue4yCVlT5drtpL01hmH0fIrlyMlDtkI=";
const AGORA = "2026-09-11T00:00:00.000Z";

function estadoNovo() {
    return {
        faixa: "10.8.0.0/24",
        enderecoServidor: "10.8.0.1",
        saida: { chavePublica: "aWc4Tm9kZUtleUZha2VGYWtlRmFrZUZha2VGYWtlMTI=", endpoint: "1.2.3.4:39743" },
        convites: [],
        peers: []
    };
}

function comConvite(usos = 1, codigo = "CONVITE-DE-TESTE-0001") {
    const r = criarConvite(estadoNovo(), codigo, usos);
    assert.ok(r.ok, r.motivo);
    return r.estado;
}

test("criar um convite devolve estado novo, sem mexer no antigo", () => {
    const antes = estadoNovo();
    const r = criarConvite(antes, "CONVITE-DE-TESTE-0001", 3);

    assert.equal(r.ok, true);
    assert.equal(r.convite.usados, 0);
    assert.equal(r.convite.usos, 3);
    assert.equal(antes.convites.length, 0, "o estado de entrada nao pode ser alterado");
});

test("codigo repetido e recusado, nunca sobrescrito", () => {
    // Sobrescrever zeraria os usos de um convite que ja esta na rua -- e quem administra so
    // descobriria depois, com gente entrando por um convite que ele achava esgotado.
    const estado = comConvite(1);
    const r = criarConvite(estado, "CONVITE-DE-TESTE-0001", 9);

    assert.equal(r.ok, false);
    assert.match(r.motivo, /ja existe/);
});

test("codigo curto demais e recusado", () => {
    // O registro compara o codigo direto. O tamanho e a defesa contra adivinhacao.
    assert.equal(criarConvite(estadoNovo(), "abc", 1).ok, false);
    assert.equal(criarConvite(estadoNovo(), "12345678", 1).ok, true);
});

test("codigo com espaco na ponta e recusado", () => {
    // Espaco sobrevive a um copiar-e-colar e depois nao casa com nada, e a pessoa fica olhando
    // para um convite que "existe" e nao funciona.
    const r = criarConvite(estadoNovo(), " CONVITE-DE-TESTE-01 ", 1);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /espaco/);
});

test("usos tem que ser inteiro dentro do limite", () => {
    for (const usos of [0, -1, 1.5, USOS_MAXIMOS + 1, "2", NaN]) {
        assert.equal(criarConvite(estadoNovo(), "CONVITE-DE-TESTE-0001", usos).ok, false, `usos=${usos}`);
    }
    assert.equal(criarConvite(estadoNovo(), "CONVITE-DE-TESTE-0001", USOS_MAXIMOS).ok, true);
});

test("revogar fecha a porta para quem ainda nao entrou", () => {
    const estado = comConvite(5);
    const novo = revogarConvite(estado, "CONVITE-DE-TESTE-0001");

    const r = registrar(novo, { convite: "CONVITE-DE-TESTE-0001", chavePublica: CHAVE_A }, AGORA);
    assert.equal(r.ok, false);
    assert.equal(r.codigo, "convite_revogado");
});

test("revogar NAO tira quem ja entrou", () => {
    // Tirar alguem e outra operacao, de proposito: revogar um convite usado por cinco pessoas
    // por causa de uma delas nao pode derrubar as outras quatro.
    let estado = comConvite(5);
    const entrada = registrar(estado, { convite: "CONVITE-DE-TESTE-0001", chavePublica: CHAVE_A }, AGORA);
    assert.equal(entrada.ok, true);
    estado = revogarConvite(entrada.estado, "CONVITE-DE-TESTE-0001");

    assert.equal(estado.peers.length, 1);
    assert.equal(estado.peers[0].publica, CHAVE_A);
});

test("revogar um convite que nao existe devolve null, nao estado corrompido", () => {
    assert.equal(revogarConvite(estadoNovo(), "NAO-EXISTE-ESSE-CODIGO"), null);
});

test("revogar duas vezes e inofensivo", () => {
    const estado = comConvite(2);
    const uma = revogarConvite(estado, "CONVITE-DE-TESTE-0001");
    const duas = revogarConvite(uma, "CONVITE-DE-TESTE-0001");
    assert.deepEqual(duas, uma);
});

test("o resumo conta os enderecos livres sem contar o do servidor", () => {
    // /24 tem 254 utilizaveis; o servidor fica com um.
    const r = resumo(estadoNovo());
    assert.equal(r.faixa, "10.8.0.0/24");
    assert.equal(r.enderecosLivres, 253);
});

test("o resumo desconta quem entrou, e devolve o endereco de quem sai", () => {
    let estado = comConvite(5);
    estado = registrar(estado, { convite: "CONVITE-DE-TESTE-0001", chavePublica: CHAVE_A }, AGORA).estado;
    estado = registrar(estado, { convite: "CONVITE-DE-TESTE-0001", chavePublica: CHAVE_B }, AGORA).estado;
    assert.equal(resumo(estado).enderecosLivres, 251);

    estado = remover(estado, CHAVE_A);
    assert.equal(resumo(estado).enderecosLivres, 252);
});

test("o resumo diz quantos usos restam, e zera o de um revogado", () => {
    let estado = comConvite(3);
    estado = registrar(estado, { convite: "CONVITE-DE-TESTE-0001", chavePublica: CHAVE_A }, AGORA).estado;
    assert.equal(resumo(estado).convites[0].restam, 2);

    estado = revogarConvite(estado, "CONVITE-DE-TESTE-0001");
    assert.equal(resumo(estado).convites[0].restam, 0, "revogado nao tem uso restante");
});

test("o resumo nao deixa mexer no estado por tabela", () => {
    const estado = comConvite(1);
    const r = resumo(estado);
    r.peers.push({ publica: "invasor", endereco: "10.8.0.99", convite: "x", criadoEm: AGORA });
    assert.equal(estado.peers.length, 0);
});

// ------------------------------------------------------------------------- adotar quem ja estava

test("adotar um peer que ja existia no wg0 nao gasta convite", () => {
    // Quem monta a saida a mao primeiro e so depois automatiza -- que e o caminho normal --
    // chega aqui com gente ja conectada. Sem adotar, o provisionador entregaria o endereco
    // dessa gente para outra pessoa e derrubaria quem estava la.
    const r = adotarPeer(estadoNovo(), CHAVE_A, "10.8.0.2", AGORA);

    assert.equal(r.ok, true);
    assert.equal(r.estado.peers.length, 1);
    assert.equal(r.estado.peers[0].endereco, "10.8.0.2");
    assert.equal(r.estado.convites.length, 0, "nao inventa convite");
});

test("o endereco adotado sai da lista de livres", () => {
    const r = adotarPeer(estadoNovo(), CHAVE_A, "10.8.0.2", AGORA);
    const depois = registrar(
        criarConvite(r.estado, "CONVITE-DE-TESTE-0001", 1).estado,
        { convite: "CONVITE-DE-TESTE-0001", chavePublica: CHAVE_B },
        AGORA
    );
    assert.equal(depois.ok, true);
    assert.notEqual(depois.peerNovo.endereco, "10.8.0.2", "entregou o endereco de quem ja estava");
    assert.equal(depois.peerNovo.endereco, "10.8.0.3");
});

test("aceita com mascara, porque e como o wg mostra", () => {
    const r = adotarPeer(estadoNovo(), CHAVE_A, "10.8.0.2/32", AGORA);
    assert.equal(r.ok, true);
    assert.equal(r.estado.peers[0].endereco, "10.8.0.2", "a mascara nao entra no estado");
});

test("recusa o endereco do proprio servidor", () => {
    const r = adotarPeer(estadoNovo(), CHAVE_A, "10.8.0.1", AGORA);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /proprio servidor/);
});

test("recusa endereco ja ocupado, e chave ja conhecida", () => {
    const comA = adotarPeer(estadoNovo(), CHAVE_A, "10.8.0.2", AGORA).estado;
    assert.match(adotarPeer(comA, CHAVE_B, "10.8.0.2", AGORA).motivo, /ja esta com outra/);
    assert.match(adotarPeer(comA, CHAVE_A, "10.8.0.9", AGORA).motivo, /ja esta no estado/);
});

test("recusa endereco fora da faixa e chave fora do formato", () => {
    assert.match(adotarPeer(estadoNovo(), CHAVE_A, "192.168.1.5", AGORA).motivo, /fora da faixa/);
    assert.match(adotarPeer(estadoNovo(), CHAVE_A, "nao-e-ip", AGORA).motivo, /invalido/);
    assert.match(adotarPeer(estadoNovo(), "chave-torta", "10.8.0.2", AGORA).motivo, /formato WireGuard/);
});
