// Decide se a entrega de video de uma transmissao esta viva, a partir de uma serie de
// amostras. Funcao pura: nao le store, nao consulta rede, nao olha o relogio -- o tempo entra
// pelo carimbo de cada amostra. Quem coleta e outro modulo; aqui so se decide.
//
// As tres regras abaixo vieram de medicao, nao do desenho original. Ver a fixture
// tests/fixtures/sem-espectador.jsonl e os achados em
// docs/superpowers/plans/2026-09-08-tunel-momentaneo-plan.md, fase 1.

export type Causa = "entrega" | "captura";

export interface Amostra {
    /** Milissegundos. So a diferenca entre amostras importa. */
    t: number;
    /** Quantos assistem agora. De ApplicationStreamingStore.getViewerIds(). */
    espectadores: number;
    /** Contadores cumulativos da saida de video; `null` quando a engine nao respondeu. */
    framesEncoded: number | null;
    bytesSent: number | null;
    /** Contador cumulativo de quadros capturados da tela ou camera. */
    capturaQuadros: number | null;
}

export interface Veredito {
    estado: "saudavel" | "quebrado";
    /** So em "quebrado": diz o que falhou, e portanto o que adianta fazer a respeito. */
    causa?: Causa;
    /** Qual regra decidiu. Vai para o log do modo simulacao. */
    motivo: string;
}

export interface Estado {
    veredito: Veredito;
    /** Ultimos valores vistos, para comparar progresso. */
    frames: number | null;
    bytes: number | null;
    captura: number | null;
    /** Quando o progresso de entrega parou. `null` enquanto ha progresso. */
    paradoDesde: number | null;
}

export interface Opcoes {
    /** Quanto tempo sem progresso, com espectador presente, antes de declarar quebra. */
    toleranciaMs: number;
}

export const PADROES: Opcoes = { toleranciaMs: 4000 };

const SAUDAVEL = (motivo: string): Veredito => ({ estado: "saudavel", motivo });

export function estadoInicial(): Estado {
    return {
        veredito: SAUDAVEL("ainda sem amostra"),
        frames: null,
        bytes: null,
        captura: null,
        paradoDesde: null,
    };
}

/** Cresceu de verdade. `null` de qualquer lado nao conta como progresso nem como parada. */
function cresceu(atual: number | null, anterior: number | null) {
    return atual != null && anterior != null && atual > anterior;
}

/** Contador que anda pra tras: reinicio de base, nao falta de progresso. */
function regrediu(atual: number | null, anterior: number | null) {
    return atual != null && anterior != null && atual < anterior;
}

export function avancar(anterior: Estado, a: Amostra, opcoes: Opcoes = PADROES): Estado {
    const base = { frames: a.framesEncoded, bytes: a.bytesSent, captura: a.capturaQuadros };

    // Regra 1. Sem espectador nao ha nada a concluir: uma transmissao saudavel tambem codifica
    // zero quadro quando ninguem pede video. Medido -- `sinkWantAsInt` fica em 100 mesmo sem
    // ninguem assistindo, entao ele nao serve para saber que ha espectador, e sem essa
    // informacao o monitor so consegue produzir falso positivo.
    if (a.espectadores <= 0) {
        return { ...base, paradoDesde: null, veredito: SAUDAVEL("sem espectador: nada a concluir") };
    }

    // Regra 2. Uma renegociacao de codec zera bytesSent e packetsSent no mesmo ssrc. Isso nao e
    // parada, e uma base nova -- e o relogio de parada recomeca junto, para nao declarar quebra
    // no instante seguinte a uma renegociacao legitima.
    if (regrediu(a.framesEncoded, anterior.frames) || regrediu(a.bytesSent, anterior.bytes)) {
        return { ...base, paradoDesde: null, veredito: SAUDAVEL("contador reiniciou: base nova") };
    }

    const entregaAndou = cresceu(a.framesEncoded, anterior.frames) || cresceu(a.bytesSent, anterior.bytes);
    if (entregaAndou) {
        return { ...base, paradoDesde: null, veredito: SAUDAVEL("entrega avancando") };
    }

    // Sem numero nenhum nao se decide nada. Uma amostra vazia (a engine nao respondeu no prazo)
    // e um buraco na serie, nao prova de parada.
    if (a.framesEncoded == null && a.bytesSent == null) {
        return { ...base, paradoDesde: anterior.paradoDesde, veredito: SAUDAVEL("sem dados nesta amostra") };
    }

    const paradoDesde = anterior.paradoDesde ?? a.t;
    const parouHa = a.t - paradoDesde;
    if (parouHa < opcoes.toleranciaMs) {
        return { ...base, paradoDesde, veredito: SAUDAVEL(`parada de ${parouHa}ms, dentro da tolerancia`) };
    }

    // Regra 3. Captura e entrega sao eixos separados, e os dois zeram framesEncoded. Se a
    // captura tambem parou, religar tunel e recriar a transmissao nao resolve nada -- o
    // problema esta antes do encoder. So a causa "entrega" justifica recuperacao.
    const capturaAndou = cresceu(a.capturaQuadros, anterior.captura);
    const causa: Causa = capturaAndou ? "entrega" : "captura";
    const motivo = capturaAndou
        ? `${parouHa}ms sem entrega com ${a.espectadores} assistindo, e a captura continua produzindo`
        : `${parouHa}ms sem entrega e sem captura: o problema esta antes do encoder`;

    return { ...base, paradoDesde, veredito: { estado: "quebrado", causa, motivo } };
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

/** Percorre uma serie inteira. Existe para testar contra fixture gravada. */
export function percorrer(amostras: Amostra[], opcoes: Opcoes = PADROES): Estado[] {
    const saida: Estado[] = [];
    let estado = estadoInicial();
    for (const a of amostras) {
        estado = avancar(estado, a, opcoes);
        saida.push(estado);
    }
    return saida;
}
