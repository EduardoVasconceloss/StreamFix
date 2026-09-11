// Sobe e derruba o tunel, e -- mais importante -- confere se ele subiu restrito ao Discord.
//
// Tudo aqui e decisao e leitura; quem executa processo e injetado. Assim o Node carrega este
// arquivo por `require()` direto e os testes rodam contra a producao. Mesma razao de coletor.ts
// e perfil.ts.
//
// Tres coisas medidas no CLI real (WireSock 3.4.8.1, 11/09/2026) governam este arquivo:
//
//   1. **O codigo de saida nao vale nada.** `disconnect` bem-sucedido devolve 2. `connect` com
//      perfil inexistente devolve 0. `import` de arquivo inexistente devolve 0. Nada aqui olha
//      para `exitCode` -- a leitura e sempre da saida de texto.
//   2. **A saida de texto e traduzida.** Nesta maquina o CLI responde em portugues ("Nao
//      conectado", "Conexao estabelecida"). Casar com texto de interface daria o resultado
//      errado em qualquer outro idioma. Os sinais usados aqui sao o nome do perfil e as linhas
//      de log em JSON, que nao sao traduzidas.
//   3. **O `connect` registra o split tunnel aplicado**, em JSON, em `AllowedApps=`. E a
//      confirmacao que o plano previa como teste manual no log do servico -- e ela e legivel,
//      entao virou asserção automatica a cada conexao. Ver `subir`.

/**
 * Um processo executado. Devolve a saida combinada; quem chama nunca ve codigo de saida.
 *
 * `tempoLimiteMs` nao e enfeite. Medido em 11/09: `connect ... -exit` num perfil cujo handshake
 * nao fecha **nao volta nunca** -- ele espera a conexao se estabelecer, e ela nao se estabelece.
 * Saida fora do ar, chave revogada, UDP bloqueado na rede: todos caem nesse caso. Sem prazo, o
 * porteiro do Go Live congela em vez de recusar.
 */
export type Executar = (exe: string, args: string[], opcoes: { tempoLimiteMs: number }) => Promise<string>;

export type EstadoTunel = "conectado" | "fora" | "desconhecido";

export type Resultado =
    | { ok: true; saida: string }
    | { ok: false; motivo: string };

/**
 * O que qualquer implementacao de tunel precisa oferecer. Hoje so existe a do WireSock, do
 * Windows; a de `wg-quick` entra atras desta mesma forma quando Linux voltar ao escopo.
 */
export interface Controle {
    subir(perfil: string): Promise<Resultado>;
    derrubar(): Promise<void>;
    estado(perfil: string): Promise<EstadoTunel>;
}

export const CLI_PADRAO =
    "C:\\Program Files\\WireSock Secure Connect\\command-line\\wiresock-connect-cli.exe";

/** A conexao boa levou 793 ms no spike. Dez segundos e folga larga, nao aposta. */
export const PRAZO_CONEXAO_MS = 10_000;
/** `status`, `list`, `import` e `disconnect` sao locais e respondem na hora. */
export const PRAZO_CURTO_MS = 5_000;

/**
 * O nome do perfil e o nome do arquivo, sem extensao.
 *
 * Medido em 11/09, e nao esta documentado em lugar nenhum: `import teste.conf` cria o perfil
 * `teste`, **ignorando** qualquer nome que se queira dar. Quem gera o `.conf` tem que grava-lo
 * com o nome exato do perfil desejado.
 */
export function perfilDoArquivo(caminho: string): string {
    const base = (caminho ?? "").split(/[\\/]/).pop() ?? "";
    return base.replace(/\.conf$/i, "");
}

// ---------------------------------------------------------------------------------------------
// Leitura da saida do CLI
// ---------------------------------------------------------------------------------------------

/**
 * Le as linhas de log em JSON que o `connect` emite.
 *
 * Elas vem misturadas com texto solto e nao sao traduzidas, entao sao o unico pedaco confiavel
 * da saida. Linha que nao for JSON valido e simplesmente ignorada.
 */
export function mensagensDoLog(saida: string): string[] {
    const fora: string[] = [];
    for (const linha of (saida ?? "").split(/\r?\n/)) {
        const corte = linha.indexOf("{");
        if (corte < 0) continue;
        try {
            const obj = JSON.parse(linha.slice(corte));
            if (typeof obj?.message === "string") fora.push(obj.message);
        } catch {
            // Linha truncada ou texto que so parecia JSON. Nao e erro: e ruido.
        }
    }
    return fora;
}

/**
 * Os aplicativos que o tunel de fato aceitou, lidos do log do `connect`.
 *
 * `null` significa que o CLI nao declarou nada -- e isso **nao** pode ser lido como "nenhuma
 * restricao" nem como "tudo certo". Ver `subir`.
 */
export function appsAplicados(saida: string): string[] | null {
    let fora: string[] | null = null;
    for (const msg of mensagensDoLog(saida)) {
        const m = /^AllowedApps\s*=\s*(.*)$/.exec(msg);
        if (!m) continue;
        fora = m[1].split(",").map(s => s.trim()).filter(s => s.length > 0);
    }
    return fora;
}

/** O endereco externo que o `status` reporta, ou `""` enquanto a consulta de geo nao voltou. */
export function saidaDoStatus(texto: string): string {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(texto ?? "");
    return m ? m[1] : "";
}

/**
 * Decide o estado a partir da saida do `status`.
 *
 * O sinal e o **nome do perfil**. Conectado, o CLI o repete na resposta; desconectado, responde
 * uma frase traduzida que nao o contem. Procurar o nome funciona em qualquer idioma; procurar
 * "Nao conectado" so funciona nesta maquina.
 *
 * Saida vazia vira `desconhecido`, nunca `fora`: nao saber e um terceiro estado, e trata-lo
 * como "fora" faria o porteiro liberar uma transmissao condenada.
 */
export function estadoDoStatus(texto: string, perfil: string): EstadoTunel {
    const t = (texto ?? "").trim();
    if (t.length === 0) return "desconhecido";
    return t.includes(perfil) ? "conectado" : "fora";
}

// ---------------------------------------------------------------------------------------------
// O controle
// ---------------------------------------------------------------------------------------------

export interface OpcoesControle {
    executar: Executar;
    cli?: string;
    /** Nomes de processo que o perfil deveria ter restringido. */
    apps?: string[];
    /** Quantas vezes reler o `status` esperando o endereco externo aparecer. */
    tentativasDeSaida?: number;
    dormir?: (ms: number) => Promise<void>;
}

const espera = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function controleWireSock(opcoes: OpcoesControle): Controle & {
    importar(caminho: string, perfil: string): Promise<Resultado>;
} {
    const cli = opcoes.cli ?? CLI_PADRAO;
    const apps = opcoes.apps ?? ["Discord"];
    const tentativas = opcoes.tentativasDeSaida ?? 4;
    const dormir = opcoes.dormir ?? espera;
    const rodar = (prazo: number, ...args: string[]) =>
        opcoes.executar(cli, args, { tempoLimiteMs: prazo });
    const rodarCurto = (...args: string[]) => rodar(PRAZO_CURTO_MS, ...args);

    async function estado(perfil: string): Promise<EstadoTunel> {
        try {
            return estadoDoStatus(await rodarCurto("status"), perfil);
        } catch {
            // CLI ausente, servico parado, permissao negada. Nada disso e "fora".
            return "desconhecido";
        }
    }

    async function derrubar(): Promise<void> {
        try {
            await rodarCurto("disconnect");
        } catch {
            // Derrubar o que ja esta fora nao e erro, e nao ha nada melhor a fazer aqui.
        }
    }

    /**
     * Importa um perfil, e confirma pela `list`.
     *
     * A confirmacao nao e paranoia: `import` de um caminho inexistente responde com uma frase de
     * erro traduzida e **codigo de saida 0**. A `list` devolve nomes, que nao sao traduzidos.
     */
    async function importar(caminho: string, perfil: string): Promise<Resultado> {
        const derivado = perfilDoArquivo(caminho);
        if (derivado !== perfil) {
            return {
                ok: false,
                motivo: `o WireSock nomeia o perfil pelo arquivo: ${caminho} viraria "${derivado}",`
                    + ` nao "${perfil}"`
            };
        }
        try {
            await rodarCurto("import", caminho);
            const lista = await rodarCurto("list");
            if (!lista.includes(perfil)) {
                return { ok: false, motivo: `o perfil ${perfil} nao aparece na lista apos importar` };
            }
            return { ok: true, saida: "" };
        } catch (e) {
            return { ok: false, motivo: `falha ao importar o perfil: ${(e as Error)?.message ?? e}` };
        }
    }

    /**
     * Conecta, e so declara sucesso depois de conferir **o que** entrou no tunel.
     *
     * Esta e a parte que justifica a unidade existir. O `#@ws:AllowedApps` descartado em silencio
     * e o pior modo de falha do projeto: o tunel sobe, a transmissao funciona, o espectador ve a
     * tela -- e a maquina inteira esta saindo pelo Chile sem ninguem saber. O log do `connect`
     * diz quais aplicativos valeram, entao da para recusar na hora.
     *
     * Recusar significa **derrubar**. Um tunel que subiu errado nao pode ficar de pe enquanto o
     * usuario le a mensagem de erro.
     */
    async function subir(perfil: string): Promise<Resultado> {
        let log: string;
        try {
            log = await rodar(PRAZO_CONEXAO_MS, "connect", perfil, "-log-level", "info", "-exit");
        } catch (e) {
            // Prazo estourado e o caso que importa aqui, e nele nao se sabe o que ficou de pe: o
            // CLI foi morto no meio, e o handshake pode fechar depois. Derrubar e a unica saida
            // honesta -- o alternativo e deixar um tunel nao verificado ligado.
            await derrubar();
            return { ok: false, motivo: `falha ao executar o WireSock: ${(e as Error)?.message ?? e}` };
        }

        // Sem nenhuma linha de log, o CLI nem chegou a tentar -- e o que acontece com perfil
        // inexistente, que ele reporta com frase traduzida e codigo de saida 0. Distinguir isto
        // do caso perigoso importa: um e "nao conectou", o outro e "conectou errado".
        if (mensagensDoLog(log).length === 0) {
            return { ok: false, motivo: `o WireSock nao chegou a conectar no perfil ${perfil}` };
        }

        const aplicados = appsAplicados(log);
        if (aplicados === null) {
            await derrubar();
            return {
                ok: false,
                motivo: "o WireSock nao declarou nenhum split tunnel: o perfil pode estar levando a maquina inteira"
            };
        }
        const faltando = apps.filter(a => !aplicados.includes(a));
        if (faltando.length > 0 || aplicados.length === 0) {
            await derrubar();
            return {
                ok: false,
                motivo: `o tunel subiu sem restringir a ${faltando.join(", ") || apps.join(", ")}`
                    + ` (aplicado: ${aplicados.join(", ") || "nada"})`
            };
        }

        if (await estado(perfil) !== "conectado") {
            await derrubar();
            return { ok: false, motivo: `o WireSock nao ficou conectado no perfil ${perfil}` };
        }

        // A consulta de geo do CLI demora: logo apos conectar, o `status` mostra o endereco
        // externo vazio. Medido em 11/09. Nao e motivo para falhar -- a verificacao que vale e a
        // do `localAddress` do proprio Discord, na fase 5.
        let saida = "";
        for (let i = 0; i < tentativas && saida === ""; i++) {
            if (i > 0) await dormir(500);
            try {
                saida = saidaDoStatus(await rodarCurto("status"));
            } catch {
                break;
            }
        }
        return { ok: true, saida };
    }

    return { subir, derrubar, estado, importar };
}
