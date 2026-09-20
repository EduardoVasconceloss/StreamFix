/*
 * Testes do controle do tunel no macOS.
 *
 * As saidas usadas aqui foram copiadas da medicao de 17/09/2026 num runner `macos-latest`
 * (`wireguard-tools v1.0.20260223`), registrada em
 * docs/research/wg-quick-no-darwin-2026-09-17.md. Nao sao inventadas: cada bloco de texto abaixo
 * saiu da execucao real, do mesmo jeito que o controle.test.cjs usa as saidas de verdade do
 * WireSock.
 *
 * Os dois testes centrais sao:
 *
 *   - "recusa e derruba quando os destinos aplicados nao sao os do perfil" -- o pior modo de
 *     falha do projeto no macOS, o tunel de pe carregando coisa diferente da pedida;
 *   - "recusa e derruba quando o handshake nao fecha" -- o achado 4 da medicao, que `up` dar
 *     certo nao significa tunel de pe.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
    controleWgQuick,
    nomeValido, perfilDeControleCurto, normalizarDestinos, mesmosDestinos,
    destinosPorInterface, interfaceComDestinos, fechouHandshake, perfisDaListagem,
    LIMITE_NOME, SUFIXO_CONTROLE, PRAZO_CURTO_MS, WG_QUICK_PADRAO, WG_PADRAO, DIR_PERFIS,
    BASH4_PADRAO,
} = require("../streamFix/tunnel/controle-wg.ts");

const COMPLETO = "streamfix";
const CONTROLE = "streamfix-ctl";

const PERFIS = {
    [COMPLETO]: "0.0.0.0/0",
    [CONTROLE]: "162.159.128.0/17, 1.1.1.1/32",
};

/** Uma chave publica qualquer, no formato que o `wg` imprime. */
const PEER = "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=";

/** `wg show all allowed-ips`, formato medido: interface TAB chave TAB destinos. */
const ALLOWED_IPS_CONTROLE = `utun4\t${PEER}\t1.1.1.1/32 162.159.128.0/17\n`;
const ALLOWED_IPS_COMPLETO = `utun4\t${PEER}\t0.0.0.0/0\n`;
const ALLOWED_IPS_OS_DOIS =
    `utun4\t${PEER}\t0.0.0.0/0\n` +
    `utun5\t${PEER}\t1.1.1.1/32 162.159.128.0/17\n`;
const ALLOWED_IPS_VAZIO = "";

const HANDSHAKE_FECHADO = (iface = "utun4") => `${iface}\t${PEER}\t1789012345\n`;
const HANDSHAKE_NUNCA = (iface = "utun4") => `${iface}\t${PEER}\t0\n`;

/** A listagem de /etc/wireguard, como o `ls -1` a devolve. */
const LISTAGEM = "streamfix-ctl.conf\nstreamfix.conf\n";

/**
 * Um par de CLIs dublado.
 *
 * `roteiro` e consultado por uma chave montada a partir dos argumentos, porque tudo aqui passa
 * por `sudo -n <exe> <subcomando> ...` e o primeiro argumento sozinho nao distingue nada.
 */
function cliFalso(roteiro) {
    const chamadas = [];
    const executar = async (exe, args, opcoes) => {
        chamadas.push(Object.assign([exe, ...args], { prazo: opcoes?.tempoLimiteMs }));
        const chave = chaveDe(exe, args);
        const r = roteiro[chave];
        if (r === undefined) throw new Error(`comando nao roteirizado: ${chave}`);
        if (r instanceof Error) throw r;
        return typeof r === "function" ? r() : r;
    };
    return { executar, chamadas };
}

function chaveDe(exe, args) {
    if (exe === "/bin/ls") return "ls";
    // O wg-quick e sempre executado por um bash 4+ explicito (o macOS traz o 3.2), entao a
    // forma e `sudo -n <bash> <wg-quick> up <perfil>`. O `wg` e binario e vai direto.
    const [, alvo, ...resto] = args;
    const nome = String(alvo).split("/").pop();
    if (nome === "bash") {
        const [script, sub] = resto;
        return `wg-quick ${sub}`;
    }
    if (nome === "wg-quick") return `wg-quick ${resto[0]}`;
    return `wg ${resto.join(" ")}`;
}

/** Monta o controle com relogio e sono falsos, para os testes nao esperarem de verdade. */
function montar(roteiro, extras = {}) {
    const { executar, chamadas } = cliFalso(roteiro);
    let t = 0;
    const controle = controleWgQuick({
        executar,
        perfis: PERFIS,
        dormir: async ms => { t += ms; },
        agora: () => t,
        ...extras,
    });
    return { controle, chamadas };
}

// ---------------------------------------------------------------------------------------------
// Nomes: o achado 1 da medicao
// ---------------------------------------------------------------------------------------------

test("o limite de 15 caracteres do wg-quick reprova os nomes do Windows", () => {
    assert.equal(LIMITE_NOME, 15);
    assert.equal(nomeValido("streamfix-santiago"), false, "18 caracteres");
    assert.equal(nomeValido("streamfix-santiago-controle"), false, "27 caracteres");
    assert.equal(nomeValido(COMPLETO), true);
    assert.equal(nomeValido(CONTROLE), true);
});

test("nome vazio e nome com caractere que o wg-quick nao aceita sao reprovados", () => {
    assert.equal(nomeValido(""), false);
    assert.equal(nomeValido("com espaco"), false);
    assert.equal(nomeValido("barra/dentro"), false);
});

test("o perfil de controle sempre cabe no limite, truncando quando precisa", () => {
    assert.equal(perfilDeControleCurto("streamfix"), "streamfix-ctl");
    // 15 caracteres ja no completo: o base e truncado para caber com o sufixo.
    const longo = perfilDeControleCurto("abcdefghijklmno");
    assert.equal(longo.length <= LIMITE_NOME, true, `"${longo}" passou de ${LIMITE_NOME}`);
    assert.equal(nomeValido(longo), true);
    assert.equal(longo.endsWith(SUFIXO_CONTROLE), true);
});

// ---------------------------------------------------------------------------------------------
// Leitura: a identificacao por destinos
// ---------------------------------------------------------------------------------------------

test("a ordem e o separador dos destinos nao mudam a identidade", () => {
    // O perfil declara com virgula e numa ordem; o `wg` reporta com espaco e noutra.
    assert.deepEqual(
        normalizarDestinos("162.159.128.0/17, 1.1.1.1/32"),
        normalizarDestinos("1.1.1.1/32 162.159.128.0/17")
    );
    assert.equal(
        mesmosDestinos(normalizarDestinos("0.0.0.0/0"), normalizarDestinos(" 0.0.0.0/0 ")),
        true
    );
});

test("le a interface e os destinos do formato real do wg show all allowed-ips", () => {
    const mapa = destinosPorInterface(ALLOWED_IPS_OS_DOIS);
    assert.deepEqual([...mapa.keys()], ["utun4", "utun5"]);
    assert.deepEqual(mapa.get("utun4"), ["0.0.0.0/0"]);
    assert.deepEqual(mapa.get("utun5"), ["1.1.1.1/32", "162.159.128.0/17"]);
});

test("linha malformada e ruido, nao erro", () => {
    const mapa = destinosPorInterface("lixo sem tab\n\n" + ALLOWED_IPS_CONTROLE);
    assert.equal(mapa.size, 1);
    assert.deepEqual(mapa.get("utun4"), ["1.1.1.1/32", "162.159.128.0/17"]);
});

test("acha a interface pelos destinos, e distingue os dois perfis no ar ao mesmo tempo", () => {
    const mapa = destinosPorInterface(ALLOWED_IPS_OS_DOIS);
    assert.equal(interfaceComDestinos(mapa, normalizarDestinos(PERFIS[COMPLETO])), "utun4");
    assert.equal(interfaceComDestinos(mapa, normalizarDestinos(PERFIS[CONTROLE])), "utun5");
    assert.equal(interfaceComDestinos(mapa, ["10.8.0.0/24"]), null);
});

test("um subconjunto dos destinos nao conta como o perfil", () => {
    // Faixa a menos e o caso perigoso: o tunel sobe, parece certo, e nao carrega o que devia.
    const mapa = destinosPorInterface(`utun4\t${PEER}\t162.159.128.0/17\n`);
    assert.equal(interfaceComDestinos(mapa, normalizarDestinos(PERFIS[CONTROLE])), null);
});

test("handshake em 0 significa que nunca fechou", () => {
    assert.equal(fechouHandshake(HANDSHAKE_FECHADO(), "utun4"), true);
    assert.equal(fechouHandshake(HANDSHAKE_NUNCA(), "utun4"), false);
    assert.equal(fechouHandshake(HANDSHAKE_FECHADO("utun5"), "utun4"), false, "outra interface");
    assert.equal(fechouHandshake("", "utun4"), false);
});

test("le os nomes de perfil da listagem do diretorio", () => {
    assert.deepEqual(perfisDaListagem(LISTAGEM), ["streamfix-ctl", "streamfix"]);
    assert.deepEqual(perfisDaListagem("outra-coisa.txt\n"), []);
});

// ---------------------------------------------------------------------------------------------
// subir: as duas conferencias
// ---------------------------------------------------------------------------------------------

test("sobe e confere os destinos e o handshake", async () => {
    const { controle, chamadas } = montar({
        "wg-quick up": "",
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });

    const r = await controle.subir(CONTROLE);
    assert.equal(r.ok, true, r.ok ? "" : r.motivo);
    assert.equal(chamadas.some(c => c.includes("up") && c.includes(CONTROLE)), true);
    // Tudo por `sudo -n`: sem o -n um sudo sem regra ficaria pendurado esperando senha.
    assert.equal(chamadas.every(c => c[0] === "sudo" ? c[1] === "-n" : true), true);
});

test("recusa e derruba quando os destinos aplicados nao sao os do perfil", async () => {
    // O pior modo de falha: pediu o controle e o tunel subiu levando tudo.
    const { controle, chamadas } = montar({
        "wg-quick up": "",
        "wg-quick down": "",
        "wg show all allowed-ips": ALLOWED_IPS_COMPLETO,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });

    const r = await controle.subir(CONTROLE);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /destinos diferentes/);
    assert.match(r.motivo, /0\.0\.0\.0\/0/, "diz o que encontrou no ar");
    assert.equal(
        chamadas.some(c => c.includes("down") && c.includes(CONTROLE)), true,
        "um tunel que subiu errado tem de ser derrubado, nao deixado de pe"
    );
});

test("recusa e derruba quando o handshake nao fecha", async () => {
    // O achado 4: o `up` devolve 0 mesmo com o peer morto.
    const { controle, chamadas } = montar({
        "wg-quick up": "",
        "wg-quick down": "",
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_NUNCA(),
    }, { prazoHandshakeMs: 1000 });

    const r = await controle.subir(CONTROLE);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /handshake/);
    assert.equal(chamadas.some(c => c.includes("down") && c.includes(CONTROLE)), true);
});

test("recusa antes de executar nada quando o nome nao cabe no wg-quick", async () => {
    const { controle, chamadas } = montar({});
    const r = await controle.subir("streamfix-santiago-controle");
    assert.equal(r.ok, false);
    assert.match(r.motivo, /15/);
    assert.equal(chamadas.length, 0, "nao adianta chamar o wg-quick com um nome que ele recusa");
});

test("sem regra de sudoers, a falha vira recusa com motivo -- nao travamento", async () => {
    const { controle } = montar({
        "wg-quick up": new Error("sudo: a password is required"),
    });
    const r = await controle.subir(CONTROLE);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /password is required/);
});

// ---------------------------------------------------------------------------------------------
// estado: e o terceiro estado
// ---------------------------------------------------------------------------------------------

test("interface de pe sem handshake e 'fora', nao 'conectado'", async () => {
    const { controle } = montar({
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_NUNCA(),
    });
    assert.equal(await controle.estado(CONTROLE), "fora");
});

test("nao conseguir perguntar e 'desconhecido', nunca 'fora'", async () => {
    const { controle } = montar({
        "wg show all allowed-ips": new Error("sudo: a password is required"),
    });
    assert.equal(
        await controle.estado(CONTROLE), "desconhecido",
        "ler isto como 'fora' faria o porteiro recusar; como 'conectado', liberaria transmissao condenada"
    );
});

test("nenhuma interface no ar e 'fora'", async () => {
    const { controle } = montar({ "wg show all allowed-ips": ALLOWED_IPS_VAZIO });
    assert.equal(await controle.estado(CONTROLE), "fora");
});

test("perfilAtivo distingue os dois niveis", async () => {
    const { controle } = montar({ "wg show all allowed-ips": ALLOWED_IPS_OS_DOIS });
    assert.equal(await controle.perfilAtivo([COMPLETO, CONTROLE]), COMPLETO);
    assert.equal(await controle.perfilAtivo([CONTROLE]), CONTROLE);
});

test("perfilAtivo devolve null quando nenhum dos candidatos esta no ar", async () => {
    const { controle } = montar({ "wg show all allowed-ips": ALLOWED_IPS_VAZIO });
    assert.equal(await controle.perfilAtivo([COMPLETO, CONTROLE]), null);
});

// ---------------------------------------------------------------------------------------------
// trocar: sobe antes de derrubar
// ---------------------------------------------------------------------------------------------

test("a troca sobe o novo ANTES de derrubar o velho", async () => {
    // A diferenca boa em relacao ao Windows: la o connect e recusado com outro perfil de pe,
    // entao ha um instante sem tunel. Aqui as duas interfaces coexistem.
    let subiuCompleto = false;
    const { controle, chamadas } = montar({
        "wg-quick up": () => { subiuCompleto = true; return ""; },
        "wg-quick down": "",
        "wg show all allowed-ips": () => subiuCompleto ? ALLOWED_IPS_COMPLETO : ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });

    const r = await controle.trocar(COMPLETO);
    assert.equal(r.ok, true, r.ok ? "" : r.motivo);

    const iUp = chamadas.findIndex(c => c.includes("up") && c.includes(COMPLETO));
    const iDown = chamadas.findIndex(c => c.includes("down") && c.includes(CONTROLE));
    assert.notEqual(iUp, -1, "subiu o completo");
    assert.notEqual(iDown, -1, "derrubou o controle");
    assert.equal(iUp < iDown, true, "o novo tem de subir antes de o velho cair");
});

test("trocar para o que ja esta no ar nao faz nada", async () => {
    const { controle, chamadas } = montar({
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });
    const r = await controle.trocar(CONTROLE);
    assert.equal(r.ok, true);
    assert.equal(chamadas.some(c => c.includes("up") || c.includes("down")), false);
});

test("a troca que falha nao derruba o que estava de pe", async () => {
    // Se o novo nao sobe, ficar com o antigo e melhor do que ficar sem nenhum.
    const { controle, chamadas } = montar({
        "wg-quick up": "",
        "wg-quick down": "",
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });

    const r = await controle.trocar(COMPLETO);
    assert.equal(r.ok, false, "o completo nunca aparece no ar, entao a subida falha");
    assert.equal(
        chamadas.some(c => c.includes("down") && c.includes(CONTROLE)), false,
        "o perfil de controle nao pode ser derrubado por uma troca que nao deu certo"
    );
});

test("a troca mede quanto levou", async () => {
    const { controle } = montar({
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });
    const r = await controle.trocar(CONTROLE);
    assert.equal(typeof r.duracaoMs, "number");
});

// ---------------------------------------------------------------------------------------------
// derrubar e existe
// ---------------------------------------------------------------------------------------------

test("derrubar nomeia cada perfil, porque duas interfaces coexistem", async () => {
    const { controle, chamadas } = montar({ "wg-quick down": "" });
    await controle.derrubar();
    assert.equal(chamadas.some(c => c.includes("down") && c.includes(COMPLETO)), true);
    assert.equal(chamadas.some(c => c.includes("down") && c.includes(CONTROLE)), true);
});

test("derrubar o que ja esta fora nao e erro", async () => {
    // Medido em 17/09: `down` de quem nao esta de pe devolve 1 com "does not exist".
    const { controle } = montar({
        "wg-quick down": new Error("wg-quick: `streamfix' does not exist"),
    });
    await controle.derrubar();
});

test("existe le a listagem do diretorio, sem precisar de sudo", async () => {
    const { controle, chamadas } = montar({ ls: LISTAGEM });
    assert.equal(await controle.existe(COMPLETO), true);
    assert.equal(await controle.existe("nao-existe"), false);
    assert.equal(chamadas.every(c => c[0] === "/bin/ls"), true, "listar nao precisa de privilegio");
    assert.equal(chamadas[0].includes(DIR_PERFIS), true);
});

test("nao conseguir listar e 'desconhecido', nunca 'nao existe'", async () => {
    const { controle } = montar({ ls: new Error("ENOENT") });
    assert.equal(
        await controle.existe(COMPLETO), "desconhecido",
        "ler isto como 'nao existe' deixaria o plugin no completo pela sessao inteira"
    );
});

test("listagem vazia tambem e 'desconhecido'", async () => {
    const { controle } = montar({ ls: "" });
    assert.equal(await controle.existe(COMPLETO), "desconhecido");
});

// ---------------------------------------------------------------------------------------------
// Caminhos e prazos
// ---------------------------------------------------------------------------------------------

test("os caminhos padrao sao os do Homebrew no Apple Silicon", () => {
    assert.equal(WG_QUICK_PADRAO, "/opt/homebrew/bin/wg-quick");
    assert.equal(WG_PADRAO, "/opt/homebrew/bin/wg");
    // O primeiro dos CONFIG_SEARCH_PATHS, e o unico que nao muda com a arquitetura.
    assert.equal(DIR_PERFIS, "/etc/wireguard");
});

test("toda chamada leva prazo: nada pode ficar pendurado no clique do Go Live", async () => {
    const { controle, chamadas } = montar({
        "wg show all allowed-ips": ALLOWED_IPS_VAZIO,
    });
    await controle.estado(CONTROLE);
    assert.equal(chamadas.length > 0, true);
    assert.equal(chamadas.every(c => c.prazo === PRAZO_CURTO_MS), true);
});

// ---------------------------------------------------------------------------------------------
// O bash 4: o achado que so um Mac de verdade entregou
// ---------------------------------------------------------------------------------------------

test("o wg-quick e executado por um bash 4+ explicito, nunca direto", async () => {
    // Medido em 20/09 num Mac de verdade: `sudo wg-quick up` responde "Version mismatch: bash 3
    // detected, when bash 4+ required". A Apple parou no bash 3.2, e sob `sudo` o PATH e
    // higienizado, entao o `#!/usr/bin/env bash` do wg-quick acha o /bin/bash da Apple.
    //
    // O CI nao pegou porque o runner do GitHub ja tem o bash do Homebrew no PATH. Este teste
    // existe para que ninguem "simplifique" isto de volta para uma chamada direta.
    const { controle, chamadas } = montar({
        "wg-quick up": "",
        "wg show all allowed-ips": ALLOWED_IPS_CONTROLE,
        "wg show all latest-handshakes": HANDSHAKE_FECHADO(),
    });

    await controle.subir(CONTROLE);

    const up = chamadas.find(c => c.includes("up") && c.includes(CONTROLE));
    assert.notEqual(up, undefined, "chamou o up");
    // sudo, -n, <bash>, <wg-quick>, up, <perfil>
    assert.equal(up[0], "sudo");
    assert.equal(up[1], "-n");
    assert.equal(up[2], BASH4_PADRAO, "o interpretador vem antes do script");
    assert.equal(up[3], WG_QUICK_PADRAO);
});

test("o down tambem passa pelo bash", async () => {
    const { controle, chamadas } = montar({ "wg-quick down": "" });
    await controle.derrubar();
    const down = chamadas.find(c => c.includes("down"));
    assert.equal(down[2], BASH4_PADRAO);
});

test("o wg NAO passa pelo bash: ele e binario, nao script", async () => {
    // Enfiar o `wg` no interpretador tambem quebraria, e por um motivo bobo -- o bash tentaria
    // interpretar um executavel. A distincao importa na regra de sudoers, que lista os dois.
    const { controle, chamadas } = montar({ "wg show all allowed-ips": ALLOWED_IPS_VAZIO });
    await controle.estado(CONTROLE);
    const show = chamadas.find(c => c.includes("show"));
    assert.equal(show[2], WG_PADRAO, "o wg e chamado direto");
});
