// O lado de ca do registro: gera o par, manda a publica com o convite, recebe o endereco.
//
// A privada e criada aqui e fica aqui. Ela nao entra no corpo da requisicao, nem em log, nem em
// mensagem de erro -- `registrarNaSaida` a devolve separada justamente para que ninguem
// serialize o resultado inteiro por descuido.
//
// O transporte e injetado: assim os testes exercitam resposta torta, servidor fora do ar e
// convite recusado sem subir servidor nenhum.

import { chaveValida, gerarPar } from "./chaves.ts";

/** O que a saida responde. Conferido campo a campo antes de virar perfil. */
export interface DadosDaSaida {
    endereco: string;
    chavePublicaDoServidor: string;
    endpoint: string;
    faixa: string;
}

export type Transporte = (
    url: string,
    corpo: { convite: string; chavePublica: string }
) => Promise<{ status: number; corpo: unknown }>;

export type ResultadoRegistro =
    | { ok: true; privada: string; dados: DadosDaSaida }
    | { ok: false; motivo: string };

/** `10.8.0.2` ou `10.8.0.2/32`. */
const ENDERECO = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
/** `host:porta`, sem espaco e sem quebra de linha. */
const ENDPOINT = /^[A-Za-z0-9.\-]+:\d{1,5}$/;
const FAIXA = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/**
 * Confere a resposta da saida antes de deixa-la virar arquivo de perfil.
 *
 * Nao e desconfianca do servidor: e que o destino destes campos e um `.conf` com diretivas por
 * linha, e um valor com `\n` escreveria diretiva propria. O `gerarPerfil` recusa de novo, mas o
 * erro util e o que aponta o campo que veio torto, e ele so existe aqui.
 */
export function dadosValidos(corpo: unknown): DadosDaSaida | null {
    const d = corpo as Record<string, unknown> | null;
    if (d == null || typeof d !== "object") return null;
    const { endereco, chavePublicaDoServidor, endpoint, faixa } = d;
    if (typeof endereco !== "string" || !ENDERECO.test(endereco)) return null;
    if (!chaveValida(chavePublicaDoServidor)) return null;
    if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) return null;
    if (typeof faixa !== "string" || !FAIXA.test(faixa)) return null;
    return { endereco, chavePublicaDoServidor, endpoint, faixa };
}

/** A mensagem que o usuario le. O servidor manda um codigo estavel; o texto e nosso. */
export function motivoDoErro(status: number, corpo: unknown): string {
    const codigo = (corpo as { codigo?: unknown })?.codigo;
    switch (codigo) {
        case "convite_invalido": return "o convite nao existe -- confira se foi copiado inteiro";
        case "convite_revogado": return "este convite foi revogado; peca outro a quem administra a saida";
        case "convite_esgotado": return "este convite ja foi usado o numero maximo de vezes";
        case "faixa_cheia": return "a saida esta cheia; quem administra precisa liberar um endereco";
        case "chave_invalida": return "a saida recusou a chave gerada aqui (isto e bug do StreamFix)";
        default: return `a saida respondeu ${status} sem um motivo que eu conheca`;
    }
}

/**
 * Registra esta maquina na saida.
 *
 * Em caso de falha nao ha par gerado sobrando em lugar nenhum: a chave so serve depois que o
 * servidor a aceitou, e gerar outra da proxima vez nao custa nada.
 */
export async function registrarNaSaida(
    url: string,
    convite: string,
    transporte: Transporte,
    chaveEsperada?: string
): Promise<ResultadoRegistro> {
    if (typeof convite !== "string" || convite.trim().length === 0) {
        return { ok: false, motivo: "convite vazio" };
    }

    const par = gerarPar();
    let resposta: { status: number; corpo: unknown };
    try {
        resposta = await transporte(url, { convite: convite.trim(), chavePublica: par.publica });
    } catch (e) {
        // Sem rede, DNS torto, saida fora do ar. A mensagem do erro nunca carrega a privada
        // porque ela nao foi passada ao transporte.
        return { ok: false, motivo: `nao consegui falar com a saida: ${(e as Error)?.message ?? e}` };
    }

    if (resposta.status !== 200) {
        return { ok: false, motivo: motivoDoErro(resposta.status, resposta.corpo) };
    }

    const dados = dadosValidos(resposta.corpo);
    if (dados === null) {
        return { ok: false, motivo: "a saida respondeu num formato que eu nao reconheco" };
    }

    // A defesa contra troca de resposta. O registro viaja em HTTP puro -- a saida tem IP e nao
    // dominio, entao nao ha certificado a emitir. O convite vazando e chato; o grave e alguem no
    // caminho responder com **outra** saida, e a midia do Discord passar a sair pela maquina
    // dessa pessoa. Como a saida padrao e conhecida de antemao (a chave publica dela vem no
    // instalador), conferir aqui fecha esse buraco sem TLS nenhum.
    if (chaveEsperada !== undefined && dados.chavePublicaDoServidor !== chaveEsperada) {
        return {
            ok: false,
            motivo: "a saida respondeu com uma chave publica diferente da esperada;"
                + " alguem pode estar no meio do caminho"
        };
    }

    return { ok: true, privada: par.privada, dados };
}
