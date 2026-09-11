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

/** Mapeia uma linha da fixture para a entrada do monitor. Compartilhado pelos casos reais. */
function daFixture(nome, espectadoresForcados) {
    const caminho = resolve(__dirname, `fixtures/${nome}.jsonl`);
    return readFileSync(caminho, "utf8").trim().split("\n").map(l => JSON.parse(l))
        .filter(l => l.t && l.dados)
        .map(l => {
            const stream = l.dados.find(d => d.context === "stream");
            const video = stream?.video?.[0];
            return {
                t: Date.parse(l.t),
                espectadores: espectadoresForcados ?? l.espectadores ?? 0,
                framesEncoded: video?.framesEncoded ?? null,
                bytesSent: video?.bytesSent ?? null,
                capturaQuadros: quadrosCapturados(stream?.captura?.tela),
            };
        });
}

test("a fixture real de quebra dispara, no tempo certo e pela causa certa", () => {
    // Gravada em 08/09/2026 com tunel WireGuard ativo e espectador brasileiro entrando: a
    // entrega foi negada pelo servidor. Ver a secao 12c da pesquisa. Serie que o monitor
    // nunca viu quando foi escrito -- por isso ela vale mais que as sinteticas.
    const amostras = daFixture("quebra-entrada-espectador");
    const estados = percorrer(amostras);

    const entrada = amostras.findIndex(a => a.espectadores > 0);
    const quebra = estados.findIndex(e => e.veredito.estado === "quebrado");

    assert.ok(entrada > 0, "a fixture precisa conter a entrada de um espectador");
    assert.ok(quebra > entrada, "a quebra nao pode ser declarada antes de haver espectador");

    const atraso = amostras[quebra].t - amostras[entrada].t;
    assert.ok(atraso >= PADROES.toleranciaMs && atraso < PADROES.toleranciaMs + 1500,
        `declarou quebra ${atraso}ms apos a entrada; esperado ~${PADROES.toleranciaMs}ms`);

    assert.equal(estados[quebra].veredito.causa, "entrega",
        "a captura seguia produzindo, entao a causa e a entrega e nao a captura");
});

test("nenhuma amostra anterior a entrada do espectador dispara", () => {
    const amostras = daFixture("quebra-entrada-espectador");
    const entrada = amostras.findIndex(a => a.espectadores > 0);
    const antes = percorrer(amostras.slice(0, entrada));
    assert.equal(antes.filter(e => e.veredito.estado === "quebrado").length, 0);
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

test("a fixture real de entrega saudavel nunca declara quebra", () => {
    // Gravada em 11/09/2026, teste de controle: emissor e espectador os dois saindo por
    // Santiago. E a contraprova de quebra-entrada-espectador -- mesma montagem, mudando so o
    // IP de quem assiste -- e a primeira serie que temos de uma entrega que funciona.
    // Ver a secao 12d da pesquisa.
    const amostras = daFixture("saudavel-longa");
    const estados = percorrer(amostras);

    const quebras = estados.filter(e => e.veredito.estado === "quebrado");
    assert.equal(quebras.length, 0,
        `falso positivo em serie saudavel: ${quebras[0]?.veredito.motivo ?? ""}`);

    // A serie contem duas entradas de espectador, e a segunda vem depois de uma saida que
    // zera os contadores. E esse zeramento que exercita a regra 2 por dado real: contador
    // andando para tras e base nova, nao parada.
    const entradas = amostras.filter((a, i) => a.espectadores > 0 && (amostras[i - 1]?.espectadores ?? 0) === 0);
    assert.equal(entradas.length, 2, "a fixture precisa conter as duas entradas de espectador");

    const reinicios = estados.filter(e => /reiniciou/.test(e.veredito.motivo));
    assert.ok(reinicios.length > 0, "a fixture precisa exercitar a regra de reinicio de contador");

    // E a folga de espectador precisa ser exercitada de verdade: sem ela esta serie declarava
    // quebra 4074ms depois do encoder cair, cinco segundos antes de a store contar zero.
    const folga = estados.filter(e => /folga de espectador/.test(e.veredito.motivo));
    assert.ok(folga.length > 0, "a fixture precisa passar pela folga de atraso da store");
});
