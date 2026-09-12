// A conexao de voz: nascer no completo, conferir, e resgatar quando nasceu fora.
//
// **Por que a voz entrou nisto.** A camera anda na conexao de voz, e o Discord confere o IP dela
// quando ela NASCE -- dos dois lados: quem liga a camera com a voz nascida pelo Brasil nao
// codifica, e quem assiste com a voz nascida pelo Brasil nao recebe. Trocar o tunel depois nao
// muda o veredito em nenhum sentido. Medido em 12/09 (pesquisa, 12i).
//
// **O fluxo** (spec de dois niveis, 4.6):
//
//   - toda conexao de voz nova pega um emprestimo do completo: no clique de entrar na call
//     (`VOICE_CHANNEL_SELECT`) e em qualquer `CONNECTING`, porque uma reconexao sozinha tambem
//     faz a voz nascer de novo;
//   - no `RTC_CONNECTED`, o `localAddress` diz por onde ela nasceu. E o IP que o servidor de
//     midia viu na descoberta de IP, e ele nao se atualiza depois -- mas lido ali, no
//     nascimento, e exato;
//   - nasceu na saida: devolve depois da folga. Nasceu no Brasil: `reconnect()` com o completo no
//     ar. A voz renasce em ~0,7 s, sem sair do canal, e desta vez pela saida.
//
// **Um resgate por nascimento.** O `reconnect()` gera um `CONNECTING` novo, e esse nao pode
// abrir outro emprestimo nem autorizar outro resgate. Se o resgate renascer no Brasil de novo,
// avisa e para. Laco de reconexao seria pior do que a camera quebrada.
//
// Sem imports, para o Node carregar direto nos testes.

/**
 * Quanto tempo um emprestimo de voz espera o `RTC_CONNECTED`.
 *
 * Uma entrada normal leva ~1,3 s, e ~2,5 s quando a troca de perfil acontece no meio (12i). Se
 * a voz nao conectar nesse prazo -- rede caida, servidor fora --, o emprestimo nao pode ficar
 * preso: o tunel ficaria no completo ate alguem sair da call.
 */
export const PRAZO_VOZ_MS = 20_000;

export interface EstadoVoz {
    /** Ha um emprestimo de voz em aberto. */
    emprestimo: boolean;
    /** O nascimento atual ja e um resgate. */
    resgatando: boolean;
}

export const VOZ_INICIAL: EstadoVoz = { emprestimo: false, resgatando: false };

export type EventoVoz =
    /** `VOICE_CHANNEL_SELECT` com canal: entrou numa call, ou trocou de canal. */
    | { tipo: "entrou"; }
    /** `VOICE_CHANNEL_SELECT` sem canal: saiu da call. */
    | { tipo: "saiu"; }
    /** `RTC_CONNECTION_STATE` `CONNECTING`, no contexto `default`. */
    | { tipo: "conectando"; }
    /** `RTC_CONNECTION_STATE` `RTC_CONNECTED`, com o `localAddress` lido na hora. */
    | { tipo: "conectada"; localAddress: string | null; }
    /** O `PRAZO_VOZ_MS` venceu sem `RTC_CONNECTED`. */
    | { tipo: "expirou"; };

export interface ContextoVoz {
    /**
     * O tunel em dois niveis esta valendo. Sem o perfil de controle, com `tunelCompletoSempre`,
     * ou depois de a Trava 1 forcar o completo, a voz ja nasce no completo e nada aqui e preciso.
     */
    ativo: boolean;
    /** O host da saida, sem porta. */
    saida: string;
}

export interface AcaoVoz {
    /** Abrir um emprestimo de voz. */
    pegar: boolean;
    /** Fechar o emprestimo de voz, agora ou depois de `FOLGA_NASCIMENTO_MS`. */
    devolver: "agora" | "depoisDaFolga" | null;
    /** Esperar o completo ficar no ar e chamar `reconnect()` na conexao RTC. */
    resgatar: boolean;
    /** O que dizer a pessoa. */
    aviso: string | null;
}

export const AVISO_VOZ_FORA =
    "StreamFix: a voz desta call nasceu fora do tunel, e a camera pode nao funcionar -- nem a sua,"
    + " nem a dos outros para voce. Saia da call e entre de novo.";

const NADA: AcaoVoz = { pegar: false, devolver: null, resgatar: false, aviso: null };

export function decidirVoz(estado: EstadoVoz, evento: EventoVoz, ctx: ContextoVoz): { estado: EstadoVoz; acao: AcaoVoz; } {
    // Desligado, so fecha o que tiver ficado aberto de antes de desligar.
    if (!ctx.ativo) {
        return estado.emprestimo
            ? { estado: VOZ_INICIAL, acao: { ...NADA, devolver: "agora" } }
            : { estado: VOZ_INICIAL, acao: NADA };
    }

    switch (evento.tipo) {
        case "entrou":
            // Um canal novo e um nascimento novo, com direito a um resgate proprio.
            return {
                estado: { emprestimo: true, resgatando: false },
                acao: { ...NADA, pegar: !estado.emprestimo }
            };

        case "conectando":
            // Sem emprestimo aberto, e uma reconexao que ninguem pediu: a voz vai nascer de novo.
            // Com emprestimo aberto, ou e a entrada que ja pegou o seu, ou e o proprio resgate.
            return {
                estado: { ...estado, emprestimo: true },
                acao: { ...NADA, pegar: !estado.emprestimo }
            };

        case "saiu":
        case "expirou":
            return {
                estado: VOZ_INICIAL,
                acao: { ...NADA, devolver: estado.emprestimo ? "agora" : null }
            };

        case "conectada": {
            const local = evento.localAddress;

            if (!local) {
                // Sem leitura nao ha como saber. Resgatar as cegas custaria um soluco de voz
                // em toda entrada em que o `getStats` vier vazio.
                return { estado: VOZ_INICIAL, acao: { ...NADA, devolver: estado.emprestimo ? "agora" : null } };
            }

            if (local === ctx.saida) {
                return {
                    estado: VOZ_INICIAL,
                    acao: { ...NADA, devolver: estado.emprestimo ? "depoisDaFolga" : null }
                };
            }

            if (estado.resgatando) {
                // O resgate tambem nasceu fora. Parar aqui.
                return {
                    estado: VOZ_INICIAL,
                    acao: { ...NADA, devolver: estado.emprestimo ? "agora" : null, aviso: AVISO_VOZ_FORA }
                };
            }

            // Nasceu fora, e e a primeira vez. O emprestimo segue aberto ate o resgate conectar.
            return {
                estado: { emprestimo: true, resgatando: true },
                acao: { ...NADA, pegar: !estado.emprestimo, resgatar: true }
            };
        }
    }
}
