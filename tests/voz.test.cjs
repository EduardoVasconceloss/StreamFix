/*
 * Testes da unidade da voz: nascer no completo, conferir, resgatar.
 *
 * As sequencias de eventos abaixo sao as que o Discord 1.0.9257 emitiu em 12/09 (pesquisa,
 * 12i): uma entrada da `VOICE_CHANNEL_SELECT` e depois `CONNECTING` ... `RTC_CONNECTED`; um
 * `reconnect()` da `CONNECTING` ... `RTC_CONNECTED`, sem `VOICE_CHANNEL_SELECT`.
 *
 * O teste que mais importa e o do resgate que nasce fora de novo: sem a trava de "um resgate
 * por nascimento", a unidade pediria `reconnect()` para sempre, e a pessoa ficaria sem voz.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { decidirVoz, VOZ_INICIAL, AVISO_VOZ_FORA, PRAZO_VOZ_MS } = require("../streamFix/tunnel/voz.ts");

const SAIDA = "159.112.151.37";
const CASA = "177.42.223.136";
const CTX = { ativo: true, saida: SAIDA };

/** Roda uma sequencia de eventos e devolve o estado final e as acoes, na ordem. */
function rodar(eventos, ctx = CTX, inicial = VOZ_INICIAL) {
    let estado = inicial;
    const acoes = [];
    for (const ev of eventos) {
        const r = decidirVoz(estado, ev, ctx);
        estado = r.estado;
        acoes.push(r.acao);
    }
    return { estado, acoes };
}

const ENTROU = { tipo: "entrou" };
const CONECTANDO = { tipo: "conectando" };
const naSaida = { tipo: "conectada", localAddress: SAIDA };
const emCasa = { tipo: "conectada", localAddress: CASA };

const pegou = acoes => acoes.filter(a => a.pegar).length;
const devolucoes = acoes => acoes.map(a => a.devolver).filter(Boolean);

test("entrada que nasce na saida: um emprestimo, devolvido depois da folga", () => {
    const { estado, acoes } = rodar([ENTROU, CONECTANDO, naSaida]);
    assert.equal(pegou(acoes), 1, "o CONNECTING da propria entrada nao abre um segundo emprestimo");
    assert.deepEqual(devolucoes(acoes), ["depoisDaFolga"]);
    assert.ok(!acoes.some(a => a.resgatar));
    assert.deepEqual(estado, VOZ_INICIAL);
});

test("entrada que nasce no Brasil: resgata uma vez, e o resgate na saida devolve", () => {
    const { estado, acoes } = rodar([ENTROU, CONECTANDO, emCasa, CONECTANDO, naSaida]);
    assert.equal(acoes.filter(a => a.resgatar).length, 1);
    assert.equal(pegou(acoes), 1, "o CONNECTING do reconnect() nao abre outro emprestimo");
    assert.deepEqual(devolucoes(acoes), ["depoisDaFolga"]);
    assert.ok(!acoes.some(a => a.aviso));
    assert.deepEqual(estado, VOZ_INICIAL);
});

test("o resgate que nasce no Brasil de novo avisa e para: nada de laco de reconexao", () => {
    const { estado, acoes } = rodar([ENTROU, CONECTANDO, emCasa, CONECTANDO, emCasa]);
    assert.equal(acoes.filter(a => a.resgatar).length, 1, "um resgate por nascimento");
    assert.deepEqual(devolucoes(acoes), ["agora"]);
    assert.equal(acoes.at(-1).aviso, AVISO_VOZ_FORA);
    assert.deepEqual(estado, VOZ_INICIAL);
});

test("o aviso diz o que fazer, e fala da camera dos dois lados", () => {
    assert.match(AVISO_VOZ_FORA, /camera/);
    assert.match(AVISO_VOZ_FORA, /nem a sua, nem a dos outros/);
    assert.match(AVISO_VOZ_FORA, /Saia da call e entre de novo/);
});

test("reconexao sozinha, sem clique, pega emprestimo e confere", () => {
    // A voz ja tinha nascido bem e o emprestimo foi devolvido. O Discord reconecta sozinho
    // (troca de servidor de voz, rede): a voz nasce de novo e precisa do completo de novo.
    const { acoes } = rodar([ENTROU, CONECTANDO, naSaida, CONECTANDO, emCasa, CONECTANDO, naSaida]);
    assert.equal(pegou(acoes), 2, "um para a entrada, um para a reconexao");
    assert.equal(acoes.filter(a => a.resgatar).length, 1);
    assert.deepEqual(devolucoes(acoes), ["depoisDaFolga", "depoisDaFolga"]);
});

test("cada nascimento tem direito ao seu resgate", () => {
    // O primeiro nascimento esgotou o resgate e avisou. Uma reconexao depois e outro nascimento.
    const { acoes } = rodar([ENTROU, CONECTANDO, emCasa, CONECTANDO, emCasa, CONECTANDO, emCasa]);
    assert.equal(acoes.filter(a => a.resgatar).length, 2);
});

test("trocar de canal com um resgate em andamento zera o resgate, sem abrir outro emprestimo", () => {
    const { estado, acoes } = rodar([ENTROU, CONECTANDO, emCasa, ENTROU]);
    assert.equal(pegou(acoes), 1);
    assert.deepEqual(estado, { emprestimo: true, resgatando: false });
});

test("sair da call devolve o que estiver aberto", () => {
    const { estado, acoes } = rodar([ENTROU, CONECTANDO, { tipo: "saiu" }]);
    assert.deepEqual(devolucoes(acoes), ["agora"]);
    assert.deepEqual(estado, VOZ_INICIAL);
});

test("sair sem nada aberto nao devolve nada", () => {
    const { acoes } = rodar([{ tipo: "saiu" }]);
    assert.deepEqual(devolucoes(acoes), []);
});

test("prazo vencido sem conectar devolve: o tunel nao pode ficar preso no completo", () => {
    const { estado, acoes } = rodar([ENTROU, CONECTANDO, { tipo: "expirou" }]);
    assert.deepEqual(devolucoes(acoes), ["agora"]);
    assert.deepEqual(estado, VOZ_INICIAL);
    assert.ok(PRAZO_VOZ_MS > 2_500, "uma entrada com troca no meio leva ~2,5 s");
});

test("localAddress ilegivel devolve sem resgatar", () => {
    // Resgatar as cegas custaria um soluco de voz em toda entrada em que o getStats vier vazio.
    for (const localAddress of [null, ""]) {
        const { acoes } = rodar([ENTROU, CONECTANDO, { tipo: "conectada", localAddress }]);
        assert.deepEqual(devolucoes(acoes), ["agora"]);
        assert.ok(!acoes.some(a => a.resgatar));
        assert.ok(!acoes.some(a => a.aviso));
    }
});

test("voz no Brasil sem emprestimo aberto pega um para o resgate", () => {
    // O plugin ligou no meio de uma call, ou o prazo venceu antes do CONNECTED: o resgate
    // precisa do completo, entao pega o emprestimo ali.
    const { acoes, estado } = rodar([emCasa]);
    assert.equal(pegou(acoes), 1);
    assert.equal(acoes[0].resgatar, true);
    assert.deepEqual(estado, { emprestimo: true, resgatando: true });
});

test("voz na saida sem emprestimo aberto nao devolve nada", () => {
    const { acoes } = rodar([naSaida]);
    assert.deepEqual(devolucoes(acoes), []);
    assert.equal(pegou(acoes), 0);
});

test("desligado, nao pega nem resgata -- e fecha o que tiver ficado aberto", () => {
    const desligado = { ativo: false, saida: SAIDA };
    const { acoes } = rodar([ENTROU, CONECTANDO, emCasa], desligado);
    assert.equal(pegou(acoes), 0);
    assert.ok(!acoes.some(a => a.resgatar || a.aviso));

    const aberto = rodar([ENTROU], CTX).estado;
    const r = decidirVoz(aberto, CONECTANDO, desligado);
    assert.equal(r.acao.devolver, "agora");
    assert.deepEqual(r.estado, VOZ_INICIAL);
});

test("a decisao e pura: nao muda o estado que recebeu", () => {
    const estado = { emprestimo: false, resgatando: false };
    decidirVoz(estado, ENTROU, CTX);
    decidirVoz(estado, emCasa, CTX);
    assert.deepEqual(estado, { emprestimo: false, resgatando: false });
});
