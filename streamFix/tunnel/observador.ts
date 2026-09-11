// O laco que liga o coletor ao monitor: pede uma leitura, converte, avanca o veredito, avisa
// quando ele muda.
//
// Este arquivo importa o monitor em tempo de execucao, e por isso nao e carregavel por
// `require()` direto no Node -- o Node exige extensao explicita em import relativo dentro de
// `.ts`, e escrever `./monitor.ts` quebraria o `tsc` do mod, que usa `moduleResolution:
// bundler` sem `allowImportingTsExtensions`.
//
// Por isso ele e mantido deliberadamente fino. Tudo o que da para errar em silencio -- a
// traducao dos campos do Discord e a decisao sobre a entrega -- vive nas duas unidades que
// *sao* testaveis, `coletor.ts` e `monitor.ts`. O que sobra aqui e agendamento, e falha de
// agendamento aparece na hora.

import { aAmostra, LeituraBruta } from "./coletor";
import { avancar, Estado, estadoInicial, Opcoes, PADROES, Veredito } from "./monitor";

/** Quem sabe falar com o motor de midia. Injetado para o laco nao depender de Vencord. */
export type Fonte = () => Promise<LeituraBruta | null>;

export interface OpcoesObservador extends Opcoes {
    /** Intervalo entre leituras. O motor tem prazo interno de 1s, entao nao se sobrepoe. */
    intervaloMs: number;
    /** De onde vem o tempo. */
    agora: () => number;
}

export const PADROES_OBSERVADOR: OpcoesObservador = {
    ...PADROES,
    intervaloMs: 500,
    agora: () => Date.now()
};

/**
 * Comeca a observar. Devolve a funcao que encerra.
 *
 * `aoMudar` so dispara quando o veredito muda de estado ou de causa. Um aviso a cada 500 ms
 * nao seria aviso, seria ruido.
 */
export function observar(
    fonte: Fonte,
    aoMudar: (veredito: Veredito, estado: Estado) => void,
    opcoes: Partial<OpcoesObservador> = {}
) {
    const cfg: OpcoesObservador = { ...PADROES_OBSERVADOR, ...opcoes };
    let estado = estadoInicial();
    let anterior = estado.veredito;
    let vivo = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function passo() {
        let bruto: LeituraBruta | null = null;
        try {
            bruto = await fonte();
        } catch {
            // Leitura que falhou e buraco na serie, nao prova de parada. A amostra vazia faz o
            // monitor segurar o relogio sem concluir nada, que e regra dele.
            bruto = null;
        }
        if (!vivo) return;

        estado = avancar(estado, aAmostra(bruto ?? {}, cfg.agora()), cfg);

        const v = estado.veredito;
        if (v.estado !== anterior.estado || v.causa !== anterior.causa) {
            anterior = v;
            aoMudar(v, estado);
        }

        // Reagenda depois de terminar, nunca em intervalo fixo: `getStats()` tem prazo interno
        // de um segundo, e duas chamadas sobrepostas devolvem lixo.
        if (vivo) timer = setTimeout(passo, cfg.intervaloMs);
    }

    passo();

    return function encerrar() {
        vivo = false;
        if (timer !== null) clearTimeout(timer);
    };
}
