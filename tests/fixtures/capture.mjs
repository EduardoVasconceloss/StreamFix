// Grava as entradas do SessionMonitor durante uma transmissao real, para virarem fixture.
//
// Uso:
//   1. Feche o Discord e abra com:
//        --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
//      O endereco importa: sem ele a porta escuta em todas as interfaces da maquina.
//   2. node tests/fixtures/capture.mjs <cenario> [--nota "texto"] [--duracao <segundos>]
//   3. Faca o cenario. Ctrl+C para encerrar, ou deixe o --duracao encerrar sozinho.
//
// Cenarios previstos em docs/superpowers/plans/2026-09-08-tunel-momentaneo-plan.md, fase 1.
//
// O arquivo gerado vai para o repositorio publico. Por isso a extracao usa lista de permissao,
// nunca de exclusao: so os campos nomeados aqui saem da pagina. Nada de id de usuario, de
// servidor ou de canal, e nenhum dado de quem esta assistindo -- so contadores de saida.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CENARIOS = new Set([
    "saudavel-longa",
    "quebra-entrada-espectador",
    "eventos-locais",
    "sem-espectador",
    "negada-desde-o-nascimento",
]);

const INTERVALO_MS = 500;
// `getStats()` tem um prazo interno de 1s e devolve `undefined` quando estoura. Uma amostra
// vazia e um dado legitimo -- significa que a engine nao respondeu a tempo --, mas duas
// chamadas simultaneas nao sao: o laco espera a anterior antes de pedir a proxima.
const PRAZO_AVALIACAO_MS = 4000;

const aqui = dirname(fileURLToPath(import.meta.url));

const [, , cenario, ...resto] = process.argv;
if (!cenario || !CENARIOS.has(cenario)) {
    console.error(`Uso: node tests/fixtures/capture.mjs <cenario> [--nota "texto"] [--duracao <segundos>]\n`);
    console.error(`Cenarios: ${[...CENARIOS].join(", ")}`);
    process.exit(2);
}
function opcao(nome) {
    const i = resto.indexOf(nome);
    return i >= 0 ? resto[i + 1] : undefined;
}
const nota = opcao("--nota") ?? "";
// Encerramento por tempo, alem do Ctrl+C. Serve para captura sem ninguem olhando, e porque
// mandar SIGINT de fora nem sempre chega num processo Node no Windows -- sem isto, a unica
// forma de parar seria matar o processo, e o registro de fim nao seria gravado.
const duracaoS = Number(opcao("--duracao") ?? 0);
if (opcao("--duracao") !== undefined && !(duracaoS > 0)) {
    console.error("--duracao precisa de um numero de segundos maior que zero.");
    process.exit(2);
}

const destino = join(aqui, `${cenario}.jsonl`);
mkdirSync(aqui, { recursive: true });

// Criacao exclusiva e atomica, com o descritor mantido aberto ate o fim. Testar a existencia
// antes e depois abrir nao basta: duas capturas do mesmo cenario -- ou uma captura antiga que
// ficou viva sem ninguem notar -- passariam as duas pela checagem e intercalariam linhas no
// mesmo arquivo. O resultado seria uma fixture com duas series misturadas, sem nada que
// indique isso na leitura. Aconteceu de verdade em 08/09/2026, com um processo orfao.
let fd;
try {
    fd = openSync(destino, "ax");
} catch (e) {
    if (e.code === "EEXIST") {
        console.error(`${destino} ja existe. Renomeie ou apague antes de regravar.`);
        console.error("Se voce nao criou este arquivo agora, pode haver uma captura ainda rodando.");
        process.exit(2);
    }
    throw e;
}

// A expressao avaliada na pagina. Devolve uma amostra ja reduzida aos campos permitidos: o
// recorte acontece dentro do Discord, entao o que nao esta na lista nunca chega ate aqui.
//
// Os nomes vem do proprio bundle (modulo 206959, funcao que monta a entrada de video das
// estatisticas), conferidos em 08/09/2026. Se o Discord renomear, a captura passa a gravar
// `null` em vez de mentir com zero -- por isso os campos ausentes viram null, nao 0.
const AMOSTRA = `(async () => {
  const eng = Vencord.Webpack.findStore("MediaEngineStore").getMediaEngine();
  const conns = [...eng.connections];
  const perm = e => e == null ? null : ({
    ssrc: e.ssrc ?? null,
    sinkWantAsInt: e.sinkWantAsInt ?? null,
    codec: e.codec?.name ?? null,
    bytesSent: e.bytesSent ?? null,
    packetsSent: e.packetsSent ?? null,
    framesEncoded: e.framesEncoded ?? null,
    frameRateInput: e.frameRateInput ?? null,
    frameRateEncode: e.frameRateEncode ?? null,
    framesDroppedEncoder: e.framesDroppedEncoder ?? null,
    bitrate: e.bitrate ?? null,
    bitrateTarget: e.bitrateTarget ?? null,
  });
  // So numeros: a saida de captura vem crua do modulo nativo e seus campos nao estao na lista
  // conferida. Numero nao carrega identificador; um campo de texto novo poderia.
  const numeros = o => {
    if (o == null || typeof o !== "object") return null;
    const r = {};
    for (const k of Object.keys(o).slice(0, 20)) if (typeof o[k] === "number") r[k] = o[k];
    return r;
  };
  // Quantos assistem. E o sinal que decide se o monitor pode concluir alguma coisa:
  // `sinkWantAsInt` fica em 100 mesmo sem ninguem, entao nao serve para isso. So a contagem
  // e gravada -- os ids de quem assiste identificam pessoas e nao entram na fixture.
  let espectadores = null;
  try {
    const ss = Vencord.Webpack.findStore("ApplicationStreamingStore");
    const meu = ss.getCurrentUserActiveStream();
    espectadores = meu == null ? null : (ss.getViewerIds(meu) ?? []).length;
  } catch (e) { espectadores = null; }

  const out = [];
  for (const c of conns) {
    let stats = null;
    try { stats = await c.getStats(); } catch (e) { stats = null; }
    const saida = stats?.rtp?.outbound ?? [];
    const video = Array.isArray(saida) ? saida.filter(e => e?.type === "video").map(perm) : [];
    const audio = Array.isArray(saida) ? saida.filter(e => e?.type === "audio").map(perm) : [];
    out.push({
      // Separa "a captura parou de produzir quadro" de "o servidor recusou a entrega" -- os
      // dois zeram framesEncoded, e so estes contadores dizem qual dos dois foi. Ver o defeito
      // de quadro em branco em docs/research/regressao-encoder-inativo-2026-09-03.md.
      captura: { tela: numeros(stats?.screenshare), camera: numeros(stats?.camera) },
      context: c.context ?? null,
      connectionState: c.connectionState ?? null,
      selfVideo: c.selfVideo ?? null,
      statsPresente: stats != null,
      // Gravado so para provar por dado que nao serve de sinal: na fixture de quebra ele
      // permanece true enquanto a entrega ja morreu. Ver a spec, secao SessionMonitor.
      paramsActive: (c.videoStreamParameters ?? []).map(p => p?.active ?? null),
      video,
      audio,
    });
  }
  return { conns: conns.length, espectadores, dados: out };
})()`;

// ---------------------------------------------------------------------------

const alvos = await fetch("http://127.0.0.1:9222/json/list")
    .then(r => r.json())
    .catch(() => null);
if (!alvos) {
    console.error("Nao consegui falar com o Discord em 127.0.0.1:9222.");
    console.error("Ele esta aberto com --remote-debugging-port=9222?");
    process.exit(1);
}
const pagina = alvos.find(t => t.type === "page" && (t.url || "").includes("discord.com"));
if (!pagina) {
    console.error("Porta aberta, mas nenhuma pagina do Discord. Ele terminou de carregar?");
    process.exit(1);
}

const ws = new WebSocket(pagina.webSocketDebuggerUrl);
let proximoId = 0;
const pendentes = new Map();

function enviar(method, params) {
    return new Promise((resolve, reject) => {
        const id = ++proximoId;
        pendentes.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
            if (pendentes.delete(id)) reject(new Error("prazo esgotado"));
        }, PRAZO_AVALIACAO_MS);
    });
}

ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pendentes.get(msg.id);
    if (!p) return;
    pendentes.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
};

let amostras = 0;
let falhas = 0;
let rodando = true;

function gravar(registro) {
    writeSync(fd, JSON.stringify(registro) + "\n");
}

// Uma linha de status que se reescreve: quem esta gravando esta transmitindo ao mesmo tempo e
// precisa ver, sem trocar de janela, que a captura continua viva e enxergando video.
function status(ultima) {
    const v = ultima?.dados?.[0]?.video?.[0];
    const frames = v?.framesEncoded ?? "-";
    const want = v?.sinkWantAsInt ?? "-";
    const linha = `  ${amostras} amostras | conexoes=${ultima?.conns ?? 0} | espectadores=${ultima?.espectadores ?? "-"} | framesEncoded=${frames} | falhas=${falhas}`;
    process.stdout.write("\r" + linha.padEnd(88));
}

async function laco() {
    while (rodando) {
        const inicio = Date.now();
        let dados = null;
        try {
            const r = await enviar("Runtime.evaluate", {
                expression: AMOSTRA,
                awaitPromise: true,
                returnByValue: true,
                allowUnsafeEvalBlockedByCSP: true,
            });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "excecao na pagina");
            dados = r.result.value;
            gravar({ t: new Date().toISOString(), ...dados });
            amostras++;
        } catch (e) {
            // Uma falha de amostragem tambem e dado: grava o buraco em vez de fingir
            // continuidade. Um monitor que veja lacunas na fixture precisa saber que houve.
            falhas++;
            gravar({ t: new Date().toISOString(), erro: String(e.message).slice(0, 200) });
        }
        status(dados);
        const resta = INTERVALO_MS - (Date.now() - inicio);
        if (resta > 0) await new Promise(r => setTimeout(r, resta));
    }
}

function encerrar() {
    if (!rodando) return;
    rodando = false;
    gravar({ kind: "fim", t: new Date().toISOString(), amostras, falhas });
    console.log(`\n\nGravado: ${destino}`);
    console.log(`${amostras} amostras, ${falhas} falhas.`);
    if (amostras < 20) console.log("Poucas amostras para virar fixture util -- vale regravar.");
    try { closeSync(fd); } catch { /* ja fechado */ }
    try { ws.close(); } catch { /* ja fechado */ }
    process.exit(0);
}

process.on("SIGINT", encerrar);

ws.onopen = () => {
    gravar({
        kind: "meta",
        cenario,
        nota,
        gravadoEm: new Date().toISOString(),
        intervaloMs: INTERVALO_MS,
        // Versao do formato: se os campos amostrados mudarem, as fixtures antigas continuam
        // legiveis e os testes conseguem dizer qual formato estao lendo.
        // 2: passou a gravar a contagem de espectadores, sem a qual o monitor nao conclui nada.
        formato: 2,
    });
    console.log(`Gravando "${cenario}" em ${destino}`);
    console.log(duracaoS > 0
        ? `Faca o cenario. Encerra sozinho em ${duracaoS}s, ou Ctrl+C antes.\n`
        : "Faca o cenario. Ctrl+C para encerrar.\n");
    if (duracaoS > 0) setTimeout(encerrar, duracaoS * 1000);
    laco();
};

ws.onerror = () => {
    console.error("Falha na conexao com o Discord.");
    process.exit(1);
};
