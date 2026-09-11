/*
 * O que a release publica.
 *
 * O build lista os arquivos em TRES lugares -- o calculo dos hashes, o artefato do build, e o
 * upload para a release. Nada liga uma lista a outra, entao esquecer uma e silencioso: o
 * arquivo simplesmente nao aparece na release, e so quem tenta usar descobre.
 *
 * Foi o que aconteceu com o `Verifica-Tunel.ps1`. O README manda roda-lo desde a fase 8, e ele
 * nunca foi publicado -- quem seguisse a instrucao nao acharia o arquivo. O mesmo ia acontecer
 * com o diagnostico.
 */

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const RAIZ = resolve(__dirname, "..");

/**
 * Lido com finais de linha normalizados.
 *
 * O git reescreve para CRLF no checkout em Windows. Sem normalizar, o mesmo arquivo casa numa
 * maquina e nao casa na outra -- e o teste passaria a nao guardar nada justamente onde ele roda.
 */
function lerNormalizado(...caminho) {
    return readFileSync(join(RAIZ, ...caminho), "utf8").split(/\r?\n/).join("\n");
}

const FLUXO = lerNormalizado(".github", "workflows", "build-installer.yml");
const README = lerNormalizado("README.md");

/** O `SHA256SUMS.txt` e produzido pelo build, nao versionado: fica fora das comparacoes. */
const GERADO = "SHA256SUMS.txt";

function arquivosEm(trecho) {
    return [...trecho.matchAll(/installer\/([A-Za-z0-9._-]+)/g)]
        .map(m => m[1])
        .filter(nome => nome !== GERADO);
}

/**
 * Recorta um passo do workflow pelo nome.
 *
 * Recortar por linha em branco era fragil: bastava uma mudanca de formatacao para a lista sair
 * vazia e o teste calar. O nome do passo e o que de fato delimita.
 */
function passo(nome) {
    const i = FLUXO.indexOf(nome);
    assert.notEqual(i, -1, `o passo "${nome}" sumiu do workflow`);
    const resto = FLUXO.slice(i + nome.length);
    const fim = resto.search(/\n {6}- name:/);
    return fim < 0 ? resto : resto.slice(0, fim);
}

const HASHES = arquivosEm(passo("Hash the release files"));
const ARTEFATO = arquivosEm(passo("Upload build artifacts"));
const RELEASE = arquivosEm(passo("Attach to release"));

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
    for (const ps1 of ["StreamFix-Installer.ps1", "Diagnostico-Tunel.ps1"]) {
        const bat = ps1.replace(/\.ps1$/, ".bat");
        assert.ok(HASHES.includes(bat), `${ps1} e publicado sem o ${bat} que o roda`);

        const fonte = lerNormalizado("installer", bat);
        assert.match(fonte, /-ExecutionPolicy Bypass/, `${bat} nao contorna a politica de execucao`);
    }
});
