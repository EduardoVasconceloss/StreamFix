// A ponte entre o renderer e o WireSock. Roda no processo nativo, porque so ele pode executar
// processo.
//
// Fino de proposito, como o `observador`: toda decisao vive em `tunnel/controle.ts`, que e
// testado contra as saidas reais do CLI. O que sobra aqui e `execFile` com prazo -- e o prazo e
// a parte que importa, porque `wiresock-connect-cli connect` nao volta nunca quando o handshake
// nao fecha. Medido em 11/09.

import { execFile } from "child_process";
import type { IpcMainInvokeEvent } from "electron";

import { controleWireSock, Resultado } from "./tunnel/controle";

/**
 * Executa e devolve a saida combinada.
 *
 * Nunca olha o codigo de saida: o CLI devolve 2 num `disconnect` bem-sucedido e 0 num `connect`
 * que nao encontrou o perfil. Quando o prazo estoura, o processo e morto e o erro sobe -- o
 * `controle` transforma isso em recusa, nunca em travamento.
 */
function executar(exe: string, args: string[], { tempoLimiteMs }: { tempoLimiteMs: number }) {
    return new Promise<string>((resolver, rejeitar) => {
        const filho = execFile(
            exe, args,
            { encoding: "utf8", maxBuffer: 8 << 20, timeout: tempoLimiteMs, killSignal: "SIGKILL" },
            (erro, saida, erroPadrao) => {
                const texto = (saida || "") + (erroPadrao || "");
                if (erro && (erro as { killed?: boolean }).killed) {
                    return rejeitar(new Error(`o WireSock nao respondeu em ${tempoLimiteMs} ms`));
                }
                if (texto) return resolver(texto);
                return erro ? rejeitar(erro) : resolver("");
            }
        );
        filho.on("error", rejeitar);
    });
}

const controle = controleWireSock({ executar });

// O plugin nunca derruba o tunel sem por outro no lugar: o nivel mais baixo e o controle, e
// sair do controle sem nada em cima traria a Trava 1 na proxima conexao do gateway. Por isso
// nao ha `derrubar` aqui, so `trocar`.

export function trocarTunel(_e: IpcMainInvokeEvent, perfil: string): Promise<Resultado & { duracaoMs: number }> {
    return controle.trocar(perfil);
}

export function perfilAtivo(_e: IpcMainInvokeEvent, candidatos: string[]): Promise<string | null | "desconhecido"> {
    return controle.perfilAtivo(candidatos);
}

export function perfilExiste(_e: IpcMainInvokeEvent, perfil: string): Promise<boolean | "desconhecido"> {
    return controle.existe(perfil);
}
