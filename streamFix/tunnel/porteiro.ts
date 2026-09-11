// O porteiro do Go Live: decide se vale a pena deixar a transmissao subir.
//
// D7 em codigo. Sem tunel, a transmissao vai ser negada pelo Discord de qualquer jeito -- o que
// muda e onde a pessoa descobre isso. Aqui ela descobre no clique, com o motivo escrito;
// sem isto, ela descobre pelo amigo dizendo "ta preta".
//
// **Quem manda e o Discord, nao o WireSock.** A leitura que decide e o `localAddress` que o
// proprio motor de midia reporta, porque ela vem de dentro da conexao que importa. O CLI dizer
// "conectado" enquanto a midia sai pelo Brasil e um estado possivel, e e exatamente o tipo de
// mentira que este projeto ja comeu. Foi assim que 12d provou que a midia saia de Santiago.
//
// **O `localAddress` e o endereco PUBLICO da saida, nao o interno do tunel.** Medido em 11/09:
// com o tunel de pe ele vale `159.112.151.37`, o IP da VPS -- nao `10.8.0.2`. Uma versao
// ingenua desta unidade procuraria a faixa interna e recusaria toda transmissao boa.
//
// Sem imports, para o Node carregar direto nos testes.

export type EstadoTunel = "conectado" | "fora" | "desconhecido";

export interface Situacao {
    /** O que o WireSock diz. Informacao de apoio, nunca a palavra final. */
    tunel: EstadoTunel;
    /** O que o Discord reporta em `getStats().transport`. `null` = ainda nao ha o que medir. */
    localAddress: string | null;
    /** O host da saida configurada, sem porta. `null` quando nao ha saida configurada. */
    saidaEsperada: string | null;
    /** O porteiro pode ser desligado por quem sabe o que esta fazendo. */
    exigirTunel: boolean;
}

export type Veredito =
    | { ok: true; nota: string | null }
    | { ok: false; motivo: string };

/** `159.112.151.37:39743` -> `159.112.151.37`. Aceita ja vir sem porta. */
export function hostDoEndpoint(endpoint: string | null | undefined): string | null {
    if (typeof endpoint !== "string" || endpoint.length === 0) return null;
    const host = endpoint.includes(":") ? endpoint.slice(0, endpoint.lastIndexOf(":")) : endpoint;
    return host.length > 0 ? host : null;
}

/**
 * Decide.
 *
 * A ordem das perguntas e o desenho todo: **a leitura do Discord vem primeiro**. Se ela diz que
 * a midia sai pela saida, esta liberado mesmo que o CLI discorde; se ela diz que sai por outro
 * lugar, esta bloqueado mesmo que o CLI jure que o tunel esta de pe.
 *
 * O CLI so decide quando o Discord nao tem o que dizer -- o que acontece nos segundos em que a
 * conexao de voz ainda esta subindo.
 */
export function decidir(s: Situacao): Veredito {
    if (!s.exigirTunel) {
        return { ok: true, nota: "porteiro desligado nas configuracoes" };
    }

    const saida = s.saidaEsperada;
    const local = typeof s.localAddress === "string" && s.localAddress.length > 0
        ? s.localAddress
        : null;

    if (saida !== null && local !== null) {
        if (local === saida) return { ok: true, nota: null };
        return {
            ok: false,
            motivo: `A midia esta saindo por ${local}, e nao pela saida ${saida}.`
                + " O Discord vai negar a entrega. Suba o tunel e tente de novo."
        };
    }

    // Daqui para baixo o Discord nao tem o que dizer, e o CLI e o que sobra.
    switch (s.tunel) {
        case "conectado":
            return {
                ok: true,
                // Nao e alarme: acontece nos segundos iniciais da conexao de voz. Vale registrar
                // porque, se aparecer sempre, o `localAddress` mudou de lugar no bundle.
                nota: local === null
                    ? "o tunel esta de pe, mas o Discord ainda nao reportou por onde a midia sai"
                    : "nao ha saida configurada para conferir o endereco"
            };
        case "fora":
            return {
                ok: false,
                motivo: "O tunel do StreamFix nao esta de pe."
                    + " Sem ele o Discord nega a transmissao para quem esta no Brasil."
            };
        default:
            return {
                ok: false,
                motivo: "Nao consegui falar com o WireSock para saber se o tunel esta de pe."
                    + " Confira se o StreamFix foi instalado por completo."
            };
    }
}

/**
 * O aviso do monitor, enquanto a transmissao esta no ar.
 *
 * So avisa -- D4. A causa muda a frase inteira porque muda o que adianta fazer: `entrega` e o
 * gate negando, e recriar a transmissao resolve; `captura` e problema local, e recriar nao
 * adianta nada. Dizer a frase errada manda a pessoa para o lado oposto do conserto.
 */
export function aviso(veredito: { estado: string; causa?: string; motivo?: string }): string | null {
    if (veredito?.estado !== "quebrado") return null;
    if (veredito.causa === "captura") {
        return "O StreamFix parou de capturar a tela. O problema e local:"
            + " recriar a transmissao nao vai resolver.";
    }
    return "A entrega da sua transmissao morreu -- quem assiste esta vendo tela preta."
        + " Pare e comece de novo para recriar a sessao.";
}
