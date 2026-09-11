// Chaves WireGuard: gerar o par, e reconhecer uma chave valida.
//
// Uma chave WireGuard e uma chave X25519 crua, 32 bytes, em base64 -- 44 caracteres terminados
// em `=`. O Node gera X25519 nativamente, entao nao ha dependencia externa nem binario do
// `wg.exe` para instalar no Windows.
//
// **A privada nunca sai da maquina.** Ela vai para o arquivo de perfil e para lugar nenhum mais:
// nao entra em log, em mensagem de erro, em relatorio de diagnostico, nem no corpo do registro.
// O que viaja e a publica. Por isso `gerarPar` devolve as duas separadas em vez de um objeto que
// alguem serializaria inteiro por descuido.

import { generateKeyPairSync } from "node:crypto";

/** 32 bytes em base64: 43 caracteres do alfabeto mais o `=` do padding. */
export const FORMATO_CHAVE = /^[A-Za-z0-9+/]{43}=$/;

export function chaveValida(chave: unknown): chave is string {
    return typeof chave === "string" && FORMATO_CHAVE.test(chave);
}

export interface Par {
    /** Vai para o perfil, e so para o perfil. */
    privada: string;
    /** A unica metade que viaja. */
    publica: string;
}

/**
 * Gera um par X25519 no formato do WireGuard.
 *
 * Os 32 bytes crus sao os ultimos do DER em ambos os casos -- PKCS8 de X25519 tem 48 bytes com
 * 16 de cabecalho, SPKI tem 44 com 12. Conferido contra `wg pubkey` em 11/09: a publica que o
 * Node deriva e a mesma que o WireGuard deriva.
 */
export function gerarPar(): Par {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    return {
        privada: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
        publica: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64")
    };
}
