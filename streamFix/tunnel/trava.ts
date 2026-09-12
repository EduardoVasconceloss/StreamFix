// A Trava 1: o experimento que esconde o Go Live e a camera de quem esta no Brasil.
//
// **Onde ela mora** (pesquisa, 12h): o experimento Apex `2026-08-video-guard`, do tipo `user`.
// O servidor manda a avaliacao dentro do `READY`, decidida pelo IP do gateway, e so dele. As
// variantes 1 e 2 tem `videoEnabled: false`: sao a trava. Sem atribuicao nenhuma, ela nao veio.
//
// **Por que conferir** (spec, E6): o perfil de controle leva so `162.159.128.0/17`, que e onde o
// gateway estava daqui. Se em outro lugar o gateway resolver para fora dessa faixa, ele sai pelo
// Brasil, e a trava volta -- botao cinza, sem explicacao. Conferir a atribuicao depois de cada
// conexao do gateway transforma isso num aviso e numa recuperacao.
//
// **Por que a do servidor, e nao a do cliente.** O plugin Experiments grava um override no
// cliente que esconde a trava so na tela: o botao aparece, e o servidor continua recusando a
// entrega. Foi o confundidor de 12h. A leitura que vale e `getServerAssignment`; o override e
// informacao separada para o `/streamfix`.
//
// Formato lido no Discord 1.0.9257 em 12/09: a atribuicao e um objeto como
// `{ hashedName, variantId, isOverride, revision, ... }`, ou `undefined` quando o servidor nao
// mandou nada. O override de cliente e `{ hashedName, variantId: -1, isOverride: true, ... }`,
// dentro de um mapa pelo nome do experimento.
//
// Sem imports, para o Node carregar direto nos testes.

export const VIDEO_GUARD = "2026-08-video-guard";

/** As variantes que desligam o video. Lidas em 12h; uma variante nova cai em "nao e a trava". */
export const VARIANTES_DA_TRAVA = [1, 2];

/** Quanto tempo depois do `CONNECTION_OPEN` ler a atribuicao: a store a processa no mesmo evento. */
export const ESPERA_DEPOIS_DO_GATEWAY_MS = 3_000;

/**
 * Por quanto tempo a marca de "ja recarreguei por causa da trava" vale.
 *
 * A marca atravessa a recarga (o Discord apaga `localStorage` e `sessionStorage`, entao ela vai
 * no DataStore do Vencord). Curta de proposito: e o que faz ser **uma recarga por abertura do
 * Discord**, e nao uma por todo o sempre.
 */
export const VALIDADE_DA_MARCA_MS = 60_000;

export interface LeituraTrava {
    /** A variante que o servidor mandou; `null` para nenhuma; `ilegivel` para formato inesperado. */
    servidor: number | null | "ilegivel";
    /** A variante do override de cliente, se houver. */
    override: number | null;
    /** A trava veio. */
    trava: boolean;
}

function variante(atribuicao: unknown): number | null | "ilegivel" {
    if (atribuicao === undefined || atribuicao === null) return null;
    const v = (atribuicao as { variantId?: unknown; })?.variantId;
    return typeof atribuicao === "object" && typeof v === "number" ? v : "ilegivel";
}

/**
 * @param servidor o que `getServerAssignment("user", id, VIDEO_GUARD)` devolveu.
 * @param overrides o que `getClientOverrides()` devolveu: um mapa pelo nome do experimento.
 */
export function lerTrava(servidor: unknown, overrides: unknown): LeituraTrava {
    const s = variante(servidor);
    const doCliente = overrides !== null && typeof overrides === "object"
        ? (overrides as Record<string, unknown>)[VIDEO_GUARD]
        : undefined;
    const o = variante(doCliente);
    return {
        servidor: s,
        override: typeof o === "number" ? o : null,
        trava: typeof s === "number" && VARIANTES_DA_TRAVA.includes(s)
    };
}

/** As linhas do `/streamfix`. `null` da store vira frase, nao `null` (plano, fase 7, item 3). */
export function descreverTrava(l: LeituraTrava): string[] {
    const linhas: string[] = [];
    if (l.servidor === null) linhas.push("o servidor nao mandou a trava");
    else if (l.servidor === "ilegivel") linhas.push("nao consegui ler a atribuicao do servidor");
    else if (l.trava) linhas.push(`o servidor mandou a trava (variante ${l.servidor}): o gateway saiu pelo Brasil`);
    else linhas.push(`o servidor mandou a variante ${l.servidor}, que nao e a trava`);

    if (l.override !== null) {
        linhas.push(`override de cliente: variante ${l.override} -- o botao aparece, mas o servidor continua recusando sem tunel`);
    }
    return linhas;
}

export interface SituacaoDaTrava {
    trava: boolean;
    /** O tunel em dois niveis estava valendo, ou seja, o normal era o controle. */
    doisNiveis: boolean;
    /** Ja houve uma recarga por causa da trava nesta abertura do Discord. */
    jaRecarregou: boolean;
}

export interface DecisaoDaTrava {
    /** Completo ate o Discord fechar. */
    forcarCompleto: boolean;
    /** Recarregar o Discord, para o gateway conectar de novo pelo completo. */
    recarregar: boolean;
    aviso: string | null;
}

const NADA: DecisaoDaTrava = { forcarCompleto: false, recarregar: false, aviso: null };

/**
 * O que fazer com a atribuicao lida.
 *
 * So age no tunel em dois niveis. No completo sempre, a trava vir significa outra coisa -- o
 * tunel estava fora quando o gateway conectou, ou a propria saida foi marcada --, e trocar de
 * perfil nao resolveria nada; o porteiro e o `/streamfix` cuidam disso.
 *
 * **Uma recarga so.** O gateway ja conectou com a trava; ela so sai com um `READY` novo, que so
 * vem de outra conexao. A recarga e o jeito limpo de ter uma. Se mesmo assim a trava vier com o
 * controle, nao recarrega de novo: laco de recarga seria pior do que o botao cinza.
 */
export function decidirTrava(s: SituacaoDaTrava): DecisaoDaTrava {
    if (!s.trava || !s.doisNiveis) return NADA;

    if (s.jaRecarregou) {
        return {
            forcarCompleto: true,
            recarregar: false,
            aviso: "StreamFix: o Discord continua mandando a trava do Brasil. Ligue \"tunelCompletoSempre\""
                + " nas configuracoes do plugin e reinicie o Discord."
        };
    }

    return {
        forcarCompleto: true,
        recarregar: true,
        aviso: "StreamFix: o tunel leve nao cobriu a conexao do Discord daqui, e a trava do Brasil voltou."
            + " Passando para o tunel completo e recarregando o Discord."
    };
}

/** Se a marca da ultima recarga ainda vale. Qualquer coisa que nao seja um numero recente, nao. */
export function recargaRecente(marca: unknown, agora: number): boolean {
    return typeof marca === "number" && marca <= agora && agora - marca < VALIDADE_DA_MARCA_MS;
}
