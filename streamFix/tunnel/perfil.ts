// Gera o perfil `.conf` do WireSock e mede o MTU que ele precisa declarar.
//
// Unidade pequena e desproporcionalmente perigosa: das tres falhas silenciosas de 11/09, duas
// nasceram aqui. As duas erram para o mesmo lado -- o tunel sobe, o teste de ponta a ponta
// passa, e o que esta errado so aparece semanas depois como "as vezes a stream trava".
//
//   1. `#@ws:AllowedApps` no bloco errado e descartado em silencio, e o tunel leva a maquina
//      inteira em vez de so o Discord. Ver 2026-09-08-spike-wiresock.md, "A sintaxe certa".
//   2. MTU fixo em 1420 assume caminho de 1500. O link de casa e PPPoE, 1492. Oito bytes
//      bastam para descartar pacote cheio de video sem aviso nenhum.
//
// Sem nenhum import: assim o Node carrega este arquivo por `require()` direto e os testes rodam
// contra a producao, nao contra uma copia dela. Mesma razao documentada em coletor.ts.

// ---------------------------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------------------------

/** O que o provisionamento entrega, mais o que foi medido na maquina. */
export interface DadosPerfil {
    /** Credencial. Entra no texto e nao pode sair em log, erro ou relatorio. */
    chavePrivada: string;
    /** Endereco interno desta pessoa na faixa da saida, com mascara. Ex.: `10.8.0.2/32`. */
    endereco: string;
    /** Chave publica do servidor de saida. */
    chavePublicaDoServidor: string;
    /** `host:porta` da saida. */
    endpoint: string;
    /** MTU **medido**, ja descontada a sobrecarga. Ver `mtuDoTunel`. */
    mtu: number;
    /** Nomes de processo que entram no tunel. Sem caminho e sem `.exe`. */
    apps?: string[];
    /**
     * Destinos que o tunel carrega. `0.0.0.0/0` mais `AllowedApps` = "tudo, so para o Discord".
     *
     * **Nao confundir com a faixa interna da saida.** Passar `10.8.0.0/24` aqui monta um tunel
     * que conecta, faz handshake, aceita o AllowedApps -- e nao carrega nada, porque nenhum
     * servidor do Discord esta nessa faixa. Foi o que aconteceu com todo perfil gerado ate
     * 11/09: `status` dizia "conectado" e o endereco externo continuava sendo o de casa.
     */
    destinos?: string;

    /**
     * Resolvedor que os aplicativos do tunel usam.
     *
     * Sem ele, quem esta no tunel resolve nomes pelo resolvedor do sistema, que sai por fora --
     * e o Discord usa GeoDNS, entao resolver do Brasil devolve servidor brasileiro mesmo com os
     * pacotes saindo pelo Chile. O perfil que funciona desde o spike tem `1.1.1.1`.
     */
    dns?: string;
    /** Segundos entre keepalives. Mantem o NAT aberto do lado de ca. */
    keepalive?: number;
}

/**
 * O que o perfil de controle carrega: o gateway, a API, a CDN e a sinalizacao de voz do Discord,
 * mais o DNS do perfil. So isso.
 *
 * Medido daqui em 11/09 (pesquisa, 12h): gateway, `discord.com`, CDN, `media.discordapp.net` e
 * `c-gru13-*.discord.media` resolvem todos para `162.159.128.0/17`, da Cloudflare. Com so esta
 * faixa no tunel, o servidor nao manda a Trava 1 e a midia sai direta, a ~35 ms.
 *
 * E uma lista do que ENTRA, e nao do que fica fora, de proposito. Se ela ficar curta em algum
 * lugar, o sintoma e "a Trava 1 voltou", que o plugin detecta pela atribuicao do servidor. Uma
 * lista do que fica fora, curta, apareceria como transmissao preta -- a falha silenciosa que o
 * projeto existe para evitar.
 */
export const FAIXA_CONTROLE = "162.159.128.0/17, 1.1.1.1/32";

/**
 * O nome do perfil de controle, a partir do completo: mesma chave, mesmo peer, so a
 * `FAIXA_CONTROLE` no `AllowedIPs`.
 *
 * O WireSock nomeia o perfil pelo nome do arquivo, e o plugin procura o perfil por este nome.
 * Os dois lados tem de concordar aqui, e o instalador espelha a regra (teste de drift).
 */
export function perfilDeControle(perfil: string): string {
    return `${perfil}-controle`;
}

/** Campos que entram no texto sem aspas: um `\n` aqui injetaria diretiva no perfil. */
const SEGURO = /^[A-Za-z0-9+/=:._\-,[\]]+$/;

function exigir(campo: string, valor: string) {
    if (typeof valor !== "string" || valor.length === 0) throw new Error(`perfil: ${campo} vazio`);
    // A mensagem nomeia o campo e nunca mostra o valor -- um deles e a chave privada.
    if (!SEGURO.test(valor)) throw new Error(`perfil: ${campo} tem caractere invalido`);
}

/**
 * Monta o texto do perfil.
 *
 * A ordem nao e estetica. `#@ws:AllowedApps` **tem** que vir dentro do `[Peer]`, depois do
 * comentario que a interface grafica do WireSock escreve -- foi comparando o arquivo antes e
 * depois de deixar a GUI gravar que se descobriu qual bloco vale. No `[Interface]` a linha e
 * aceita, guardada, e ignorada.
 */
export function gerarPerfil(dados: DadosPerfil): string {
    exigir("chavePrivada", dados.chavePrivada);
    exigir("endereco", dados.endereco);
    exigir("chavePublicaDoServidor", dados.chavePublicaDoServidor);
    exigir("endpoint", dados.endpoint);

    const mtu = dados.mtu;
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 1500) {
        throw new Error(`perfil: MTU fora da faixa aceitavel: ${mtu}`);
    }

    const apps = dados.apps ?? ["Discord"];
    if (apps.length === 0) throw new Error("perfil: lista de apps vazia levaria a maquina inteira");
    apps.forEach((app, i) => exigir(`apps[${i}]`, app));

    const destinos = dados.destinos ?? "0.0.0.0/0";
    const keepalive = dados.keepalive ?? 25;
    const dns = dados.dns ?? "1.1.1.1";
    exigir("dns", dns);

    return [
        "[Interface]",
        `PrivateKey = ${dados.chavePrivada}`,
        `Address = ${dados.endereco}`,
        `DNS = ${dns}`,
        `MTU = ${mtu}`,
        "",
        "[Peer]",
        `PublicKey = ${dados.chavePublicaDoServidor}`,
        `Endpoint = ${dados.endpoint}`,
        `AllowedIPs = ${destinos}`,
        `PersistentKeepalive = ${keepalive}`,
        "",
        "# [Peer] WireSock extensions",
        `#@ws:AllowedApps = ${apps.join(", ")}`,
        ""
    ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// MTU
// ---------------------------------------------------------------------------------------------

/** Cabecalho IPv4 (20) mais cabecalho ICMP (8). O `-l` do ping conta so a carga. */
export const CABECALHO_ICMP = 28;

/** UDP mais o cabecalho do WireGuard, sobre IPv4. */
export const SOBRECARGA_WIREGUARD = 80;

/** Carga minima e maxima que a busca considera. 1472 + 28 = 1500, o teto de Ethernet. */
export const CARGA_MINIMA = 548;
export const CARGA_MAXIMA = 1472;

/** Pergunta se um datagrama com esta carga atravessa sem fragmentar. */
export type Sonda = (carga: number) => Promise<boolean>;

/**
 * Busca binaria pelo MTU do caminho ate a saida.
 *
 * Devolve `null` quando nem a carga minima passa -- que nao significa "caminho estreito", e sim
 * "nao sei": ICMP bloqueado, saida fora do ar, rede caida. Chutar um valor aqui seria repetir o
 * erro do 1420 fixo, so que com mais confianca.
 */
export async function medirMtuDoCaminho(
    cabe: Sonda,
    limites: { minimo?: number; maximo?: number } = {}
): Promise<number | null> {
    let baixo = limites.minimo ?? CARGA_MINIMA;
    let alto = limites.maximo ?? CARGA_MAXIMA;
    if (baixo > alto) throw new Error("perfil: limites de busca invertidos");

    if (await cabe(alto)) return alto + CABECALHO_ICMP;
    if (!(await cabe(baixo))) return null;

    // Invariante: `baixo` passa, `alto` nao. A busca so encolhe o intervalo entre os dois.
    while (alto - baixo > 1) {
        const meio = Math.floor((baixo + alto) / 2);
        if (await cabe(meio)) baixo = meio;
        else alto = meio;
    }
    return baixo + CABECALHO_ICMP;
}

/**
 * Alvos de medicao, em ordem de preferencia.
 *
 * A saida propria vem primeiro, mas nao da para depender dela: medido em 11/09, a VPS de
 * Santiago **nao responde echo**. O host aceita (`-A INPUT -p icmp -j ACCEPT`); quem descarta e
 * a security list da OCI, que por padrao libera so "fragmentation needed" e nao o tipo 8. Uma
 * saida de terceiro pode ser igual ou pior.
 *
 * Medir contra outro host nao falseia o resultado: o gargalo e o link de casa, que esta em todo
 * caminho que sai desta maquina. Medir contra a propria saida e melhor quando da, nao
 * necessario.
 */
export const ALTERNATIVAS = ["8.8.8.8", "1.1.1.1"];

/**
 * Mede contra o primeiro alvo que responder.
 *
 * Devolve `null` so quando nenhum respondeu -- ai o problema e a rede ou o ICMP da saida da
 * maquina, e nao ha numero honesto a dar.
 */
export async function medirMtuComAlternativas(
    alvos: string[],
    sondaPara: (alvo: string) => Sonda
): Promise<{ mtu: number; alvo: string } | null> {
    for (const alvo of alvos) {
        const mtu = await medirMtuDoCaminho(sondaPara(alvo));
        if (mtu !== null) return { mtu, alvo };
    }
    return null;
}

/**
 * O MTU que o perfil declara, a partir do MTU medido do caminho.
 *
 * `aninhado` e o caso do WSL2 atras do WireSock: o tunel de dentro paga a sobrecarga do de fora
 * tambem. Custou uma noite inteira em 11/09, atribuida a MSS e a WSLg antes de ser o que era.
 */
export function mtuDoTunel(mtuDoCaminho: number, aninhado = false): number {
    return mtuDoCaminho - SOBRECARGA_WIREGUARD * (aninhado ? 2 : 1);
}

// ---------------------------------------------------------------------------------------------
// A sonda de verdade
// ---------------------------------------------------------------------------------------------

/** Monta o ping que nao fragmenta. Quem executa vive no nativo; montar e decidir vive aqui. */
export function comandoPing(host: string, carga: number, plataforma: string) {
    exigir("host", host);
    if (!Number.isInteger(carga) || carga < 0) throw new Error("perfil: carga invalida");

    return plataforma === "win32"
        ? { exe: "ping", args: ["-n", "1", "-w", "2000", "-f", "-l", String(carga), host] }
        : { exe: "ping", args: ["-c", "1", "-W", "2", "-M", "do", "-s", String(carga), host] };
}

/**
 * Le a saida do ping.
 *
 * Procura o sucesso, nunca a falha. As mensagens de erro sao traduzidas -- em portugues o
 * Windows diz "Pacote necessita ser fragmentado" -- e casar com texto localizado daria
 * "fragmentou" para toda maquina em ingles. `TTL=` aparece em toda resposta que chegou, em
 * qualquer idioma e nos dois sistemas.
 */
export function respostaChegou(saida: string): boolean {
    return /ttl\s*=\s*\d+/i.test(saida ?? "");
}
