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
    lerTrava, descreverTrava, decidirTrava, lerMarca,
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

// Faixa: um perfil nosso estava no ar quando o gateway conectou, e a trava veio mesmo assim.
const FAIXA = { trava: true, doisNiveis: true, tunelNoGateway: true, jaRecarregou: false };
// Tempo: o gateway conectou antes do tunel. E o caso de todo boot (reproduzido em 12/09).
const TEMPO = { trava: true, doisNiveis: true, tunelNoGateway: false, jaRecarregou: false };

test("trava com o controle no ar: completo, uma recarga e aviso (E6)", () => {
    const d = decidirTrava(FAIXA);
    assert.equal(d.forcarCompleto, true);
    assert.equal(d.recarregar, true);
    assert.match(d.aviso, /recarregando/);
});

test("trava de novo depois da recarga nao recarrega outra vez: nada de laco", () => {
    for (const s of [{ ...FAIXA, jaRecarregou: true }, { ...TEMPO, jaRecarregou: true }]) {
        assert.equal(decidirTrava(s).recarregar, false, JSON.stringify(s));
    }
    assert.match(decidirTrava({ ...FAIXA, jaRecarregou: true }).aviso, /tunelCompletoSempre/);
});

test("trava porque o Discord conectou antes do tunel: recarrega sem forcar o completo", () => {
    // O relato: "sempre que reiniciam o PC, tem que reinstalar". Depois do boot nenhum tunel esta
    // no ar, o Discord conecta antes de o plugin subir o tunel, e a trava so sai com outra
    // conexao. Forcar o completo aqui deixaria a call a ~130 ms em todo boot, por nada.
    const d = decidirTrava(TEMPO);
    assert.equal(d.recarregar, true);
    assert.equal(d.forcarCompleto, false);
    assert.match(d.aviso, /antes de o tunel ficar pronto/);
});

test("a trava por tempo e consertada tambem sem o perfil de controle", () => {
    // Quem atualizou o plugin e nao o instalador fica no completo -- e sofre a mesma corrida.
    const d = decidirTrava({ ...TEMPO, doisNiveis: false });
    assert.equal(d.recarregar, true);
    assert.equal(d.forcarCompleto, false);
});

test("sem trava nao faz nada; com o completo no ar e a trava mesmo assim, tambem nao", () => {
    for (const s of [
        { ...FAIXA, trava: false },
        { ...TEMPO, trava: false },
        { ...FAIXA, trava: false, doisNiveis: false },
        // O completo estava no ar e a trava veio: a saida foi marcada. Trocar de perfil nao resolve.
        { ...FAIXA, doisNiveis: false }
    ]) {
        assert.deepEqual(decidirTrava(s), { forcarCompleto: false, recarregar: false, aviso: null }, JSON.stringify(s));
    }
});

test("a marca da recarga vale por pouco tempo e guarda a causa", () => {
    const agora = 1_000_000;
    assert.deepEqual(lerMarca({ quando: agora - 5_000, completo: false }, agora), { quando: agora - 5_000, completo: false });
    assert.deepEqual(lerMarca({ quando: agora - 5_000, completo: true }, agora), { quando: agora - 5_000, completo: true });
    assert.equal(lerMarca({ quando: agora - VALIDADE_DA_MARCA_MS, completo: false }, agora), null, "vencida: e outra abertura do Discord");
    assert.equal(lerMarca({ quando: agora + 5_000, completo: false }, agora), null, "do futuro: relogio mexido, nao confia");
    for (const ruim of [undefined, null, "123", {}, { quando: "1", completo: true }, { quando: agora, completo: "sim" }]) {
        assert.equal(lerMarca(ruim, agora), null, JSON.stringify(ruim));
    }
});

test("a marca antiga, um numero solto, vale como recarga por faixa", () => {
    const agora = 1_000_000;
    assert.deepEqual(lerMarca(agora - 5_000, agora), { quando: agora - 5_000, completo: true });
});
