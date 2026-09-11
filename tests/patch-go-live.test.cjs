/*
 * O patch do porteiro, rodado contra o bundle real do Discord.
 *
 * Este e o unico teste automatico que prova que o porteiro esta de fato ligado ao clique do Go
 * Live. Sem ele, um `match` que deixou de casar viraria um plugin que carrega, nao reclama de
 * nada, e simplesmente nunca bloqueia -- falha silenciosa, que e a classe que mais custou caro
 * neste projeto.
 *
 * A fixture e o modulo 560595 do Discord 1.0.9257, extraido por CDP em 11/09/2026 e auditado:
 * sao 2,4 KB de codigo minificado, sem token e sem dado de usuario. Os dois ids que aparecem
 * nele sao de aplicativos, das proprias listas de experimento do Discord.
 *
 * Quando o Discord atualizar e o patch parar de casar, este teste falha **antes** de alguem
 * descobrir transmitindo. Regravar a fixture e parte de consertar.
 */

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const FONTE = readFileSync(resolve(__dirname, "fixtures/modulo-go-live-1.0.9257.js"), "utf8");

// Copia literal do que esta em streamFix/index.tsx. Se divergir, os testes abaixo deixam de
// falar sobre a producao -- por isso o teste final confere que sao iguais.
const FIND = '"startStreamWithSource"';
const MATCH = /(?<="startStreamWithSource"\);.{0,200}?async function \i\(\i,\i\)\{)/;
const REPLACE = "const _sf=await $self.antesDeTransmitir();if(!_sf.ok)return[!1,_sf.motivo];";

/** O Vencord expande `\i` para "identificador" antes de rodar o regex (canonicalizeMatch). */
function canonizar(re, flags) {
    return new RegExp(re.source.replace(/\\i/g, "[A-Za-z_$][\\w$]*"), flags ?? re.flags);
}

test("o find encontra o modulo", () => {
    assert.ok(FONTE.includes(FIND));
});

test("o match casa exatamente uma vez", () => {
    // Mais de uma vez significaria patch em lugar errado, e o Vencord aplicaria no primeiro.
    const todas = FONTE.match(canonizar(MATCH, "g")) ?? [];
    assert.equal(todas.length, 1, `casou ${todas.length} vezes`);
});

test("o corte cai no comeco do corpo da funcao, antes de qualquer decisao", () => {
    const m = canonizar(MATCH).exec(FONTE);
    assert.ok(m, "o match nao casou");
    // Depois do ponto de corte vem a primeira instrucao da funcao. Cortar depois dela deixaria
    // o Discord ja ter comecado a montar a transmissao.
    assert.match(FONTE.slice(m.index, m.index + 40), /^let \w+=\w+\.default\.getCurrentUser\(\)/);
    assert.match(FONTE.slice(m.index - 30, m.index), /async function \w+\(\w+,\w+\)\{$/);
});

test("o protocolo de recusa que o patch imita e o que a funcao ja usa", () => {
    // A razao de o patch poder devolver [!1, motivo] e que a interface do Discord ja sabe lidar
    // com isso -- nao foi preciso inventar recusa nenhuma.
    assert.match(FONTE, /return\[!1,"no user or channel"\]/);
    assert.match(FONTE, /return\[!1,"no source"\]/);
    assert.match(FONTE, /return\[!1,"no permission"\]/);
    assert.match(FONTE, /\[!0,void 0\]/, "o caminho de sucesso devolve a mesma forma");
});

test("a funcao e assincrona: sem isso o await do patch quebraria o modulo", () => {
    assert.match(FONTE, /async function \w+\(\w+,\w+\)\{let \w+=\w+\.default\.getCurrentUser/);
});

test("o modulo continua sintaticamente valido depois do patch", () => {
    const aplicado = FONTE.replace(canonizar(MATCH), REPLACE);
    assert.ok(aplicado.includes("const _sf=await"), "o replace nao entrou");
    assert.doesNotThrow(() => new Function(`return {${aplicado}}`), "o patch quebrou a sintaxe");
});

test("o patch testado aqui e o mesmo que o plugin declara", () => {
    // Sem esta conferencia, este arquivo poderia passar testando um regex que ninguem usa.
    const plugin = readFileSync(resolve(__dirname, "../streamFix/index.tsx"), "utf8");
    assert.ok(plugin.includes(MATCH.source), "o match do plugin divergiu do testado aqui");
    assert.ok(plugin.includes(REPLACE), "o replace do plugin divergiu do testado aqui");
});
