/*
 * Provisiona o tunel: mede o MTU, gera o par de chaves, troca o convite por um endereco na
 * saida, e escreve o `.conf` que o WireSock vai importar.
 *
 * **Por que isto e JavaScript e nao PowerShell.** Toda a decisao que importa aqui ja existe em
 * TypeScript e ja tem teste: `perfil.ts` (56 testes de geracao e de MTU), `cliente.ts` (15 do
 * registro). Reescrever isso em PowerShell seria duplicar logica testada numa linguagem sem
 * teste nenhum neste repositorio. O PowerShell fica com o que so ele faz: achar o WireSock,
 * instalar o que falta, importar o perfil, falar com a pessoa.
 *
 * **O convite entra por stdin, nao por argumento.** Argumento de linha de comando aparece na
 * lista de processos para qualquer usuario da maquina.
 *
 * **A chave privada nunca sai daqui a nao ser dentro do arquivo.** Ela nao vai para stdout, nem
 * para stderr, nem para mensagem de erro. Quem chama recebe so o caminho do arquivo -- e deve
 * apaga-lo depois de importar, porque o WireSock guarda copia propria (medido em 11/09).
 *
 * Uso:
 *   echo <convite> | node provisiona.mjs --url http://IP:8787/registrar --arquivo C:\...\p.conf
 *
 * Opcional: --apps "Discord,DiscordPTB" limita quais aplicativos entram no tunel.
 *
 * Escreve uma linha de JSON em stdout. Diagnostico vai para stderr.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { argv, exit, platform, stderr, stdin, stdout } from "node:process";

import { comandoPing, gerarPerfil, medirMtuComAlternativas, mtuDoTunel, respostaChegou } from "../streamFix/tunnel/perfil.ts";
import { registrarNaSaida } from "../provisionamento/cliente.ts";

const PRAZO_PING_MS = 5000;
const PRAZO_REGISTRO_MS = 15000;

function opcao(nome, padrao = null) {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : padrao;
}

function conta(texto) {
    stderr.write(`${texto}\n`);
}

function responde(objeto) {
    stdout.write(`${JSON.stringify(objeto)}\n`);
    exit(objeto.ok ? 0 : 1);
}

/** Le o convite de stdin. Vazio e um erro com nome, nao um registro que falha la na frente. */
async function lerConvite() {
    let texto = "";
    stdin.setEncoding("utf8");
    for await (const pedaco of stdin) texto += pedaco;
    return texto.trim();
}

/** A sonda de verdade: um ping que nao fragmenta. Erro do ping e "nao coube", nao excecao. */
function sondaPara(alvo) {
    return carga => new Promise(resolve => {
        const { exe, args } = comandoPing(alvo, carga, platform);
        execFile(exe, args, { encoding: "utf8", timeout: PRAZO_PING_MS, windowsHide: true }, (_erro, saida, resto) => {
            resolve(respostaChegou(`${saida ?? ""}${resto ?? ""}`));
        });
    });
}

/** O transporte do registro. A privada nao passa por aqui -- so a publica vai no corpo. */
async function transporte(url, corpo) {
    const controle = new AbortController();
    const prazo = setTimeout(() => controle.abort(), PRAZO_REGISTRO_MS);
    try {
        const resposta = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(corpo),
            signal: controle.signal
        });
        let lido = null;
        try { lido = await resposta.json(); } catch { lido = null; }
        return { status: resposta.status, corpo: lido };
    } finally {
        clearTimeout(prazo);
    }
}

async function principal() {
    const url = opcao("url");
    const arquivo = opcao("arquivo");
    const chaveEsperada = opcao("chave-da-saida") ?? undefined;
    const alvoPreferido = opcao("medir-contra");

    // Os aplicativos que o tunel aceita. Eram fixos em ["Discord"], e isso deixava quem usa o
    // Discord PTB ou o Canary -- que o instalador suporta e injeta normalmente -- com um tunel
    // de pe que nao casava com o proprio cliente: nada entrava nele, e o Discord seguia saindo
    // pelo IP de casa como se o StreamFix nao existisse.
    //
    // Listar os tres por padrao e mais barato do que detectar: ter o PTB na lista sem ter o PTB
    // instalado nao custa nada, e errar a deteccao custa um tunel que nao funciona.
    const apps = (opcao("apps") ?? "Discord,DiscordPTB,DiscordCanary")
        .split(",").map(a => a.trim()).filter(a => a.length > 0);
    if (apps.length === 0) responde({ ok: false, erro: "--apps vazio levaria a maquina inteira" });

    if (!url) responde({ ok: false, erro: "falta --url" });
    if (!arquivo) responde({ ok: false, erro: "falta --arquivo" });

    // O nome do perfil no WireSock vem do NOME DO ARQUIVO, nao do que se pede no import.
    // Descoberto na fase 3, e e por isso que quem chama escolhe o arquivo com cuidado.
    const perfil = basename(arquivo).replace(/\.conf$/i, "");

    const convite = await lerConvite();
    if (convite.length === 0) responde({ ok: false, erro: "convite vazio: nada chegou pela entrada padrao" });

    // `--mtu-do-caminho` pula a medicao. Existe por dois motivos: o teste automatico nao pode depender de
    // ping para a internet, e quem tem ICMP bloqueado na saida nao consegue medir de jeito
    // nenhum -- e ficar sem tunel por causa disso seria pior do que usar um valor sabido.
    const mtuForcado = opcao("mtu-do-caminho");
    let medida;
    if (mtuForcado !== null) {
        const valor = Number(mtuForcado);
        if (!Number.isInteger(valor) || valor < 576 || valor > 1500) {
            responde({ ok: false, erro: `--mtu-do-caminho invalido: ${mtuForcado}` });
        }
        medida = { mtu: valor, alvo: "informado na linha de comando" };
    } else {
        conta("medindo o MTU do caminho...");
        // A saida propria vem primeiro quando da: medir contra ela e melhor, nao necessario.
        const alvos = alvoPreferido ? [alvoPreferido, "8.8.8.8", "1.1.1.1"] : ["8.8.8.8", "1.1.1.1"];
        medida = await medirMtuComAlternativas(alvos, sondaPara);
        if (medida === null) {
            responde({
                ok: false,
                erro: "nao consegui medir o MTU: nenhum alvo respondeu ao ping."
                    + " Pode ser rede fora do ar ou ICMP bloqueado na sua saida."
            });
        }
    }
    const mtu = mtuDoTunel(medida.mtu);
    conta(`caminho ${medida.mtu} por ${medida.alvo}, tunel ${mtu}`);

    conta("trocando o convite por um endereco na saida...");
    const registro = await registrarNaSaida(url, convite, transporte, chaveEsperada);
    if (!registro.ok) responde({ ok: false, erro: registro.motivo });

    const conf = gerarPerfil({
        chavePrivada: registro.privada,
        endereco: registro.dados.endereco,
        mtu,
        chavePublicaDoServidor: registro.dados.chavePublicaDoServidor,
        endpoint: registro.dados.endpoint,
        destinos: registro.dados.faixa,
        apps
    });

    // 0o600 desde a criacao: o arquivo nasce com a privada dentro, e nao existe instante em que
    // ele esteja legivel para outra conta. No Windows o modo vale pouco, mas o arquivo tambem
    // vive pouco -- quem chama apaga depois de importar.
    writeFileSync(arquivo, conf, { encoding: "utf8", mode: 0o600 });

    responde({
        ok: true,
        perfil,
        arquivo,
        endereco: registro.dados.endereco,
        endpoint: registro.dados.endpoint,
        faixa: registro.dados.faixa,
        mtuDoCaminho: medida.mtu,
        mtuDoTunel: mtu,
        medidoContra: medida.alvo,
        apps
    });
}

principal().catch(erro => {
    // A privada nunca chega a uma mensagem de erro: ela so existe depois do registro, e dali
    // vai direto para o arquivo.
    responde({ ok: false, erro: erro?.message ?? String(erro) });
});
