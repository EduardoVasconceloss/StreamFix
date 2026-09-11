// A ponte entre o renderer e o WireSock. Roda no processo nativo, porque so ele pode executar
// processo.
//
// Fino de proposito, como o `observador`: toda decisao vive em `tunnel/controle.ts`, que e
// testado contra as saidas reais do CLI. O que sobra aqui e `execFile` com prazo -- e o prazo e
// a parte que importa, porque `wiresock-connect-cli connect` nao volta nunca quando o handshake
// nao fecha. Medido em 11/09.

import { execFile } from "child_process";
import type { IpcMainInvokeEvent } from "electron";

import { controleWireSock, EstadoTunel, Resultado } from "./tunnel/controle";

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

export function estadoDoTunel(_e: IpcMainInvokeEvent, perfil: string): Promise<EstadoTunel> {
    return controle.estado(perfil);
}

export function subirTunel(_e: IpcMainInvokeEvent, perfil: string): Promise<Resultado> {
    return controle.subir(perfil);
}

export function derrubarTunel(_e: IpcMainInvokeEvent): Promise<void> {
    return controle.derrubar();
}
