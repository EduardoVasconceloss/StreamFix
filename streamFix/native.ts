// A ponte entre o renderer e o tunel. Roda no processo nativo, porque so ele pode executar
// processo.
//
// Fino de proposito, como o `observador`: toda decisao vive em `tunnel/controle.ts` (Windows) e
// `tunnel/controle-wg.ts` (macOS), os dois testados contra as saidas reais dos CLIs. O que sobra
// aqui e `execFile` com prazo -- e o prazo e a parte que importa, porque
// `wiresock-connect-cli connect` nao volta nunca quando o handshake nao fecha. Medido em 11/09.
//
// **A escolha da implementacao e por plataforma, e acontece aqui.** Foi para isto que a interface
// `Controle` existe desde a fase 1. O plugin acima nao sabe qual das duas esta rodando, e nao
// deve saber: as diferencas entre WireSock e wg-quick sao grandes -- nome de perfil limitado a 15
// caracteres, identificacao por destinos em vez de por nome, handshake conferido a mao -- e
// nenhuma delas atravessa esta fronteira.

import { execFile } from "child_process";
import type { IpcMainInvokeEvent } from "electron";

import type { Controle } from "./tunnel/controle";
import { controleWireSock, Resultado } from "./tunnel/controle";
import { controleWgQuick, SUFIXO_CONTROLE } from "./tunnel/controle-wg";
import { FAIXA_CONTROLE } from "./tunnel/perfil";

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

const ehMac = process.platform === "darwin";

/**
 * Os destinos que cada perfil deve carregar, deduzidos do nome.
 *
 * O controle do macOS identifica um perfil pelos destinos que a interface dele carrega, e nao
 * pelo nome -- porque no Darwin o nome do perfil nao aparece em resposta nenhuma do `wg`, e o
 * arquivo que faria o mapeamento e so-root (ver o cabecalho de `controle-wg.ts`). Entao ele
 * precisa de uma tabela de identidade, e esta funcao a monta.
 *
 * A convencao e o sufixo: `streamfix-ctl` leva a faixa de controle, `streamfix` leva tudo. E a
 * mesma convencao que o instalador usa ao escrever os dois `.conf`, e as duas pontas tem de
 * concordar -- do mesmo jeito que `perfilDeControle()` e o instalador concordam no Windows.
 */
function destinosPorConvencao(nomes: string[]): Record<string, string> {
    const fora: Record<string, string> = {};
    for (const nome of nomes) {
        if (typeof nome !== "string" || nome.length === 0) continue;
        fora[nome] = nome.endsWith(SUFIXO_CONTROLE) ? FAIXA_CONTROLE : "0.0.0.0/0";
    }
    return fora;
}

/**
 * O controle desta plataforma.
 *
 * No macOS ele e montado por chamada, e nao uma vez so: a tabela de identidade depende de quais
 * perfis estao em jogo, e quem sabe isso e quem chamou. No Windows os nomes nao importam para
 * construir nada, entao a instancia e unica.
 */
const controleWindows = ehMac ? null : controleWireSock({ executar });

function controlePara(nomes: string[]): Controle {
    if (!ehMac) return controleWindows!;
    return controleWgQuick({ executar, perfis: destinosPorConvencao(nomes) });
}

// O plugin nunca derruba o tunel sem por outro no lugar: o nivel mais baixo e o controle, e
// sair do controle sem nada em cima traria a Trava 1 na proxima conexao do gateway. Por isso
// nao ha `derrubar` aqui, so `trocar`.

export function trocarTunel(_e: IpcMainInvokeEvent, perfil: string): Promise<Resultado & { duracaoMs: number }> {
    // O outro nivel entra na tabela junto: o `trocar` do macOS precisa saber quem derrubar
    // depois de subir o novo, e sem o par ele nao derrubaria ninguem.
    return controlePara(parDePerfis(perfil)).trocar(perfil);
}

export function perfilAtivo(_e: IpcMainInvokeEvent, candidatos: string[]): Promise<string | null | "desconhecido"> {
    return controlePara(candidatos).perfilAtivo(candidatos);
}

export function perfilExiste(_e: IpcMainInvokeEvent, perfil: string): Promise<boolean | "desconhecido"> {
    return controlePara([perfil]).existe(perfil);
}

/** Um perfil e o seu par do outro nivel, para o controle conhecer os dois. */
function parDePerfis(perfil: string): string[] {
    if (perfil.endsWith(SUFIXO_CONTROLE)) {
        return [perfil, perfil.slice(0, -SUFIXO_CONTROLE.length)];
    }
    return [perfil, `${perfil}${SUFIXO_CONTROLE}`];
}
