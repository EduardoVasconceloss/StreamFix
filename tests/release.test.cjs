/*
 * O que a release publica.
 *
 * O build lista os arquivos em TRES lugares -- o calculo dos hashes, o artefato do build, e o
 * upload para a release. Nada liga uma lista a outra, entao esquecer uma e silencioso: o
 * arquivo simplesmente nao aparece na release, e so quem tenta usar descobre.
 *
 * Foi o que aconteceu com o `Verifica-Tunel.ps1`. O README manda rodar `.\Verifica-Tunel.ps1`
 * desde a fase 8, e ele nunca foi publicado -- quem seguisse a instrucao nao acharia o arquivo.
 * O mesmo ia acontecer com o diagnostico.
 */

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const RAIZ = resolve(__dirname, "..");
const FLUXO = readFileSync(join(RAIZ, ".github", "workflows", "build-installer.yml"), "utf8");
const README = readFileSync(join(RAIZ, "README.md"), "utf8");

/** O `SHA256SUMS.txt` e produzido pelo build, nao versionado: fica fora das comparacoes. */
const GERADO = "SHA256SUMS.txt";

function lista(trecho) {
    return [...trecho.matchAll(/installer\/([A-Za-z0-9._-]+)/g)]
        .map(m => m[1])
        .filter(nome => nome !== GERADO);
}

const HASHES = lista(/\$files = @\(([\s\S]*?)\n\s*\)/.exec(FLUXO)[1]);
const ARTEFATO = lista(/name: streamfix-installer[\s\S]*?path: \|([\s\S]*?)\n\n/.exec(FLUXO)[1]);
const RELEASE = lista(/gh release upload[\s\S]*?--clobber/.exec(FLUXO)[0]);

test("o build acha os tres blocos de arquivos", () => {
    // Se o workflow for reescrito e estas extracoes pararem de casar, os testes abaixo
    // passariam a comparar listas vazias -- e nao guardariam mais nada.
    for (const [nome, l] of [["hashes", HASHES], ["artefato", ARTEFATO], ["release", RELEASE]]) {
        assert.ok(l.length >= 5, `a lista de ${nome} saiu com ${l.length} arquivos`);
    }
});

test("as tres listas sao iguais", () => {
    const ordenar = l => [...l].sort();
    assert.deepEqual(ordenar(ARTEFATO), ordenar(HASHES), "artefato difere dos hashes");
    assert.deepEqual(ordenar(RELEASE), ordenar(HASHES), "release difere dos hashes");
});

test("todo arquivo publicado existe no repositorio", () => {
    // O `.exe` e compilado durante o build, entao ele e a unica excecao.
    for (const nome of HASHES) {
        if (nome.endsWith(".exe")) continue;
        assert.ok(existsSync(join(RAIZ, "installer", nome)), `${nome} e publicado e nao existe`);
    }
});

test("todo script que o README manda rodar e publicado", () => {
    // A regra que pega o caso do Verifica-Tunel: se a documentacao manda a pessoa rodar algo,
    // ela precisa conseguir baixar esse algo.
    const citados = new Set(
        [...README.matchAll(/\.\\([A-Za-z0-9._-]+\.(?:ps1|bat))/g)].map(m => m[1])
    );

    assert.ok(citados.size > 0, "o teste nao achou nenhum script citado no README");
    for (const nome of citados) {
        assert.ok(HASHES.includes(nome), `o README manda rodar ${nome}, que a release nao publica`);
    }
});

test("todo .ps1 do instalador tem como ser rodado por quem nao mexe em politica de execucao", () => {
    // Rodar um .ps1 baixado falha com "nao esta assinado digitalmente" na maioria das
    // maquinas. Quem precisa de diagnostico ja esta com um problema e nao merece dois: todo
    // script feito para o usuario final precisa de um .bat que o chame com -ExecutionPolicy
    // Bypass, ou de ser chamado por outro script que ja passou por isso.
    const comLancador = ["StreamFix-Installer.ps1", "Diagnostico-Tunel.ps1"];
    for (const ps1 of comLancador) {
        const bat = ps1.replace(/\.ps1$/, ".bat");
        assert.ok(HASHES.includes(bat), `${ps1} e publicado sem o ${bat} que o roda`);

        const fonte = readFileSync(join(RAIZ, "installer", bat), "utf8");
        assert.match(fonte, /-ExecutionPolicy Bypass/, `${bat} nao contorna a politica de execucao`);
    }
});
