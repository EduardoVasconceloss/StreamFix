#!/usr/bin/env node
// O provisionador que roda na saida. Fino de proposito: toda decisao vive em `registro.ts`, que
// e testado. O que sobra aqui e HTTP, disco e `wg`.
//
// Sobe com:
//   node servidor.mjs --estado /var/lib/streamfix/estado.json --porta 8787
//
// **Atomicidade.** `registrar` e sincrona e nao espera nada no meio, e este arquivo nao coloca
// `await` entre decidir e gravar o estado em memoria. E o que garante que dois registros
// simultaneos nunca recebam o mesmo endereco. A gravacao em disco e o `wg set` acontecem depois,
// com o estado ja fixado.
//
// **Este servico nao fala TLS.** A saida tem IP e nao dominio, entao nao ha certificado a
// emitir. A defesa contra alguem no caminho responder por outra saida esta no cliente, que
// confere a chave publica esperada. Ver `cliente.ts`. Se um dia houver dominio, ponha um nginx
// na frente e nada aqui muda.

import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { blocoDoPeer, registrar } from "./registro.ts";

// ---------------------------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------------------------

function argumento(nome, padrao) {
    const i = process.argv.indexOf(`--${nome}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const CAMINHO = argumento("estado", "/var/lib/streamfix/estado.json");
const PORTA = Number(argumento("porta", "8787"));
const INTERFACE = argumento("interface", "wg0");
// Escuta so no loopback por padrao: quem expoe e o proxy reverso ou a regra de firewall, nunca
// um descuido de configuracao.
const ENDERECO = argumento("endereco", "127.0.0.1");

// ---------------------------------------------------------------------------------------------
// Estado em disco
// ---------------------------------------------------------------------------------------------

let estado = JSON.parse(readFileSync(CAMINHO, "utf8"));

// Convites sao criados e revogados editando o arquivo de estado. Sem isto, a edicao nao teria
// efeito ate o proximo reboot -- e quem revogou um convite acharia que revogou.
process.on("SIGHUP", () => {
    try {
        estado = JSON.parse(readFileSync(CAMINHO, "utf8"));
        console.log(`[recarga] ${estado.convites.length} convites, ${estado.peers.length} peers`);
    } catch (e) {
        console.error(`[erro] recarga ignorada, estado em memoria mantido: ${e.message}`);
    }
});

/** Grava por arquivo temporario e `rename`, que e atomico no mesmo sistema de arquivos. */
function gravar(novo) {
    const temporario = `${CAMINHO}.novo`;
    writeFileSync(temporario, JSON.stringify(novo, null, 2), { mode: 0o600 });
    renameSync(temporario, CAMINHO);
}

/** Acrescenta o peer na interface viva. Sem isso, a pessoa so entra no proximo reboot. */
function aplicarPeer(peer) {
    return new Promise(resolve => {
        const p = spawn("wg", ["set", INTERFACE, "peer", peer.publica, "allowed-ips", `${peer.endereco}/32`],
            { stdio: ["ignore", "ignore", "pipe"] });
        let erro = "";
        p.stderr.on("data", d => { erro += d; });
        p.on("close", codigo => resolve(codigo === 0 ? null : erro.trim() || `wg saiu com ${codigo}`));
        p.on("error", e => resolve(e.message));
    });
}

// ---------------------------------------------------------------------------------------------
// Limite de tentativas
// ---------------------------------------------------------------------------------------------

// A defesa que importa para o convite: adivinhar por forca bruta. O codigo e longo e aleatorio,
// mas um limite por origem transforma "improvavel" em "inviavel".
const TENTATIVAS = new Map();
const JANELA_MS = 60_000;
const MAXIMO = 10;

function excedeu(origem) {
    const agora = Date.now();
    const recentes = (TENTATIVAS.get(origem) ?? []).filter(t => agora - t < JANELA_MS);
    recentes.push(agora);
    TENTATIVAS.set(origem, recentes);
    if (TENTATIVAS.size > 10_000) TENTATIVAS.clear(); // teto de memoria, nao precisao
    return recentes.length > MAXIMO;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

const STATUS = {
    chave_invalida: 400,
    convite_invalido: 403,
    convite_revogado: 403,
    convite_esgotado: 403,
    faixa_cheia: 503
};

function responder(res, status, corpo) {
    const texto = JSON.stringify(corpo);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(texto) });
    res.end(texto);
}

function lerCorpo(req) {
    return new Promise((resolve, reject) => {
        let dados = "";
        req.on("data", pedaco => {
            dados += pedaco;
            // Um corpo legitimo tem ~150 bytes. Cortar cedo evita encher memoria de graca.
            if (dados.length > 4096) reject(new Error("corpo grande demais"));
        });
        req.on("end", () => {
            try { resolve(JSON.parse(dados)); } catch { reject(new Error("corpo nao e JSON")); }
        });
        req.on("error", reject);
    });
}

const servidor = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/registrar") {
        return responder(res, 404, { codigo: "nao_encontrado" });
    }
    const origem = req.socket.remoteAddress ?? "desconhecida";
    if (excedeu(origem)) {
        return responder(res, 429, { codigo: "tentativas_demais" });
    }

    let pedido;
    try {
        pedido = await lerCorpo(req);
    } catch (e) {
        return responder(res, 400, { codigo: "corpo_invalido", erro: e.message });
    }

    // Daqui ate `estado = r.estado` nao pode haver `await`: e o que serializa os registros.
    const r = registrar(estado, pedido, new Date().toISOString());
    if (!r.ok) {
        console.log(`[recusa] ${origem} ${r.codigo}`);
        return responder(res, STATUS[r.codigo] ?? 400, { codigo: r.codigo, erro: r.erro });
    }
    const anterior = estado;
    estado = r.estado;

    if (r.peerNovo) {
        try {
            gravar(estado);
        } catch (e) {
            estado = anterior; // nao vale entregar um endereco que nao sobrevive a um reboot
            console.error(`[erro] nao gravei o estado: ${e.message}`);
            return responder(res, 500, { codigo: "estado_nao_gravado" });
        }
        const falha = await aplicarPeer(r.peerNovo);
        if (falha) {
            // O estado fica: o peer esta registrado e entra no proximo `wg syncconf`. O que nao
            // pode e dizer "pronto" para quem nao vai conseguir conectar agora.
            console.error(`[erro] wg set falhou: ${falha}`);
            return responder(res, 500, { codigo: "peer_nao_aplicado" });
        }
        console.log(`[entrada] ${r.peerNovo.endereco} pelo convite ${r.peerNovo.convite}`);
        console.log(blocoDoPeer(r.peerNovo).split("\n")[0]); // marca no log sem despejar a chave
    }

    responder(res, 200, r.resposta);
});

servidor.listen(PORTA, ENDERECO, () => {
    console.log(`provisionador em ${ENDERECO}:${PORTA}, interface ${INTERFACE}, estado ${CAMINHO}`);
});
