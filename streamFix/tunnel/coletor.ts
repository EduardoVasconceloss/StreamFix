// A traducao entre o que o Discord expoe e o que o SessionMonitor entende. Funcao pura, e
// todo nome interno do Discord mora aqui -- quando o bundle renomear um campo, ha um lugar so
// para consertar, e o sintoma sera `null` na amostra, nunca zero, que e a diferenca entre
// "nao sei" e mentir.
//
// Os campos vieram do proprio bundle (modulo 206959), conferidos em 08/09/2026, e a mesma
// extracao esta em tests/fixtures/capture.mjs -- e por isso que as fixtures gravadas servem de
// especificacao executavel desta unidade.
//
// So `import type` daqui para o monitor, de proposito: assim este arquivo nao tem nenhuma
// dependencia em tempo de execucao e continua carregavel por `require()` direto no Node, que
// e o que permite testa-lo contra as fixtures sem montar o mod inteiro.

import type { Amostra } from "./monitor";

/** Uma entrada de saida de video, como o motor de midia a reporta. */
export interface VideoBruto {
    framesEncoded?: number | null;
    bytesSent?: number | null;
}

/** Uma conexao do motor de midia, reduzida ao que interessa. */
export interface ConexaoBruta {
    context?: string | null;
    video?: (VideoBruto | null)[];
    captura?: {
        tela?: Record<string, number> | null;
        camera?: Record<string, number> | null;
    } | null;
}

/**
 * O que uma leitura do motor de midia devolve. Mesmo formato das linhas das fixtures em
 * tests/fixtures/*.jsonl, de proposito: o que o coletor le em producao e o que esta gravado.
 */
export interface LeituraBruta {
    /** Quantos assistem. `null` quando nao ha transmissao propria no ar. */
    espectadores?: number | null;
    dados?: ConexaoBruta[];
}

/**
 * Reduz os contadores de captura a um numero so. O modulo nativo reporta um contador por
 * backend (Graphics Capture, DXGI, GDI, videohook) e troca de backend em tempo de execucao --
 * na fixture de 08/09 houve duas trocas. Olhar so um deles perderia a captura de vista
 * exatamente quando ela mudou de caminho. Os campos `*Unique` ficam de fora: quadro repetido
 * ainda e captura viva, e a diferenca entre os dois e outro assunto (quadro em branco).
 */
export function quadrosCapturados(tela: Record<string, number> | null | undefined) {
    if (tela == null) return null;
    let total: number | null = null;
    for (const [chave, valor] of Object.entries(tela)) {
        if (!chave.endsWith("Frames") || typeof valor !== "number") continue;
        total = (total ?? 0) + valor;
    }
    return total;
}

/**
 * Reduz uma leitura crua a uma amostra do monitor.
 *
 * So o contexto `stream` interessa: `default` e a call, e a entrega que o gate recusa e a da
 * transmissao. Campo ausente vira `null`, nunca zero.
 *
 * Limitacao conhecida: os quadros capturados vem de `captura.tela`. Uma transmissao de camera
 * pura reportaria em `captura.camera`, e nenhuma fixture exercita esse caso -- entao o codigo
 * nao finge cobri-lo. O efeito de errar aqui e o monitor atribuir a causa `captura` quando a
 * culpa e da entrega: diagnostico errado, nao falso alarme.
 */
export function aAmostra(bruto: LeituraBruta, t: number): Amostra {
    const stream = (bruto.dados ?? []).find(d => d?.context === "stream");
    const video = stream?.video?.[0];

    return {
        t,
        espectadores: bruto.espectadores ?? 0,
        framesEncoded: video?.framesEncoded ?? null,
        bytesSent: video?.bytesSent ?? null,
        capturaQuadros: quadrosCapturados(stream?.captura?.tela)
    };
}
