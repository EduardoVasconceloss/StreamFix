/*
 * Testes do contador de emprestimos do tunel completo, e da politica que decide o nivel.
 *
 * O que importa aqui e o contador nao devolver cedo: voce transmitindo e, no meio, entrando na
 * transmissao de outra pessoa. Se a entrada devolvesse o completo de todo mundo, a proxima
 * conexao de midia nasceria pelo Brasil.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { criarEmprestimos, nivel, FOLGA_NASCIMENTO_MS, PRAZO_NASCIMENTO_MS } = require("../streamFix/tunnel/emprestimos.ts");

test("sem emprestimo, o nivel pedido e o controle", () => {
    assert.equal(criarEmprestimos().nivelDesejado(), "controle");
});

test("um emprestimo pede o completo, e devolve-lo volta ao controle", () => {
    const e = criarEmprestimos();
    const id = e.pegar("transmitir");
    assert.equal(e.nivelDesejado(), "completo");
    e.devolver(id);
    assert.equal(e.nivelDesejado(), "controle");
});

test("emprestimos sobrepostos: quem devolve primeiro nao tira o completo de quem ainda precisa", () => {
    const e = criarEmprestimos();
    const transmitir = e.pegar("transmitir");
    const assistir = e.pegar("assistir");
    e.devolver(assistir);
    assert.equal(e.nivelDesejado(), "completo", "a transmissao ainda precisa do completo");
    assert.deepEqual(e.abertos(), ["transmitir"]);
    e.devolver(transmitir);
    assert.equal(e.nivelDesejado(), "controle");
});

test("devolver duas vezes nao fecha o emprestimo de outro", () => {
    // O modo de falha de um contador ingenuo (n--): a segunda devolucao do mesmo pedido
    // zeraria o contador com outro emprestimo ainda aberto.
    const e = criarEmprestimos();
    const voz = e.pegar("voz");
    const transmitir = e.pegar("transmitir");
    e.devolver(voz);
    e.devolver(voz);
    assert.equal(e.nivelDesejado(), "completo");
    assert.deepEqual(e.abertos(), ["transmitir"]);
    e.devolver(transmitir);
});

test("devolver um id que nunca existiu nao faz nada", () => {
    const e = criarEmprestimos();
    const id = e.pegar("voz");
    e.devolver(9999);
    e.devolver(undefined);
    assert.equal(e.nivelDesejado(), "completo");
    e.devolver(id);
    assert.equal(e.nivelDesejado(), "controle");
});

test("cada pedido ganha um id proprio", () => {
    const e = criarEmprestimos();
    const ids = [e.pegar("voz"), e.pegar("voz"), e.pegar("assistir")];
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(e.abertos(), ["voz", "voz", "assistir"]);
});

const SITUACAO = { temControle: true, completoSempre: false, travaComControle: false, pedido: "controle" };

test("a politica segue o contador quando o tunel em dois niveis vale", () => {
    assert.equal(nivel(SITUACAO), "controle");
    assert.equal(nivel({ ...SITUACAO, pedido: "completo" }), "completo");
});

test("sem perfil de controle, sempre o completo: e o comportamento de antes (E5)", () => {
    assert.equal(nivel({ ...SITUACAO, temControle: false }), "completo");
});

test("tunelCompletoSempre forca o completo com o contador vazio (E7)", () => {
    assert.equal(nivel({ ...SITUACAO, completoSempre: true }), "completo");
});

test("a Trava 1 vinda com o controle no ar forca o completo (E6)", () => {
    assert.equal(nivel({ ...SITUACAO, travaComControle: true }), "completo");
});

test("a folga e a margem medida, nao um chute", () => {
    // Medido em 12/09: voltar ao controle no instante do CONNECTED ja entregou. A folga e
    // margem, e tem de ser curta o bastante para nao virar o tunel permanente de antes.
    assert.ok(FOLGA_NASCIMENTO_MS >= 1000 && FOLGA_NASCIMENTO_MS <= 10_000, `${FOLGA_NASCIMENTO_MS}`);
});

test("o prazo do Go Live cobre a troca e o nascimento, e mais nada", () => {
    // Troca de ~1,25 s mais o nascimento do stream. Curto demais devolveria o completo com a
    // transmissao nascendo; longo demais e o tunel preso quando ela nao nasce.
    assert.ok(PRAZO_NASCIMENTO_MS > 5_000 && PRAZO_NASCIMENTO_MS <= 60_000, `${PRAZO_NASCIMENTO_MS}`);
});
