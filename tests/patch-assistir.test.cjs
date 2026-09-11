/*
 * O patch do fluxo de assistir, rodado contra o bundle real do Discord.
 *
 * Mesma razao do irmao `patch-go-live.test.cjs`: sem este teste, um `match` que deixou de casar
 * viraria um plugin que carrega, nao reclama de nada, e deixa a pessoa entrar sem tunel -- que
 * do lado de quem assiste significa tela preta sem explicacao.
 *
 * A fixture e o modulo 401843 do Discord 1.0.9257, extraido por CDP em 11/09/2026 e auditado:
 * 3,1 KB de codigo minificado, sem token e sem dado de usuario.
 */

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const FONTE = readFileSync(resolve(__dirname, "fixtures/modulo-assistir-1.0.9257.js"), "utf8");

// Copia literal do que esta em streamFix/index.tsx. O teste final confere que sao iguais.
const FIND = "Cannot join a null voice channel";
const MATCH = /(?<=function (\i)\(\i,\i\)\{)(?=if\(null!=\i\.default\.getRemoteSessionId\(\)\)return)/;
const REPLACE = "if(!$self.antesDeAssistir(()=>$1(...arguments)))return;";

/** O Vencord expande `\i` para "identificador" antes de rodar o regex (canonicalizeMatch). */
function canonizar(re, flags) {
    return new RegExp(re.source.replace(/\\i/g, "[A-Za-z_$][\\w$]*"), flags ?? re.flags);
}

test("o find encontra o modulo, e a string e unica no bundle", () => {
    // Conferido ao vivo em 11/09: 1 modulo entre 14.773 contem esta string, 1 ocorrencia nele.
    assert.ok(FONTE.includes(FIND));
    assert.equal(FONTE.split(FIND).length - 1, 1);
});

test("o match casa exatamente uma vez", () => {
    const todas = FONTE.match(canonizar(MATCH, "g")) ?? [];
    assert.equal(todas.length, 1, `casou ${todas.length} vezes`);
});

test("o corte cai no comeco do corpo de A9, antes de qualquer despacho", () => {
    const m = canonizar(MATCH).exec(FONTE);
    assert.ok(m, "o match nao casou");
    assert.match(FONTE.slice(m.index - 24, m.index), /function \w+\(\w+,\w+\)\{$/);
    // Cortar depois da primeira instrucao ja teria deixado o STREAM_WATCH mais perto.
    assert.match(FONTE.slice(m.index, m.index + 50), /^if\(null!=\w+\.default\.getRemoteSessionId\(\)\)return;/);
});

test("a funcao capturada e a que o modulo exporta como A9", () => {
    // O $1 do replace e o nome minificado da propria funcao, e e assim que a repeticao chama a
    // original de novo. Se a captura pegasse outro nome, a repeticao chamaria a funcao errada.
    const m = canonizar(MATCH).exec(FONTE);
    const nome = m[1];
    assert.match(FONTE, new RegExp(`A9:\\(\\)=>${nome}\\b`), `A9 nao aponta para ${nome}`);
});

test("Nl delega para A9: por isso um patch so cobre os dois caminhos de entrada", () => {
    // Patchar as duas dispararia o porteiro duas vezes por entrada, e tornaria a repeticao
    // reentrante -- exatamente o laco que este fluxo tem que evitar.
    const m = canonizar(MATCH).exec(FONTE);
    const a9 = m[1];
    const nl = /Nl:\(\)=>(\w+)/.exec(FONTE)?.[1];
    assert.ok(nl, "o modulo nao exporta Nl");
    assert.notEqual(nl, a9, "Nl e A9 deveriam ser funcoes distintas");
    const corpoDeNl = FONTE.slice(FONTE.indexOf(`function ${nl}(`));
    assert.match(corpoDeNl.slice(0, 140), new RegExp(`\\b${a9}\\(\\w+,\\w+\\)`), `${nl} nao chama ${a9}`);
});

test("A9 e sincrona: e por isso que o padrao e abortar e repetir, nao segurar", () => {
    const m = canonizar(MATCH).exec(FONTE);
    const antes = FONTE.slice(Math.max(0, m.index - 40), m.index);
    assert.doesNotMatch(antes, /async\s+function\s+\w+\(\w+,\w+\)\{$/);
});

test("sair pela recusa e o que a propria funcao ja faz", () => {
    // O `return;` do patch imita o caminho que a funcao ja tem: ela retorna sem nada quando ha
    // sessao remota ou quando nao da para entrar no canal de voz. Nao inventamos saida nenhuma.
    assert.match(FONTE, /getRemoteSessionId\(\)\)return;/);
    assert.match(FONTE, /if\(null!=\w+&&\w+\(\w+,\w+\)\)return;/);
});

test("o modulo continua sintaticamente valido depois do patch", () => {
    const aplicado = FONTE.replace(canonizar(MATCH), REPLACE);
    assert.ok(aplicado.includes("$self.antesDeAssistir"), "o replace nao entrou");
    assert.doesNotThrow(() => new Function(`return {${aplicado}}`), "o patch quebrou a sintaxe");
});

test("a repeticao chama a funcao original com os mesmos argumentos", () => {
    const aplicado = FONTE.replace(canonizar(MATCH), REPLACE);
    const nome = canonizar(MATCH).exec(FONTE)[1];
    // `arguments` dentro da arrow e o da funcao que a contem -- arrow nao tem o proprio.
    assert.ok(aplicado.includes(`()=>${nome}(...arguments)`), "a repeticao nao reconstroi a chamada");
});

test("o patch testado aqui e o mesmo que o plugin declara", () => {
    const plugin = readFileSync(resolve(__dirname, "../streamFix/index.tsx"), "utf8");
    assert.ok(plugin.includes(MATCH.source), "o match do plugin divergiu do testado aqui");
    assert.ok(plugin.includes(REPLACE), "o replace do plugin divergiu do testado aqui");
    assert.ok(plugin.includes(FIND), "o find do plugin divergiu do testado aqui");
});
