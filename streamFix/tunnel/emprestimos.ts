// O contador de emprestimos do tunel completo.
//
// **O desenho** (docs/superpowers/specs/2026-09-11-tunel-em-dois-niveis-design.md): o normal e o
// perfil de controle, que leva so o gateway e a API. O completo e emprestado por segundos, a
// cada conexao de midia que nasce -- a voz ao entrar numa call, o stream no Go Live, o stream de
// quem entra para assistir -- porque o Discord so confere o IP no nascimento (pesquisa, 12g e
// 12i).
//
// **Por que um contador, e nao um booleano.** Os momentos se sobrepoem: voce transmitindo e, no
// meio, entrando na transmissao de outra pessoa; a voz reconectando durante um Go Live. Quem
// devolve primeiro nao pode tirar o completo de quem ainda precisa dele. Cada pedido pega um
// emprestimo e devolve o seu, e o tunel volta ao controle so quando nao sobra nenhum.
//
// Sem imports, para o Node carregar direto nos testes.

export type Nivel = "controle" | "completo";

/** Quem pediu o completo. Serve para o `/streamfix` dizer por que o tunel esta no completo. */
export type Motivo = "voz" | "transmitir" | "assistir";

/**
 * Quanto tempo o completo fica depois de uma conexao de midia ficar `RTC_CONNECTED`.
 *
 * Medido em 12/09 (pesquisa, 12i): voltar ao controle **no instante** do `CONNECTED` entregou,
 * na conexao de stream (N = 10, 5, 2 e 0 segundos) e na de voz. O veredito ja esta dado ali. Os
 * dois segundos sao margem, e errar para mais aqui custa so latencia.
 */
export const FOLGA_NASCIMENTO_MS = 2_000;

/**
 * Quanto tempo o emprestimo do Go Live espera a conexao de stream ficar `RTC_CONNECTED`.
 *
 * O clique pega o emprestimo antes de a transmissao existir. Se ela nao nascer -- o Discord
 * recusou, a captura falhou, a pessoa desistiu --, nada devolveria o emprestimo, e o tunel
 * ficaria no completo ate o Discord fechar. Mesmo prazo da voz, e pela mesma razao.
 */
export const PRAZO_NASCIMENTO_MS = 20_000;

export interface Emprestimos {
    /** Abre um emprestimo. O id e o que se devolve depois. */
    pegar(motivo: Motivo): number;
    /** Fecha um emprestimo. Devolver duas vezes, ou um id que nao existe, nao faz nada. */
    devolver(id: number): void;
    /** Os motivos em aberto, na ordem em que foram pedidos. */
    abertos(): Motivo[];
    /** Completo se houver algum emprestimo em aberto. A politica fica em `nivel`. */
    nivelDesejado(): Nivel;
}

export function criarEmprestimos(): Emprestimos {
    const emAberto = new Map<number, Motivo>();
    let proximo = 1;
    return {
        pegar(motivo) {
            const id = proximo++;
            emAberto.set(id, motivo);
            return id;
        },
        devolver(id) {
            emAberto.delete(id);
        },
        abertos() {
            return [...emAberto.values()];
        },
        nivelDesejado() {
            return emAberto.size > 0 ? "completo" : "controle";
        }
    };
}

export interface SituacaoDoNivel {
    /** O perfil de controle existe nesta maquina. Sem ele, so ha o completo (spec, E5). */
    temControle: boolean;
    /** A configuracao `tunelCompletoSempre`, para quem prefere o comportamento antigo (E7). */
    completoSempre: boolean;
    /**
     * A Trava 1 veio com o controle no ar: a faixa nao cobriu o gateway desta pessoa (E6). Dali
     * em diante, completo ate o Discord fechar.
     */
    travaComControle: boolean;
    /** O que o contador pede. */
    pedido: Nivel;
}

/**
 * O nivel que o tunel deve ter agora.
 *
 * Na duvida, completo: e o que funcionava antes do tunel em dois niveis. Cair no completo custa
 * latencia; cair no controle quando nao devia custa uma transmissao preta.
 */
export function nivel(s: SituacaoDoNivel): Nivel {
    if (!s.temControle || s.completoSempre || s.travaComControle) return "completo";
    return s.pedido;
}
