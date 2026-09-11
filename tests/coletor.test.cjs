/*
 * Testes do coletor: a traducao entre o que o Discord expoe e o que o monitor entende.
 *
 * As fixtures gravadas sao a especificacao desta unidade -- elas foram capturadas com a mesma
 * extracao, por tests/fixtures/capture.mjs. Um teste que passe aqui e falhe contra a fixture
 * significa que a producao e a captura divergiram, que e exatamente o que nao pode acontecer
 * em silencio.
 */

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const { aAmostra, quadrosCapturados } = require("../streamFix/tunnel/coletor.ts");

function linhasDe(nome) {
    const caminho = resolve(__dirname, `fixtures/${nome}.jsonl`);
    return readFileSync(caminho, "utf8").trim().split("\n")
        .map(l => JSON.parse(l))
        .filter(l => l.t && l.dados);
}

test("quadrosCapturados soma os backends e ignora os contadores de unicos", () => {
    const tela = {
        hybridGraphicsCaptureFrames: 80, hybridGraphicsCaptureFramesUnique: 4,
        hybridGdiFrames: 1, hybridGdiBitBltFrames: 1, hybridGdiBitBltFramesUnique: 1,
        hybridDxgiFrames: 0, hdrFrames: 0, videohookBackend: 0,
    };
    assert.equal(quadrosCapturados(tela), 82);
    assert.equal(quadrosCapturados(null), null);
    assert.equal(quadrosCapturados(undefined), null);
});

test("le o contexto stream e ignora o da call", () => {
    const bruto = {
        espectadores: 2,
        dados: [
            { context: "default", video: [{ framesEncoded: 999, bytesSent: 999 }], captura: { tela: { aFrames: 999 } } },
            { context: "stream", video: [{ framesEncoded: 10, bytesSent: 20 }], captura: { tela: { aFrames: 30 } } },
        ],
    };
    assert.deepEqual(aAmostra(bruto, 1000), {
        t: 1000, espectadores: 2, framesEncoded: 10, bytesSent: 20, capturaQuadros: 30,
    });
});

test("campo ausente vira null, nunca zero", () => {
    // A diferenca importa: zero e "o encoder nao produziu nada", null e "nao sei". O monitor
    // trata os dois de formas opostas -- zero pode virar quebra, null nunca conclui.
    const bruto = { espectadores: 1, dados: [{ context: "stream", video: [{}], captura: null }] };
    const a = aAmostra(bruto, 0);
    assert.equal(a.framesEncoded, null);
    assert.equal(a.bytesSent, null);
    assert.equal(a.capturaQuadros, null);
});

test("sem contexto stream, tudo e null", () => {
    const bruto = { espectadores: 0, dados: [{ context: "default", video: [{ framesEncoded: 5 }] }] };
    const a = aAmostra(bruto, 0);
    assert.equal(a.framesEncoded, null);
    assert.equal(a.bytesSent, null);
});

test("leitura vazia nao explode e nao conclui nada", () => {
    // Acontece de verdade: getStats() tem prazo interno de 1s e devolve undefined quando
    // estoura. O observador converte isso num objeto vazio em vez de pular a amostra.
    const a = aAmostra({}, 42);
    assert.deepEqual(a, { t: 42, espectadores: 0, framesEncoded: null, bytesSent: null, capturaQuadros: null });
});

test("espectadores ausente conta como zero, nao como um", () => {
    // `null` aqui significa "nao ha transmissao minha no ar". Contar como 1 faria o monitor
    // concluir quebra em quem nem esta transmitindo.
    assert.equal(aAmostra({ dados: [] }, 0).espectadores, 0);
    assert.equal(aAmostra({ espectadores: null, dados: [] }, 0).espectadores, 0);
});

test("reproduz a entrada do espectador gravada em saudavel-longa", () => {
    // Valores conferidos na serie real de 11/09/2026, amostra 302: o instante em que o
    // espectador entra e a entrega ja tinha 255 quadros. Se a extracao mudar, isto quebra.
    const linhas = linhasDe("saudavel-longa");
    const a = aAmostra(linhas[302], Date.parse(linhas[302].t));
    assert.equal(a.espectadores, 1);
    assert.equal(a.framesEncoded, 255);
    assert.equal(a.bytesSent, 565630);
    assert.ok(a.capturaQuadros > 0, "a captura estava viva nesse instante");
});

test("reproduz a assinatura de negacao gravada em quebra-entrada-espectador", () => {
    // A serie de 08/09/2026: o encoder produziu um quadro e travou, sem um byte entregue.
    const linhas = linhasDe("quebra-entrada-espectador");
    const amostras = linhas.map(l => aAmostra(l, Date.parse(l.t)));

    const entrada = amostras.findIndex(a => a.espectadores > 0);
    assert.ok(entrada > 0, "a fixture contem a entrada de um espectador");

    const depois = amostras.slice(entrada);
    assert.ok(depois.every(a => a.bytesSent === 0 || a.bytesSent === null),
        "nenhum byte de video saiu depois da entrada");
    assert.ok(depois.every(a => a.framesEncoded === 1 || a.framesEncoded === null),
        "o encoder ficou parado em um quadro");
});
