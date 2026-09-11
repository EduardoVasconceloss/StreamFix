// A entrada numa transmissao alheia: o lado de quem assiste.
//
// **O gancho e sincrono, e isso decide o desenho todo.** As duas funcoes que entram numa
// transmissao (`A9` e `Nl` do modulo 401843) despacham `STREAM_WATCH` e retornam. Nao da para
// esperar o tunel dentro delas sem torna-las assincronas e mudar a ordem para quem as chama.
// Entao o padrao nao e segurar: e **abortar e repetir**. Aborta a entrada, sobe o tunel, e
// chama a funcao original de novo -- uma vez so.
//
// **A repeticao e de uma tentativa, nunca reentrante.** E por isso que `jaTentou` existe: sem
// ele, tunel que nao sobe vira laco infinito de entrar-abortar-subir-entrar.
//
// **Na falha, nao entra.** A spec e explicita (secao 4.3): "o comportamento na falha e desistir
// da entrada com aviso, nunca entrar mesmo assim". Entrar sem tunel da tela preta, e por F2
// pode derrubar mais gente junto.
//
// Sem imports, para o Node carregar direto nos testes.

export type EstadoTunel = "conectado" | "fora" | "desconhecido";

/**
 * Quanto tempo o tunel fica de pe depois de a entrada acontecer.
 *
 * Por 12e a autorizacao de quem assiste **sobrevive** a queda do tunel: medido com o espectador
 * voltando a IP brasileiro e a entrega seguindo por mais de dois minutos a 60 fps. Dez segundos
 * e folga larga sobre os ~800 ms de conexao do tunel, e errar para mais aqui custa alguns
 * segundos de latencia e nada mais.
 */
export const PRAZO_ATE_DERRUBAR_MS = 10_000;

export interface SituacaoDaEntrada {
    /** O porteiro pode ser desligado por quem sabe o que esta fazendo. */
    exigirTunel: boolean;
    /** O ultimo estado conhecido do tunel. Cache, porque o gancho e sincrono e nao pode esperar. */
    tunel: EstadoTunel;
    /** Se esta chamada ja e a repeticao de uma tentativa que abortou. */
    jaTentou: boolean;
    /**
     * Se ja ha um tunel subindo por causa de uma tentativa anterior.
     *
     * Separado de `jaTentou` de proposito. Sao ~800 ms entre abortar e repetir, e clicar de novo
     * nesse intervalo e normal. Sem esta distincao, o segundo clique ouviria "nao consegui subir
     * o tunel" enquanto o tunel esta subindo -- uma mentira, e deste tipo de mentira o projeto
     * ja comeu o bastante.
     */
    preparando: boolean;
}

export interface DecisaoDeEntrada {
    /** Deixar a funcao original seguir. */
    entrar: boolean;
    /** Subir o tunel em segundo plano e repetir a entrada quando ele estiver de pe. */
    prepararTunel: boolean;
    /** O que dizer a pessoa. `null` quando nao ha nada a dizer. */
    aviso: string | null;
}

export function decidirEntrada(s: SituacaoDaEntrada): DecisaoDeEntrada {
    if (!s.exigirTunel) return { entrar: true, prepararTunel: false, aviso: null };
    if (s.tunel === "conectado") return { entrar: true, prepararTunel: false, aviso: null };

    if (s.jaTentou) {
        return {
            entrar: false,
            prepararTunel: false,
            aviso: "StreamFix: nao consegui subir o tunel, entao nao entrei na transmissao."
                + " Sem tunel o Discord recusa a entrega e voce so veria tela preta."
        };
    }

    if (s.preparando) {
        return {
            entrar: false,
            prepararTunel: false,
            aviso: "StreamFix ainda esta subindo o tunel. So um instante."
        };
    }

    return {
        entrar: false,
        prepararTunel: true,
        aviso: "StreamFix esta subindo o tunel para voce assistir. Ja te coloco la."
    };
}

/**
 * Se o tunel que subimos para esta entrada deve cair depois do prazo.
 *
 * **Duas guardas, e as duas importam.** `subimosParaEntrar` protege o tunel permanente de quem
 * transmite (D9): se ele ja estava de pe, a entrada nao e dona dele e nao pode derruba-lo.
 * `transmitindo` e a rede de seguranca -- derrubar o tunel no meio de uma transmissao nossa
 * mataria a entrega que o porteiro acabou de garantir.
 */
export function deveDerrubarDepois(s: { subimosParaEntrar: boolean; transmitindo: boolean; }): boolean {
    return s.subimosParaEntrar && !s.transmitindo;
}
