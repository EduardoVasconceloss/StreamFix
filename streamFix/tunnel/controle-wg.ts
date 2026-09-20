// O `Controle` do macOS: sobe e derruba o tunel por `wg-quick`, e confere o que subiu.
//
// Mesma interface do `controle.ts` do WireSock, e pelo mesmo desenho: tudo aqui e decisao e
// leitura, quem executa processo e injetado, e por isso o Node carrega este arquivo por
// `require()` direto e os testes rodam contra a producao.
//
// Escrito a partir de `docs/research/wg-quick-no-darwin-2026-09-17.md`, medido num runner
// `macos-latest` com `wireguard-tools v1.0.20260223`. Quatro achados de la governam este
// arquivo, e os quatro contrariam o que o lado WireSock ensinou:
//
//   1. **O nome do perfil nao passa de 15 caracteres.** O `wg-quick` so aceita nome que case com
//      `^[a-zA-Z0-9_=+.-]{1,15}$`, e um nome maior nem chega a ser procurado: ele cai num
//      `does not exist` com o arquivo presente, numa mensagem que aponta para o lugar errado.
//      Os nomes do Windows (`streamfix-santiago`, 18; `streamfix-santiago-controle`, 27) nao
//      cabem.
//   2. **`wg show <perfil>` nao resolve o nome do perfil.** O mapeamento existe em
//      `/var/run/wireguard/<perfil>.name`, mas o `wg` nao o consulta -- ele so entende `utunN`.
//   3. **Ler estado tambem exige root**, porque o socket de controle e o `.name` sao os dois
//      so-root. Isso decide a forma da identificacao (ver `INDENTIFICACAO` abaixo) e a regra de
//      sudoers que o instalador escreve.
//   4. **`up` dar certo NAO significa tunel de pe.** Com o peer morto o `wg-quick up` devolve 0 e
//      monta a interface inteira. O WireGuard nao tem conexao: quem quiser saber se o tunel
//      funciona tem de olhar o handshake. Em troca, nada aqui bloqueia -- nao ha o
//      `PRAZO_CONEXAO_MS` que o lado WireSock precisou.
//
// ## INDENTIFICACAO: por que o perfil e identificado pelos destinos que carrega
//
// Os achados 2 e 3 juntos fecham o caminho obvio. Para saber qual `utunN` e qual perfil seria
// preciso ler o `.name`, que e so-root; e liberar um `cat` como root na regra de sudoers abriria
// leitura de qualquer arquivo da maquina, o que e um preco absurdo por um mapeamento.
//
// Entao a identidade de um perfil aqui e **o conjunto de destinos que a interface dele carrega**,
// lido de `wg show all allowed-ips`. Funciona porque o tunel em dois niveis ja garante que os
// dois perfis carregam conjuntos diferentes -- e essa e a propria definicao dos niveis: o
// controle leva a `FAIXA_CONTROLE`, o completo leva tudo.
//
// O ganho e que a mesma leitura serve de **asserção do que foi aplicado**, que e o papel que o
// `AllowedApps=` do log do `connect` faz no lado WireSock. A licao mais cara do projeto -- um
// tunel que sobe, parece certo, e esta levando coisa demais -- continua coberta.
//
// Sem imports, para o Node carregar direto nos testes. Mesma razao de coletor.ts e perfil.ts.

import type { Controle, EstadoTunel, Executar, Resultado } from "./controle";

// ---------------------------------------------------------------------------------------------
// Constantes do ambiente
// ---------------------------------------------------------------------------------------------

/**
 * O limite de tamanho do nome do perfil, do proprio `wg-quick` (linha 49 do script, medido em
 * 17/09). Nao e estetica: um nome maior produz um erro que culpa o arquivo.
 */
export const LIMITE_NOME = 15;

/** A regra exata do `wg-quick`, copiada do script. */
export const NOME_VALIDO = /^[a-zA-Z0-9_=+.-]{1,15}$/;

/**
 * Os caminhos padrao no Apple Silicon. No Intel o Homebrew vive em `/usr/local`, entao o
 * instalador descobre e passa o que achou -- estes sao so o palpite razoavel.
 */
export const WG_QUICK_PADRAO = "/opt/homebrew/bin/wg-quick";
export const WG_PADRAO = "/opt/homebrew/bin/wg";

/**
 * O `wg-quick` exige bash 4+, e o macOS traz o 3.2 -- entao ele e sempre chamado por um
 * interpretador explicito, nunca direto.
 *
 * Medido em 20/09, num Mac de verdade: `sudo wg-quick up` responde "Version mismatch: bash 3
 * detected, when bash 4+ required" e nao sobe nada. A Apple parou no bash 3.2 por licenca, e
 * quem tem um bash moderno e o Homebrew.
 *
 * **Por que a medicao no CI nao pegou isto.** O runner do GitHub ja tem o bash do Homebrew no
 * PATH, entao la o `#!/usr/bin/env bash` do wg-quick encontrava um bash 5 e tudo funcionava. Num
 * Mac comum, sob `sudo`, o PATH e higienizado e o `env bash` acha o `/bin/bash` 3.2 da Apple. O
 * modo de falha so existe na combinacao "Mac de verdade + sudo" -- que e exatamente a combinacao
 * em que o StreamFix roda.
 *
 * Chamar o interpretador pelo caminho absoluto tambem e o que deixa a regra de sudoers ser
 * exata: ela lista `<bash> <wg-quick> up <perfil>`, sem curinga nenhum.
 */
export const BASH4_PADRAO = "/opt/homebrew/bin/bash";

/**
 * Onde o instalador escreve os perfis. E o primeiro dos `CONFIG_SEARCH_PATHS` do `wg-quick`
 * (`/etc/wireguard`, `/usr/local/etc/wireguard`, `/opt/homebrew/etc/wireguard`), e o unico dos
 * tres que nao muda com a arquitetura.
 *
 * O diretorio e `drwxr-xr-x root wheel`: da para LISTAR sem privilegio, ainda que os `.conf`
 * dentro dele sejam `600 root`. E por isso que `existe()` consegue responder sem sudo.
 */
export const DIR_PERFIS = "/etc/wireguard";

/** Toda operacao de `wg-quick` e local e responde rapido. Nenhuma delas espera rede. */
export const PRAZO_CURTO_MS = 5_000;

/**
 * Quanto esperar o handshake fechar depois do `up`.
 *
 * No Windows a conexao boa levou 793 ms (medido em 11/09) -- e la o CLI ja devolvia so depois de
 * fechar. Aqui o `up` volta na hora e quem espera somos nos. Cinco segundos e folga larga sobre
 * aquele numero, e o custo de errar para mais e so latencia no clique do Go Live.
 */
export const PRAZO_HANDSHAKE_MS = 5_000;

/** Intervalo entre releituras do handshake. */
export const INTERVALO_HANDSHAKE_MS = 250;

// ---------------------------------------------------------------------------------------------
// Nomes
// ---------------------------------------------------------------------------------------------

/** O nome cabe no que o `wg-quick` aceita? */
export function nomeValido(perfil: string): boolean {
    return NOME_VALIDO.test(perfil ?? "");
}

/**
 * O nome do perfil de controle, a partir do completo, cabendo nos 15 caracteres.
 *
 * O `perfilDeControle()` de `perfil.ts` acrescenta `-controle`, que sozinho come 9 dos 15 e so
 * deixa 6 para o nome base. Aqui o sufixo e `-ctl`, e o nome base e truncado quando precisa.
 *
 * Truncar e feio, e e melhor do que a alternativa: um nome longo demais faz o `wg-quick` recusar
 * com uma mensagem que culpa o arquivo, e o instalador diria "perfil nao existe" sobre um perfil
 * que ele mesmo acabou de escrever.
 */
export const SUFIXO_CONTROLE = "-ctl";

export function perfilDeControleCurto(completo: string): string {
    const base = (completo ?? "").slice(0, LIMITE_NOME - SUFIXO_CONTROLE.length);
    return `${base}${SUFIXO_CONTROLE}`;
}

// ---------------------------------------------------------------------------------------------
// Leitura da saida do `wg`
// ---------------------------------------------------------------------------------------------

/**
 * Normaliza uma lista de destinos para comparacao.
 *
 * O perfil declara `162.159.128.0/17, 1.1.1.1/32`; o `wg` reporta `1.1.1.1/32 162.159.128.0/17`,
 * separado por espaco e em outra ordem. Comparar texto cru daria diferente para a mesma coisa,
 * e a consequencia seria o controle achar que nenhuma interface e o perfil pedido -- ou seja,
 * recusar toda transmissao boa.
 */
export function normalizarDestinos(texto: string): string[] {
    return (texto ?? "")
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .sort();
}

/** Dois conjuntos de destinos sao o mesmo? */
export function mesmosDestinos(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Le `wg show all allowed-ips`.
 *
 * O formato e `interface<TAB>chave-publica-do-peer<TAB>destinos`, uma linha por peer. Como os
 * nossos perfis tem um peer so, cada interface aparece uma vez -- mas a leitura acumula por
 * interface mesmo assim, porque um perfil com dois peers nao seria erro, seria so outra coisa.
 *
 * Linha malformada e ignorada em silencio, do mesmo jeito que `mensagensDoLog` ignora linha que
 * nao e JSON: e ruido, nao erro.
 */
export function destinosPorInterface(saida: string): Map<string, string[]> {
    const fora = new Map<string, string[]>();
    for (const linha of (saida ?? "").split(/\r?\n/)) {
        const partes = linha.split("\t");
        if (partes.length < 3) continue;
        const iface = partes[0].trim();
        if (iface.length === 0) continue;
        const destinos = normalizarDestinos(partes.slice(2).join(" "));
        if (destinos.length === 0) continue;
        const ja = fora.get(iface) ?? [];
        fora.set(iface, [...ja, ...destinos].sort());
    }
    return fora;
}

/**
 * Qual interface esta carregando exatamente estes destinos.
 *
 * `null` quando nenhuma esta. Ver INDENTIFICACAO no topo: e assim que um perfil e reconhecido no
 * Darwin, porque o nome dele nao aparece em resposta nenhuma do `wg`.
 */
export function interfaceComDestinos(
    porInterface: Map<string, string[]>,
    esperados: string[]
): string | null {
    const alvo = [...esperados].sort();
    for (const [iface, destinos] of porInterface) {
        if (mesmosDestinos(destinos, alvo)) return iface;
    }
    return null;
}

/**
 * Le `wg show all latest-handshakes` e diz se a interface ja fechou handshake.
 *
 * O formato e `interface<TAB>chave<TAB>timestamp-unix`, e `0` significa "nunca". Este e o unico
 * sinal que distingue um tunel de pe de um tunel que so *existe* -- ver achado 4 no topo.
 */
export function fechouHandshake(saida: string, iface: string): boolean {
    for (const linha of (saida ?? "").split(/\r?\n/)) {
        const partes = linha.split("\t");
        if (partes.length < 3) continue;
        if (partes[0].trim() !== iface) continue;
        const quando = Number.parseInt(partes[2].trim(), 10);
        if (Number.isFinite(quando) && quando > 0) return true;
    }
    return false;
}

/**
 * Le a listagem do diretorio de perfis e devolve os nomes, sem `.conf`.
 *
 * Usa `ls -1`, que imprime um nome por linha. O diretorio e legivel por qualquer um; so o
 * conteudo dos arquivos e que nao e.
 */
export function perfisDaListagem(saida: string): string[] {
    return (saida ?? "")
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.endsWith(".conf"))
        .map(l => l.replace(/\.conf$/, ""));
}

// ---------------------------------------------------------------------------------------------
// O controle
// ---------------------------------------------------------------------------------------------

export interface OpcoesControleWg {
    executar: Executar;
    /**
     * Os perfis que este controle conhece, e os destinos que cada um deve carregar.
     *
     * Nao e configuracao opcional: e a tabela de identidade. Sem ela nao ha como dizer qual
     * `utunN` e qual perfil (ver INDENTIFICACAO no topo).
     */
    perfis: Record<string, string>;
    wgQuick?: string;
    wg?: string;
    /** O bash 4+ que executa o `wg-quick`. Ver `BASH4_PADRAO`. */
    bash?: string;
    dirPerfis?: string;
    dormir?: (ms: number) => Promise<void>;
    agora?: () => number;
    prazoHandshakeMs?: number;
}

const espera = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function controleWgQuick(opcoes: OpcoesControleWg): Controle {
    const wgQuick = opcoes.wgQuick ?? WG_QUICK_PADRAO;
    const wg = opcoes.wg ?? WG_PADRAO;
    const bash = opcoes.bash ?? BASH4_PADRAO;
    const dirPerfis = opcoes.dirPerfis ?? DIR_PERFIS;
    const dormir = opcoes.dormir ?? espera;
    const agora = opcoes.agora ?? Date.now;
    const prazoHandshake = opcoes.prazoHandshakeMs ?? PRAZO_HANDSHAKE_MS;

    const destinosDe = (perfil: string) => normalizarDestinos(opcoes.perfis[perfil] ?? "");

    /**
     * Tudo vai por `sudo -n`. O `-n` e o que importa: sem ele, um sudo sem regra ficaria
     * pendurado esperando senha num prompt que ninguem ve -- e isso aconteceria dentro do clique
     * do Go Live. Com `-n`, ele falha na hora, e a falha vira recusa com motivo.
     */
    const rodar = (...args: string[]) =>
        opcoes.executar("sudo", ["-n", ...args], { tempoLimiteMs: PRAZO_CURTO_MS });

    /** `wg show all allowed-ips`, ja lido. Mapa vazio quando nao deu para perguntar. */
    async function mapaAtual(): Promise<Map<string, string[]> | null> {
        try {
            return destinosPorInterface(await rodar(wg, "show", "all", "allowed-ips"));
        } catch {
            // Sem regra de sudoers, `wg` ausente, servico fora. Nada disso e "o tunel esta fora".
            return null;
        }
    }

    /** O `utunN` que este perfil esta usando agora, ou `null`. */
    async function interfaceDo(perfil: string): Promise<string | null | "desconhecido"> {
        const mapa = await mapaAtual();
        if (mapa === null) return "desconhecido";
        return interfaceComDestinos(mapa, destinosDe(perfil));
    }

    /**
     * O estado do perfil.
     *
     * Tres estados, e `desconhecido` nunca colapsa em `fora` -- mesma razao documentada no
     * `controle.ts`: tratar "nao sei" como "fora" faria o porteiro liberar uma transmissao
     * condenada, e tratar como "conectado" faria o contrario.
     *
     * **Uma interface de pe sem handshake conta como `fora`**, e isso e o achado 4 virando
     * codigo: no Darwin a interface existir nao prova nada.
     */
    async function estado(perfil: string): Promise<EstadoTunel> {
        const iface = await interfaceDo(perfil);
        if (iface === "desconhecido") return "desconhecido";
        if (iface === null) return "fora";
        try {
            const hs = await rodar(wg, "show", "all", "latest-handshakes");
            return fechouHandshake(hs, iface) ? "conectado" : "fora";
        } catch {
            return "desconhecido";
        }
    }

    /** Espera o handshake fechar, ate o prazo. */
    async function esperarHandshake(iface: string): Promise<boolean> {
        const limite = agora() + prazoHandshake;
        for (;;) {
            try {
                if (fechouHandshake(await rodar(wg, "show", "all", "latest-handshakes"), iface)) {
                    return true;
                }
            } catch {
                return false;
            }
            if (agora() >= limite) return false;
            await dormir(INTERVALO_HANDSHAKE_MS);
        }
    }

    /**
     * Sobe um perfil, e so declara sucesso depois de conferir o que ele aplicou E que o tunel
     * fechou handshake.
     *
     * As duas conferencias tem papeis diferentes:
     *
     *   - **os destinos** cobrem o modo de falha caro do projeto -- um tunel que sobe carregando
     *     coisa diferente da que o perfil pedia. E o papel que o `AllowedApps=` faz no Windows.
     *   - **o handshake** cobre o achado 4: `up` devolve 0 com o peer morto.
     *
     * Falhar em qualquer uma das duas significa **derrubar**. Um tunel que subiu errado nao pode
     * ficar de pe enquanto a pessoa le a mensagem de erro -- e a mesma regra do `controle.ts`.
     */
    async function subir(perfil: string): Promise<Resultado> {
        if (!nomeValido(perfil)) {
            return {
                ok: false,
                motivo: `o wg-quick nao aceita o nome "${perfil}": ele so aceita ate ${LIMITE_NOME}`
                    + ` caracteres, e recusaria dizendo que o perfil nao existe`
            };
        }
        if (destinosDe(perfil).length === 0) {
            return { ok: false, motivo: `nao sei quais destinos o perfil ${perfil} deveria carregar` };
        }

        try {
            await rodar(bash, wgQuick, "up", perfil);
        } catch (e) {
            return { ok: false, motivo: `falha ao subir o tunel: ${(e as Error)?.message ?? e}` };
        }

        // A interface e procurada pelos destinos, e nao achar ja e a resposta: ou o `up` nao
        // montou nada, ou montou carregando outra coisa. Os dois sao recusa.
        const iface = await interfaceDo(perfil);
        if (iface === "desconhecido") {
            await derrubarPerfil(perfil);
            return { ok: false, motivo: "nao consegui ler o estado do tunel depois de subi-lo" };
        }
        if (iface === null) {
            await derrubarPerfil(perfil);
            const mapa = await mapaAtual();
            const visto = mapa === null
                ? "nada"
                : [...mapa.entries()].map(([i, d]) => `${i}: ${d.join(" ")}`).join("; ") || "nada";
            return {
                ok: false,
                motivo: `o tunel subiu carregando destinos diferentes dos que o perfil ${perfil}`
                    + ` pedia (esperado: ${destinosDe(perfil).join(" ")}; no ar: ${visto})`
            };
        }

        if (!await esperarHandshake(iface)) {
            await derrubarPerfil(perfil);
            return {
                ok: false,
                motivo: `o tunel subiu mas nao fechou handshake com a saida em ${prazoHandshake} ms`
                    + " -- a saida pode estar fora do ar, a chave revogada, ou o UDP bloqueado na rede"
            };
        }

        return { ok: true, saida: "" };
    }

    /** Derruba um perfil especifico. Derrubar o que ja esta fora nao e erro. */
    async function derrubarPerfil(perfil: string): Promise<void> {
        try {
            await rodar(bash, wgQuick, "down", perfil);
        } catch {
            // Medido em 17/09: `down` de quem nao esta de pe devolve 1 com "does not exist".
            // Nao ha nada melhor a fazer aqui, e nao e falha.
        }
    }

    /**
     * Derruba todos os perfis que este controle conhece.
     *
     * O `Controle` do WireSock tem um `disconnect` global, porque la so existe um tunel por vez.
     * Aqui nao: duas interfaces coexistem (achado 6 da medicao), entao "derrubar" tem de nomear
     * o que derruba. Derruba so o que e nosso -- um WireGuard de outra coisa na maquina nao e
     * da nossa conta.
     */
    async function derrubar(): Promise<void> {
        for (const perfil of Object.keys(opcoes.perfis)) {
            await derrubarPerfil(perfil);
        }
    }

    async function perfilAtivo(candidatos: string[]): Promise<string | null | "desconhecido"> {
        const mapa = await mapaAtual();
        if (mapa === null) return "desconhecido";
        for (const perfil of candidatos) {
            const destinos = destinosDe(perfil);
            if (destinos.length === 0) continue;
            if (interfaceComDestinos(mapa, destinos) !== null) return perfil;
        }
        return null;
    }

    /**
     * Poe `para` no ar no lugar do que estiver.
     *
     * **Sobe antes de derrubar**, e essa e a diferenca boa em relacao ao Windows. La o `connect`
     * e recusado com outro perfil de pe, entao o `trocar` do `controle.ts` precisa derrubar
     * primeiro -- e existe um instante sem tunel nenhum, que o gateway do Discord sobrevive por
     * sorte de desenho. Aqui as duas interfaces coexistem (medido em 17/09), e a ordem inversa
     * elimina o buraco.
     *
     * Enquanto as duas estao de pe quem decide o trafego e a especificidade da rota, e os dois
     * perfis saem pela mesma VPS -- entao o instante de sobreposicao nao muda por onde nada sai.
     */
    async function trocar(para: string): Promise<Resultado & { duracaoMs: number }> {
        const inicio = agora();

        if (await estado(para) === "conectado") {
            return { ok: true, saida: "", duracaoMs: agora() - inicio };
        }

        const r = await subir(para);
        if (!r.ok) return { ...r, duracaoMs: agora() - inicio };

        // Derrubar os outros so depois de o novo estar de pe e conferido.
        for (const perfil of Object.keys(opcoes.perfis)) {
            if (perfil !== para) await derrubarPerfil(perfil);
        }

        return { ...r, duracaoMs: agora() - inicio };
    }

    /**
     * Se o perfil esta escrito no disco.
     *
     * Nao precisa de sudo: o diretorio e `drwxr-xr-x`, so os `.conf` dentro dele e que sao
     * `600 root`. Listar basta, e ler nao e preciso.
     *
     * **Nao saber e um terceiro estado**, pela mesma razao do `controle.ts`: logo depois do boot
     * uma leitura que falha nao pode ser lida como "o perfil nao existe", ou o plugin ficaria no
     * completo pela sessao inteira sem tentar de novo.
     */
    async function existe(perfil: string): Promise<boolean | "desconhecido"> {
        let listagem: string;
        try {
            listagem = await opcoes.executar("/bin/ls", ["-1", dirPerfis], {
                tempoLimiteMs: PRAZO_CURTO_MS
            });
        } catch {
            return "desconhecido";
        }
        if (listagem.trim().length === 0) return "desconhecido";
        return perfisDaListagem(listagem).includes(perfil);
    }

    return { subir, derrubar, estado, perfilAtivo, trocar, existe };
}
