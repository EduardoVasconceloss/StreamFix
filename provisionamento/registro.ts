// O nucleo do provisionador: quem pode entrar na saida, e com que endereco.
//
// Funcao pura de estado. Nada aqui abre socket, escreve arquivo ou chama `wg` -- isso e do
// `servidor.mjs`, que e fino de proposito. O que mora aqui e o que da para errar em silencio:
// aceitar um convite que nao valia, dar o mesmo endereco a duas pessoas, esgotar a faixa sem
// perceber.
//
// **Atomicidade.** `registrar` e sincrona e nao espera nada no meio. Num processo Node isso
// basta para que dois registros simultaneos nunca recebam o mesmo endereco: o segundo so roda
// depois do primeiro ter devolvido o estado novo. O servidor **tem** que respeitar isso --
// aplicar o estado antes de aceitar a proxima requisicao, nunca `await` entre ler e gravar. Ha
// teste para a sequencia; o `await` no meio e responsabilidade de quem integra.
//
// Sem imports, para o Node carregar direto nos testes.

/** 32 bytes em base64. Repetido de chaves.ts de proposito: o servidor nao carrega `node:crypto`. */
const FORMATO_CHAVE = /^[A-Za-z0-9+/]{43}=$/;

export interface Peer {
    publica: string;
    /** Endereco interno, sem mascara. */
    endereco: string;
    /** Qual convite trouxe esta pessoa. Guardado para auditoria, nao para autorizacao. */
    convite: string;
    criadoEm: string;
}

export interface Convite {
    codigo: string;
    /** Quantas pessoas este convite pode trazer. */
    usos: number;
    usados: number;
    /**
     * Revogar impede novas entradas e **nao mexe em quem ja entrou** -- tirar uma pessoa e
     * remover o peer dela, que e outra operacao.
     */
    revogado?: boolean;
}

export interface Saida {
    chavePublica: string;
    /** `host:porta`. */
    endpoint: string;
}

export interface Estado {
    /** Faixa interna, ex. `10.8.0.0/24`. */
    faixa: string;
    /** O endereco do proprio servidor dentro da faixa. Nunca entregue a ninguem. */
    enderecoServidor: string;
    saida: Saida;
    convites: Convite[];
    peers: Peer[];
}

export interface Resposta {
    endereco: string;
    chavePublicaDoServidor: string;
    endpoint: string;
    faixa: string;
}

export type CodigoErro =
    | "chave_invalida"
    | "convite_invalido"
    | "convite_esgotado"
    | "convite_revogado"
    | "faixa_cheia";

export type ResultadoRegistro =
    | { ok: true; resposta: Resposta; estado: Estado; peerNovo: Peer | null }
    | { ok: false; codigo: CodigoErro; erro: string };

// ---------------------------------------------------------------------------------------------
// Enderecos
// ---------------------------------------------------------------------------------------------

export function paraNumero(ip: string): number | null {
    const partes = (ip ?? "").split(".");
    if (partes.length !== 4) return null;
    let n = 0;
    for (const p of partes) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const v = Number(p);
        if (v > 255) return null;
        n = n * 256 + v;
    }
    return n;
}

export function paraIp(n: number): string {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/**
 * Os enderecos atribuiveis de uma faixa.
 *
 * Rede e broadcast ficam de fora. Numa `/32` ou `/31` nao sobra nada, e a resposta e uma lista
 * vazia em vez de um endereco invalido.
 */
export function enderecosDaFaixa(faixa: string): number[] {
    const [base, prefixoTexto] = (faixa ?? "").split("/");
    const inicio = paraNumero(base);
    const prefixo = Number(prefixoTexto);
    if (inicio === null || !Number.isInteger(prefixo) || prefixo < 0 || prefixo > 32) return [];
    if (prefixo >= 31) return [];

    const tamanho = 2 ** (32 - prefixo);
    const rede = inicio - (inicio % tamanho);
    const fora: number[] = [];
    for (let i = 1; i < tamanho - 1; i++) fora.push(rede + i);
    return fora;
}

/** O primeiro endereco livre, ou `null` se a faixa acabou. */
export function proximoEndereco(estado: Estado): string | null {
    const ocupados = new Set<number>();
    const servidor = paraNumero(estado.enderecoServidor);
    if (servidor !== null) ocupados.add(servidor);
    for (const p of estado.peers) {
        const n = paraNumero(p.endereco);
        if (n !== null) ocupados.add(n);
    }
    for (const n of enderecosDaFaixa(estado.faixa)) {
        if (!ocupados.has(n)) return paraIp(n);
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------------------------

function resposta(estado: Estado, endereco: string): Resposta {
    return {
        endereco,
        chavePublicaDoServidor: estado.saida.chavePublica,
        endpoint: estado.saida.endpoint,
        faixa: estado.faixa
    };
}

/**
 * Registra uma pessoa na saida.
 *
 * Devolve um estado novo; nao altera o que recebeu. Quem integra grava o estado **antes** de
 * atender a proxima requisicao.
 *
 * **Repetir o registro da mesma chave nao gasta endereco nem uso de convite.** Reinstalar e
 * comum, e a alternativa seria a faixa encolher a cada reinstalacao de alguem. A pessoa recebe
 * de volta o endereco que ja era dela, e `peerNovo` vem `null` para o servidor saber que nao
 * precisa mexer na interface.
 */
export function registrar(
    estado: Estado,
    pedido: { convite?: unknown; chavePublica?: unknown },
    agora: string
): ResultadoRegistro {
    const chave = pedido?.chavePublica;
    if (typeof chave !== "string" || !FORMATO_CHAVE.test(chave)) {
        return { ok: false, codigo: "chave_invalida", erro: "chave publica fora do formato WireGuard" };
    }

    const jaTem = estado.peers.find(p => p.publica === chave);
    if (jaTem) {
        return { ok: true, resposta: resposta(estado, jaTem.endereco), estado, peerNovo: null };
    }

    const codigo = pedido?.convite;
    // Comparacao direta: o risco real de um convite e ser adivinhado ou repassado, nao medido
    // por tempo -- por isso eles sao longos e aleatorios. Ver `servidor.mjs` para o limite de
    // tentativas, que e a defesa que importa.
    const convite = typeof codigo === "string"
        ? estado.convites.find(c => c.codigo === codigo)
        : undefined;
    if (!convite) {
        return { ok: false, codigo: "convite_invalido", erro: "convite nao existe" };
    }
    if (convite.revogado) {
        return { ok: false, codigo: "convite_revogado", erro: "convite revogado" };
    }
    if (convite.usados >= convite.usos) {
        return { ok: false, codigo: "convite_esgotado", erro: "convite ja foi usado o maximo de vezes" };
    }

    const endereco = proximoEndereco(estado);
    if (endereco === null) {
        return { ok: false, codigo: "faixa_cheia", erro: `a faixa ${estado.faixa} nao tem endereco livre` };
    }

    const peerNovo: Peer = { publica: chave, endereco, convite: convite.codigo, criadoEm: agora };
    const novo: Estado = {
        ...estado,
        convites: estado.convites.map(c =>
            c.codigo === convite.codigo ? { ...c, usados: c.usados + 1 } : c),
        peers: [...estado.peers, peerNovo]
    };
    return { ok: true, resposta: resposta(novo, endereco), estado: novo, peerNovo };
}

/**
 * Remove uma pessoa. Devolve `null` quando nao havia peer com essa chave -- o chamador decide se
 * isso e erro; para um comando de revogacao, nao e.
 */
export function remover(estado: Estado, chavePublica: string): Estado | null {
    if (!estado.peers.some(p => p.publica === chavePublica)) return null;
    return { ...estado, peers: estado.peers.filter(p => p.publica !== chavePublica) };
}

/**
 * O bloco `[Peer]` de uma pessoa, para o `wg0.conf` do servidor.
 *
 * `AllowedIPs` e `/32`: cada pessoa alcanca a saida, e nenhuma alcanca as outras.
 */
export function blocoDoPeer(peer: Peer): string {
    return [
        "[Peer]",
        `# ${peer.convite} em ${peer.criadoEm}`,
        `PublicKey = ${peer.publica}`,
        `AllowedIPs = ${peer.endereco}/32`,
        ""
    ].join("\n");
}
