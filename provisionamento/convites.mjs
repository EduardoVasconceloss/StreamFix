/*
 * Administracao da saida: criar convites, revogar, ver quem entrou, tirar alguem.
 *
 * Roda na maquina da saida, ao lado do `servidor.mjs`, sobre o mesmo arquivo de estado.
 *
 * **Depois de qualquer mudanca, o servidor precisa recarregar** -- ele mantem o estado em
 * memoria. Um `systemctl reload streamfix-provisionador` (ou `kill -HUP`) faz isso; os comandos
 * abaixo lembram disso sozinhos.
 *
 * Uso:
 *   node convites.mjs iniciar --faixa 10.8.0.0/24 --servidor 10.8.0.1 \
 *        --chave-da-saida <publica> --endpoint 159.112.151.37:39743
 *   node convites.mjs novo [--usos 1]
 *   node convites.mjs listar
 *   node convites.mjs revogar <codigo>
 *   node convites.mjs remover <chave-publica>
 *   node convites.mjs adotar <chave-publica> <endereco>
 *
 * O estado tem chave publica de todo mundo e os codigos de convite. Nao tem chave privada de
 * ninguem -- as privadas nunca saem das maquinas de quem instalou.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { argv, exit } from "node:process";

import { adotarPeer, criarConvite, remover, resumo, revogarConvite } from "./registro.ts";

const PADRAO = "/var/lib/streamfix/estado.json";

function opcao(nome, padrao = null) {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : padrao;
}

function morre(mensagem) {
    console.error(`erro: ${mensagem}`);
    exit(1);
}

const CAMINHO = opcao("estado", PADRAO);

function ler() {
    if (!existsSync(CAMINHO)) morre(`nao existe estado em ${CAMINHO}. Rode "iniciar" primeiro.`);
    try {
        return JSON.parse(readFileSync(CAMINHO, "utf8"));
    } catch (e) {
        morre(`estado ilegivel em ${CAMINHO}: ${e.message}`);
    }
}

/**
 * Grava por arquivo temporario e rename.
 *
 * Um rename e atomico no mesmo sistema de arquivos: ou o estado antigo esta la inteiro, ou o
 * novo esta. Escrever por cima deixaria uma janela em que o arquivo esta pela metade -- e o
 * servidor recarregando nessa janela perderia todos os peers.
 */
function gravar(estado) {
    const pasta = dirname(CAMINHO);
    if (!existsSync(pasta)) mkdirSync(pasta, { recursive: true, mode: 0o700 });

    const temporario = `${CAMINHO}.novo`;
    writeFileSync(temporario, `${JSON.stringify(estado, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporario, CAMINHO);
}

function lembrete() {
    console.log("");
    console.log("  O servidor guarda o estado em memoria. Para ele enxergar isto:");
    console.log("    sudo systemctl reload streamfix-provisionador");
}

/**
 * O codigo do convite.
 *
 * 20 caracteres de um alfabeto de 32 sao 100 bits de aleatoriedade -- o registro compara o
 * codigo direto, sem defesa contra adivinhacao alem do tamanho e do limite de tentativas do
 * servidor. Sem `I`, `L`, `O` e `U`: as tres primeiras se confundem com 1 e 0 quando alguem
 * digita em vez de colar, e a ultima so aparece em palavra que ninguem quer ver num convite.
 */
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function novoCodigo() {
    const bytes = randomBytes(20);
    let codigo = "";
    for (const b of bytes) codigo += ALFABETO[b % ALFABETO.length];
    return `${codigo.slice(0, 5)}-${codigo.slice(5, 10)}-${codigo.slice(10, 15)}-${codigo.slice(15)}`;
}

// ---------------------------------------------------------------------------------- comandos

function cmdIniciar() {
    if (existsSync(CAMINHO)) morre(`ja existe estado em ${CAMINHO}. Apague antes se quiser comecar de novo.`);

    const faixa = opcao("faixa", "10.8.0.0/24");
    const servidor = opcao("servidor", "10.8.0.1");
    const chave = opcao("chave-da-saida");
    const endpoint = opcao("endpoint");

    if (!chave) morre("falta --chave-da-saida (a publica do wg0 da saida)");
    if (!endpoint) morre("falta --endpoint (host:porta que quem instala vai discar)");

    gravar({
        faixa,
        enderecoServidor: servidor,
        saida: { chavePublica: chave, endpoint },
        convites: [],
        peers: []
    });

    console.log(`estado criado em ${CAMINHO}`);
    console.log(`  faixa ${faixa}, servidor em ${servidor}, saida ${endpoint}`);
    console.log("");
    console.log("  Agora crie um convite:  node convites.mjs novo");
}

function cmdNovo() {
    const usos = Number(opcao("usos", "1"));
    const estado = ler();
    const codigo = novoCodigo();

    const r = criarConvite(estado, codigo, usos);
    if (!r.ok) morre(r.motivo);

    gravar(r.estado);

    console.log("");
    console.log("  Convite criado. Mande so para quem voce quer na sua saida:");
    console.log("");
    console.log(`    ${codigo}`);
    console.log("");
    console.log(`  Vale para ${usos} ${usos === 1 ? "pessoa" : "pessoas"}.`);
    lembrete();
}

function cmdListar() {
    const r = resumo(ler());

    console.log("");
    console.log(`  Faixa ${r.faixa} -- ${r.enderecosLivres} endereco(s) livre(s)`);

    console.log("");
    console.log("  Convites:");
    if (r.convites.length === 0) console.log("    (nenhum)");
    for (const c of r.convites) {
        const estado = c.revogado ? "revogado" : (c.restam === 0 ? "esgotado" : `restam ${c.restam}`);
        console.log(`    ${c.codigo}  ${c.usados}/${c.usos}  ${estado}`);
    }

    console.log("");
    console.log("  Quem entrou:");
    if (r.peers.length === 0) console.log("    (ninguem)");
    for (const p of r.peers) {
        console.log(`    ${p.endereco}  por ${p.convite}  em ${p.criadoEm}`);
        console.log(`      ${p.publica}`);
    }
    console.log("");
}

function cmdRevogar() {
    const codigo = argv[3];
    if (!codigo || codigo.startsWith("--")) morre("uso: revogar <codigo>");

    const novo = revogarConvite(ler(), codigo);
    if (novo === null) morre(`nao existe convite ${codigo}`);

    gravar(novo);
    console.log(`convite ${codigo} revogado.`);
    console.log("  Quem ja entrou por ele CONTINUA dentro -- para tirar alguem, use: remover <chave>");
    lembrete();
}

function cmdRemover() {
    const chave = argv[3];
    if (!chave || chave.startsWith("--")) morre("uso: remover <chave-publica>");

    const estado = ler();
    const peer = estado.peers.find(p => p.publica === chave);
    const novo = remover(estado, chave);
    if (novo === null) morre("nao existe ninguem com essa chave publica");

    gravar(novo);
    console.log(`removido: ${peer.endereco}`);
    console.log("");
    console.log("  O endereco volta para a faixa. Tire tambem do WireGuard, que nao le o estado:");
    console.log(`    sudo wg set wg0 peer ${chave} remove`);
    lembrete();
}

function cmdAdotar() {
    const chave = argv[3];
    const endereco = argv[4];
    if (!chave || !endereco || chave.startsWith("--")) morre("uso: adotar <chave-publica> <endereco>");

    const r = adotarPeer(ler(), chave, endereco, new Date().toISOString());
    if (!r.ok) morre(r.motivo);

    gravar(r.estado);
    console.log(`adotado: ${endereco} para uma chave que ja estava no wg0.`);
    console.log("  Ele nao gastou convite -- ja estava aqui antes do provisionador.");
    lembrete();
}

const COMANDOS = {
    iniciar: cmdIniciar,
    novo: cmdNovo,
    listar: cmdListar,
    revogar: cmdRevogar,
    remover: cmdRemover,
    adotar: cmdAdotar
};

const comando = COMANDOS[argv[2]];
if (!comando) {
    console.error("uso: node convites.mjs <iniciar|novo|listar|revogar|remover|adotar> [opcoes]");
    console.error("     --estado <caminho>   (padrao: " + PADRAO + ")");
    exit(1);
}
comando();
