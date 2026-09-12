const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    decidirEntrada,
    PRAZO_ATE_DEVOLVER_MS
} = require("../streamFix/tunnel/entrada.ts");

const BASE = { exigirTunel: true, tunel: "fora", jaTentou: false, preparando: false };

test("com o tunel de pe, entra direto e sem dizer nada", () => {
    const d = decidirEntrada({ ...BASE, tunel: "conectado" });
    assert.deepEqual(d, { entrar: true, prepararTunel: false, aviso: null });
});

test("com o porteiro desligado, entra sem nem olhar o tunel", () => {
    for (const tunel of ["fora", "desconhecido", "conectado"]) {
        const d = decidirEntrada({ ...BASE, exigirTunel: false, tunel });
        assert.equal(d.entrar, true, `tunel ${tunel}`);
        assert.equal(d.prepararTunel, false);
    }
});

test("com o tunel fora, aborta a entrada e manda subir", () => {
    const d = decidirEntrada({ ...BASE, tunel: "fora" });
    assert.equal(d.entrar, false);
    assert.equal(d.prepararTunel, true);
    assert.match(d.aviso, /subindo o tunel/i);
});

test("tunel desconhecido e tratado como fora", () => {
    // O gancho e sincrono e le um cache. "Desconhecido" e o estado do primeiro clique depois de
    // o Discord abrir -- e entrar nele sem conferir e a aposta que da tela preta.
    const d = decidirEntrada({ ...BASE, tunel: "desconhecido" });
    assert.equal(d.entrar, false);
    assert.equal(d.prepararTunel, true);
});

test("na repeticao que ainda acha o tunel fora, desiste -- e nao manda subir de novo", () => {
    // Este e o teste do laco. Sem ele, tunel que nao sobe vira entrar-abortar-subir-entrar sem
    // fim, cada volta com um toast na tela.
    const d = decidirEntrada({ ...BASE, tunel: "fora", jaTentou: true });
    assert.equal(d.entrar, false);
    assert.equal(d.prepararTunel, false, "a repeticao nao pode pedir outra repeticao");
    assert.match(d.aviso, /nao entrei/i);
});

test("na falha, nunca entra mesmo assim", () => {
    // A spec, secao 4.3, e explicita: "desistir da entrada com aviso, nunca entrar mesmo assim".
    // Entrar sem tunel da tela preta e, por F2, pode derrubar mais gente junto.
    for (const tunel of ["fora", "desconhecido"]) {
        assert.equal(decidirEntrada({ ...BASE, tunel, jaTentou: true }).entrar, false);
    }
});

test("a repeticao que encontra o tunel de pe entra", () => {
    const d = decidirEntrada({ ...BASE, tunel: "conectado", jaTentou: true });
    assert.equal(d.entrar, true);
    assert.equal(d.aviso, null);
});

test("clicar de novo enquanto o tunel sobe ouve a verdade, nao um erro", () => {
    // Sao ~800 ms entre abortar e repetir. Sem esta distincao o segundo clique ouviria "nao
    // consegui subir o tunel" com o tunel subindo -- e a pessoa desistiria por causa da mentira.
    const d = decidirEntrada({ ...BASE, tunel: "fora", preparando: true });
    assert.equal(d.entrar, false);
    assert.equal(d.prepararTunel, false, "nao pode subir um segundo tunel");
    assert.match(d.aviso, /ainda esta subindo/i);
});

test("desistir ganha de estar preparando: a repeticao ja e a ultima palavra", () => {
    const d = decidirEntrada({ ...BASE, tunel: "fora", jaTentou: true, preparando: true });
    assert.match(d.aviso, /nao entrei/i);
    assert.equal(d.prepararTunel, false);
});

/** Todas as combinacoes possiveis da situacao. */
function todasAsSituacoes() {
    const fora = [];
    for (const exigirTunel of [true, false]) {
        for (const tunel of ["conectado", "fora", "desconhecido"]) {
            for (const jaTentou of [true, false]) {
                for (const preparando of [true, false]) {
                    fora.push({ exigirTunel, tunel, jaTentou, preparando });
                }
            }
        }
    }
    return fora;
}

test("toda decisao de abortar vem com um aviso, e toda entrada vem calada", () => {
    for (const s of todasAsSituacoes()) {
        const d = decidirEntrada(s);
        if (d.entrar) assert.equal(d.aviso, null, "entrar calado");
        else assert.equal(typeof d.aviso, "string", "abortar sempre explica");
    }
});

test("so a primeira tentativa pode pedir tunel, e so quem aborta", () => {
    for (const s of todasAsSituacoes()) {
        const d = decidirEntrada(s);
        if (d.prepararTunel) {
            assert.equal(d.entrar, false);
            assert.equal(s.jaTentou, false, "repeticao nao pede repeticao");
            assert.equal(s.preparando, false, "nao pede um segundo tunel");
        }
    }
});

test("nunca pede um segundo tunel enquanto um ja esta subindo", () => {
    // A trava do laco, dita do jeito mais forte que da: em nenhuma situacao com um tunel ja
    // subindo o porteiro pede outro.
    for (const s of todasAsSituacoes().filter(x => x.preparando)) {
        assert.equal(decidirEntrada(s).prepararTunel, false, JSON.stringify(s));
    }
});

// Quem decide quando o completo cai deixou de ser esta unidade: a entrada pega um emprestimo e
// o devolve depois do prazo, e o contador (emprestimos.ts) so volta ao controle quando ninguem
// mais precisa -- que e o que `deveDerrubarDepois` fazia com duas guardas.

test("o prazo ate devolver e de dez segundos", () => {
    assert.equal(PRAZO_ATE_DEVOLVER_MS, 10_000);
});
