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
    /** Qual dos candidatos esta no ar; `null` para nenhum deles. */
    perfilAtivo(candidatos: string[]): Promise<string | null | "desconhecido">;
    /** Poe `para` no ar no lugar do que estiver. Nao faz nada se ele ja estiver. */
    trocar(para: string): Promise<Resultado & { duracaoMs: number }>;
    /** Se o perfil esta importado. `desconhecido` quando nao deu para perguntar. */
    existe(perfil: string): Promise<boolean | "desconhecido">;
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
 * O nome do perfil aparece no texto como palavra inteira?
 *
 * Nao basta `includes`: `streamfix-santiago` esta contido em `streamfix-santiago-controle`, e
 * com o controle de pe o plugin acharia que o completo estava no ar. Ate o tunel em dois niveis
 * isso nao importava, porque so existia um perfil. Colado ao nome, antes ou depois, nao pode
 * haver letra, digito, `-` nem `_`.
 */
export function contemPerfil(texto: string, perfil: string): boolean {
    if (!perfil) return false;
    const nome = perfil.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}_-])${nome}(?![\\p{L}\\p{N}_-])`, "u").test(texto ?? "");
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
    return contemPerfil(t, perfil) ? "conectado" : "fora";
}

/**
 * Qual dos perfis candidatos esta no ar, pela mesma leitura do `status`.
 *
 * `null` e "nenhum deles" (outro perfil, ou nenhum). Saida vazia e `desconhecido`, pela mesma
 * razao de `estadoDoStatus`.
 */
export function perfilAtivoDoStatus(texto: string, candidatos: string[]): string | null | "desconhecido" {
    const t = (texto ?? "").trim();
    if (t.length === 0) return "desconhecido";
    return candidatos.find(p => contemPerfil(t, p)) ?? null;
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
    /** Relogio para medir a troca. Injetado nos testes. */
    agora?: () => number;
}

const espera = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function controleWireSock(opcoes: OpcoesControle): Controle & {
    importar(caminho: string, perfil: string): Promise<Resultado>;
} {
    const cli = opcoes.cli ?? CLI_PADRAO;
    const apps = opcoes.apps ?? ["Discord"];
    const tentativas = opcoes.tentativasDeSaida ?? 4;
    const dormir = opcoes.dormir ?? espera;
    const agora = opcoes.agora ?? Date.now;
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
            // Nome exato: com `streamfix-santiago-controle` na lista, um `includes` daria o
            // `streamfix-santiago` por importado mesmo que o import dele tivesse falhado.
            if (!contemPerfil(lista, perfil)) {
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
    function subir(perfil: string): Promise<Resultado> {
        return conectar(perfil, true);
    }

    /**
     * @param comSaida esperar o `status` mostrar o endereco externo. O `trocar` nao espera: com
     *   o controle no ar esse endereco e o de casa, ninguem o usa, e esperar por ele custava de
     *   1 a 1,5 s em cada troca -- medido na fase 8, em 12/09: cada `status` leva ~220 ms, e o
     *   endereco so aparece segundos depois do `connect`. No clique do Go Live, isso e espera.
     */
    async function conectar(perfil: string, comSaida: boolean): Promise<Resultado> {
        const saidaFinal = async () => comSaida ? await lerSaida() : "";
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

        // Sem nenhuma linha de log, o CLI nem chegou a tentar. Isso acontece em DOIS casos, e
        // eles pedem respostas opostas:
        //
        //   - perfil inexistente: ele recusa com frase traduzida e codigo de saida 0;
        //   - tunel ja de pe: ele responde "outra conexao ja esta em andamento", tambem
        //     traduzido e tambem sem log.
        //
        // O texto nao serve para distinguir -- e traduzido, e casar com ele daria resultado
        // diferente em cada idioma. O estado serve.
        //
        // Tratar os dois como erro foi o que aconteceu ate 11/09: a primeira abertura do Discord
        // depois de instalar reclamava "o WireSock nao chegou a conectar" com o tunel de pe e
        // funcionando. Alarme falso ensina a pessoa a ignorar o aviso -- que e pior do que nao
        // avisar.
        if (mensagensDoLog(log).length === 0) {
            if (await estado(perfil) === "conectado") {
                // **Sem o log, nao da para conferir o split tunnel nesta chamada.** Quem subiu
                // o tunel e que tinha de conferir; o instalador confere. Nao ha comando no CLI
                // que mostre os aplicativos de uma conexao ja ativa -- so o `connect` os
                // reporta. Quem quiser a prova de fora roda o Verifica-Tunel.ps1.
                return { ok: true, saida: await saidaFinal() };
            }
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

        return { ok: true, saida: await saidaFinal() };
    }

    /**
     * O endereco externo que o CLI reporta, com algumas tentativas.
     *
     * A consulta de geo dele demora: logo apos conectar, o `status` mostra o endereco externo
     * vazio. Medido em 11/09. Nao e motivo para falhar -- a verificacao que vale e a do
     * `localAddress` do proprio Discord, na fase 5.
     */
    async function lerSaida(): Promise<string> {
        let saida = "";
        for (let i = 0; i < tentativas && saida === ""; i++) {
            if (i > 0) await dormir(500);
            try {
                saida = saidaDoStatus(await rodarCurto("status"));
            } catch {
                break;
            }
        }
        return saida;
    }

    async function perfilAtivo(candidatos: string[]): Promise<string | null | "desconhecido"> {
        try {
            return perfilAtivoDoStatus(await rodarCurto("status"), candidatos);
        } catch {
            return "desconhecido";
        }
    }

    /**
     * Troca o perfil no ar, com a conferencia inteira do `subir`.
     *
     * O `disconnect` antes nao e opcional. Medido em 11/09: `connect` com outro perfil de pe e
     * recusado **sem log**, e o `subir` leria isso como "perfil inexistente". Os dois perfis usam
     * o mesmo endereco de tunel e a mesma saida, entao o gateway do Discord sobrevive ao buraco
     * entre os dois comandos (pesquisa, 12h). A troca inteira leva ~1,25 s (12i).
     */
    async function trocar(para: string): Promise<Resultado & { duracaoMs: number }> {
        const inicio = agora();
        if (await estado(para) === "conectado") {
            return { ok: true, saida: "", duracaoMs: agora() - inicio };
        }
        await derrubar();
        const r = await conectar(para, false);
        return { ...r, duracaoMs: agora() - inicio };
    }

    /**
     * Se o perfil aparece na `list`, pelo nome exato.
     *
     * **Nao saber e um terceiro estado**, pela mesma razao de `estado`. Logo depois do boot o
     * servico do WireSock pode ainda nao responder, e ler isso como "o perfil nao existe" deixava
     * o plugin no completo pela sessao inteira, sem tentar de novo. Quem chama decide: o plugin
     * repete a pergunta por um tempo e, se continuar sem resposta, fica no completo (E5).
     */
    async function existe(perfil: string): Promise<boolean | "desconhecido"> {
        let lista: string;
        try {
            lista = await rodarCurto("list");
        } catch {
            return "desconhecido";
        }
        return lista.trim().length === 0 ? "desconhecido" : contemPerfil(lista, perfil);
    }

    return { subir, derrubar, estado, perfilAtivo, trocar, existe, importar };
}
