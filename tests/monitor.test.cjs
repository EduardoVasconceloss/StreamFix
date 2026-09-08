// Cobre o SessionMonitor. As tres regras testadas aqui saem de medicao, nao de desenho: a
// fixture sem-espectador derrubou a regra original da spec, e os casos abaixo existem para
// que ela nao volte.
//
// Diferente de tests/media-control-routing.test.cjs, este arquivo importa o modulo de forma
// comum. O harness de stripTypeScriptTypes + runInNewContext existe so porque native.ts e um
// arquivo unico com efeitos no topo; modulo novo nao precisa dele e nao deve usa-lo.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const { avancar, estadoInicial, percorrer, quadrosCapturados, PADROES } = require("../streamFix/tunnel/monitor.ts");

const T0 = 1_757_000_000_000;

/** Serie sintetica: cada passo avanca meio segundo, como a captura real. */
function serie(passos) {
    return passos.map((p, i) => ({
        t: T0 + i * 500,
        espectadores: p.espectadores ?? 1,
        framesEncoded: p.framesEncoded ?? null,
        bytesSent: p.bytesSent ?? null,
        capturaQuadros: p.capturaQuadros ?? null,
    }));
}

function vereditos(passos, opcoes) {
    return percorrer(serie(passos), opcoes).map(e => e.veredito);
}

/**
 * Repete um passo n vezes, para atravessar a tolerancia sem escrever 10 linhas iguais.
 * `incremento` faz um campo crescer a cada repeticao -- e assim que se representa "a captura
 * continua produzindo enquanto a entrega esta congelada", que e a diferenca entre as duas
 * causas de quebra.
 */
function repetir(passo, n, incremento = {}) {
    return Array.from({ length: n }, (_, i) => {
        const atual = { ...passo };
        for (const [campo, delta] of Object.entries(incremento)) {
            atual[campo] = (passo[campo] ?? 0) + delta * i;
        }
        return atual;
    });
}

test("com espectador e quadros avancando, segue saudavel", () => {
    const v = vereditos([
        { framesEncoded: 10, capturaQuadros: 100 },
        { framesEncoded: 40, capturaQuadros: 130 },
        { framesEncoded: 70, capturaQuadros: 160 },
    ]);
    assert.deepEqual(v.map(x => x.estado), ["saudavel", "saudavel", "saudavel"]);
});

test("sem espectador, entrega parada nao e quebra", () => {
    // O caso da fixture real: transmitindo, ninguem assistindo, zero quadro codificado. Uma
    // transmissao saudavel se comporta assim, entao concluir qualquer coisa aqui e falso
    // positivo -- e falso positivo reinicia a transmissao de alguem sem motivo.
    const v = vereditos(repetir({ espectadores: 0, framesEncoded: 0, bytesSent: 0, capturaQuadros: 100 }, 30));
    assert.ok(v.every(x => x.estado === "saudavel"), "nenhuma amostra pode ser quebra");
    assert.match(v.at(-1).motivo, /sem espectador/);
});

test("com espectador, entrega parada alem da tolerancia e quebra de entrega", () => {
    const passos = [
        { framesEncoded: 10, capturaQuadros: 100 },
        // Entrega congelada em 10; a captura segue produzindo, o que aponta o encoder, nao a tela.
        ...repetir({ framesEncoded: 10, capturaQuadros: 130 }, 12, { capturaQuadros: 30 }),
    ];
    const v = vereditos(passos);
    assert.equal(v.at(-1).estado, "quebrado");
    assert.equal(v.at(-1).causa, "entrega");
});

test("entrega e captura paradas juntas apontam a captura, nao a entrega", () => {
    // Distincao que importa: religar o tunel e recriar a transmissao nao conserta captura
    // parada. So a causa "entrega" justifica recuperacao.
    const v = vereditos(repetir({ framesEncoded: 10, capturaQuadros: 100 }, 14));
    assert.equal(v.at(-1).estado, "quebrado");
    assert.equal(v.at(-1).causa, "captura");
});

test("a quebra so e declarada depois da tolerancia, nao antes", () => {
    const passos = repetir({ framesEncoded: 10, capturaQuadros: 100, espectadores: 1 }, 14);
    const estados = percorrer(serie(passos));
    // Tolerancia de 4s a 500ms por amostra: a parada comeca na segunda amostra (a primeira
    // ainda nao tem com o que comparar), entao a quebra nao pode aparecer antes disso.
    const primeiraQuebra = estados.findIndex(e => e.veredito.estado === "quebrado");
    assert.ok(primeiraQuebra >= PADROES.toleranciaMs / 500, `quebrou cedo demais, na amostra ${primeiraQuebra}`);
    assert.ok(primeiraQuebra > 0, "alguma amostra precisa quebrar");
});

test("renegociacao de codec zera os contadores e isso nao e quebra", () => {
    // Medido na fixture: H264 -> H265 no mesmo ssrc, bytesSent e packetsSent voltando a zero.
    const passos = [
        { framesEncoded: 500, bytesSent: 60000, capturaQuadros: 100 },
        { framesEncoded: 0, bytesSent: 0, capturaQuadros: 130 },
        { framesEncoded: 20, bytesSent: 900, capturaQuadros: 160 },
    ];
    const v = vereditos(passos);
    assert.ok(v.every(x => x.estado === "saudavel"));
    assert.match(v[1].motivo, /reiniciou/);
});

test("o relogio de parada reinicia junto com o contador", () => {
    // Sem isto, uma renegociacao logo apos uma parada breve declararia quebra no instante
    // seguinte, herdando o relogio antigo.
    const passos = [
        ...repetir({ framesEncoded: 10, bytesSent: 500, capturaQuadros: 100 }, 6),
        { framesEncoded: 0, bytesSent: 0, capturaQuadros: 130 },
        ...repetir({ framesEncoded: 0, bytesSent: 0, capturaQuadros: 160 }, 4),
    ];
    const v = vereditos(passos);
    assert.equal(v.at(-1).estado, "saudavel", "a parada apos o reinicio ainda esta na tolerancia");
});

test("amostra sem dados nao decide nada nem perde o relogio de parada", () => {
    const passos = [
        { framesEncoded: 10, capturaQuadros: 100 },
        ...repetir({ framesEncoded: 10, capturaQuadros: 130 }, 6),
        // A engine nao respondeu no prazo: buraco na serie, nao prova de parada.
        { framesEncoded: null, bytesSent: null, capturaQuadros: 160 },
        ...repetir({ framesEncoded: 10, capturaQuadros: 190 }, 6),
    ];
    const estados = percorrer(serie(passos));
    assert.match(estados[7].veredito.motivo, /sem dados/);
    assert.equal(estados[7].veredito.estado, "saudavel");
    assert.equal(estados.at(-1).veredito.estado, "quebrado", "o relogio anterior continuou valendo");
});

test("espectador que sai encerra a conclusao de quebra", () => {
    const passos = [
        { framesEncoded: 10, capturaQuadros: 100 },
        ...repetir({ framesEncoded: 10, capturaQuadros: 130 }, 12),
        { framesEncoded: 10, capturaQuadros: 160, espectadores: 0 },
    ];
    const v = vereditos(passos);
    assert.equal(v.at(-2).estado, "quebrado");
    assert.equal(v.at(-1).estado, "saudavel", "sem ninguem assistindo nao ha o que recuperar");
});

test("quadrosCapturados soma os backends e ignora os contadores de unicos", () => {
    const tela = {
        hybridGraphicsCaptureFrames: 80, hybridGraphicsCaptureFramesUnique: 4,
        hybridGdiFrames: 1, hybridGdiBitBltFrames: 1, hybridGdiBitBltFramesUnique: 1,
        hybridDxgiFrames: 0, hdrFrames: 0, videohookBackend: 0,
    };
    assert.equal(quadrosCapturados(tela), 82);
    assert.equal(quadrosCapturados(null), null);
});

test("a fixture real de sem-espectador nunca dispara o monitor", () => {
    const caminho = resolve(__dirname, "fixtures/sem-espectador.jsonl");
    const linhas = readFileSync(caminho, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const amostras = linhas.filter(l => l.t && l.dados).map(l => {
        const stream = l.dados.find(d => d.context === "stream");
        const video = stream?.video?.[0];
        return {
            t: Date.parse(l.t),
            // A fixture e de formato 1, gravada antes do campo existir. O cenario e, por
            // definicao, zero espectador -- foi gravado sozinho de proposito.
            espectadores: l.espectadores ?? 0,
            framesEncoded: video?.framesEncoded ?? null,
            bytesSent: video?.bytesSent ?? null,
            capturaQuadros: quadrosCapturados(stream?.captura?.tela),
        };
    });

    assert.ok(amostras.length > 200, `serie curta demais: ${amostras.length} amostras`);
    const quebras = percorrer(amostras).filter(e => e.veredito.estado === "quebrado");
    assert.equal(quebras.length, 0, `${quebras.length} falsos positivos na serie real`);
});

test("a mesma fixture, com um espectador, seria quebra", () => {
    // Prova que a serie real nao passa por falta de sinal: o que a segura e a regra do
    // espectador. Trocado esse unico campo, o monitor conclui quebra de entrega -- a captura
    // segue produzindo o tempo todo, entao a causa aponta o encoder.
    const caminho = resolve(__dirname, "fixtures/sem-espectador.jsonl");
    const linhas = readFileSync(caminho, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const amostras = linhas.filter(l => l.t && l.dados).map(l => {
        const stream = l.dados.find(d => d.context === "stream");
        const video = stream?.video?.[0];
        return {
            t: Date.parse(l.t),
            espectadores: 1,
            framesEncoded: video?.framesEncoded ?? null,
            bytesSent: video?.bytesSent ?? null,
            capturaQuadros: quadrosCapturados(stream?.captura?.tela),
        };
    }).filter(a => a.framesEncoded != null);

    const finais = percorrer(amostras).at(-1);
    assert.equal(finais.veredito.estado, "quebrado");
    assert.equal(finais.veredito.causa, "entrega");
});
