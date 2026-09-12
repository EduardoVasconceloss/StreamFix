/*
 * Testes da leitura da Trava 1 e do que fazer com ela.
 *
 * Os formatos abaixo sao os lidos no Discord 1.0.9257 em 12/09: a atribuicao do servidor e um
 * objeto com `variantId`, ou `undefined`; o override do plugin Experiments e um mapa pelo nome
 * do experimento com `variantId: -1` e `isOverride: true`.
 *
 * O teste que mais importa e o do override: ele esconde a trava na tela e nao no servidor. Ler
 * o lado errado foi o confundidor de 12h.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    lerTrava, descreverTrava, decidirTrava, recargaRecente,
    VIDEO_GUARD, VARIANTES_DA_TRAVA, VALIDADE_DA_MARCA_MS
} = require("../streamFix/tunnel/trava.ts");

const atribuicao = variantId => ({ hashedName: 3022613762, variantId, isOverride: false, revision: 5, exposureTrackingEnabled: true });
const OVERRIDE = { [VIDEO_GUARD]: { hashedName: 3022613762, variantId: -1, isOverride: true, exposureTrackingEnabled: false } };

test("sem atribuicao do servidor, a trava nao veio", () => {
    const l = lerTrava(undefined, {});
    assert.deepEqual(l, { servidor: null, override: null, trava: false });
    assert.deepEqual(descreverTrava(l), ["o servidor nao mandou a trava"]);
});

test("o null que a store devolve vira frase, nao 'null'", () => {
    // O `ask` do /streamfix transforma `undefined` em `null`. A fase 7 corrige a leitura disso.
    const linhas = descreverTrava(lerTrava(null, null));
    assert.deepEqual(linhas, ["o servidor nao mandou a trava"]);
    assert.ok(!linhas.join(" ").includes("null"));
});

test("as variantes 1 e 2 sao a trava", () => {
    for (const v of VARIANTES_DA_TRAVA) {
        const l = lerTrava(atribuicao(v), {});
        assert.equal(l.trava, true, `variante ${v}`);
        assert.match(descreverTrava(l)[0], /mandou a trava/);
    }
});

test("outra variante nao e a trava", () => {
    const l = lerTrava(atribuicao(0), {});
    assert.equal(l.trava, false);
    assert.match(descreverTrava(l)[0], /variante 0, que nao e a trava/);
});

test("com override de cliente, a leitura continua sendo a do servidor", () => {
    // O confundidor de 12h: o override faz o botao aparecer, e o servidor continua mandando a
    // variante 2 -- a entrega continua recusada.
    const l = lerTrava(atribuicao(2), OVERRIDE);
    assert.equal(l.trava, true, "o override nao desliga a trava do servidor");
    assert.equal(l.override, -1);
    const linhas = descreverTrava(l);
    assert.equal(linhas.length, 2);
    assert.match(linhas[1], /o botao aparece, mas o servidor continua recusando sem tunel/);
});

test("override sem trava do servidor e mostrado, e nao inventa trava", () => {
    const l = lerTrava(undefined, OVERRIDE);
    assert.equal(l.trava, false);
    assert.equal(l.override, -1);
    assert.equal(descreverTrava(l).length, 2);
});

test("formato inesperado e ilegivel, nunca trava", () => {
    // O `ask` devolve "metodo ausente" ou "erro: ..." como texto quando a store muda.
    for (const ruim of ["metodo ausente", "erro: x", 2, { variant: 2 }, { variantId: "2" }]) {
        const l = lerTrava(ruim, "metodo ausente");
        assert.equal(l.servidor, "ilegivel", JSON.stringify(ruim));
        assert.equal(l.trava, false);
        assert.equal(l.override, null);
    }
    assert.match(descreverTrava(lerTrava("erro: x", {}))[0], /nao consegui ler/);
});

test("trava com o controle no ar: completo, uma recarga e aviso (E6)", () => {
    const d = decidirTrava({ trava: true, doisNiveis: true, jaRecarregou: false });
    assert.equal(d.forcarCompleto, true);
    assert.equal(d.recarregar, true);
    assert.match(d.aviso, /recarregando/);
});

test("trava de novo depois da recarga nao recarrega outra vez: nada de laco", () => {
    const d = decidirTrava({ trava: true, doisNiveis: true, jaRecarregou: true });
    assert.equal(d.forcarCompleto, true);
    assert.equal(d.recarregar, false);
    assert.match(d.aviso, /tunelCompletoSempre/);
});

test("sem trava, ou fora do tunel em dois niveis, nao faz nada", () => {
    for (const s of [
        { trava: false, doisNiveis: true, jaRecarregou: false },
        { trava: false, doisNiveis: false, jaRecarregou: false },
        // No completo sempre, trocar de perfil nao resolveria: nao ha para onde subir.
        { trava: true, doisNiveis: false, jaRecarregou: false }
    ]) {
        assert.deepEqual(decidirTrava(s), { forcarCompleto: false, recarregar: false, aviso: null }, JSON.stringify(s));
    }
});

test("a marca da recarga vale por pouco tempo, e so se for um numero", () => {
    const agora = 1_000_000;
    assert.equal(recargaRecente(agora - 5_000, agora), true);
    assert.equal(recargaRecente(agora - VALIDADE_DA_MARCA_MS, agora), false, "vencida: e outra abertura do Discord");
    assert.equal(recargaRecente(agora + 5_000, agora), false, "do futuro: relogio mexido, nao confia");
    for (const ruim of [undefined, null, "123", {}]) assert.equal(recargaRecente(ruim, agora), false);
});
