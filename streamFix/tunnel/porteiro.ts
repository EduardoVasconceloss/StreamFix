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
 * O id de quem transmite, tirado da chave do stream.
 *
 * A chave e `guild:<servidor>:<canal>:<usuario>` numa call de servidor e `call:<canal>:<usuario>`
 * numa de DM; quem transmite e sempre o ultimo pedaco. O `includes(meuId)` de antes aceitava
 * uma transmissao alheia num servidor ou canal cujo id contivesse o nosso.
 */
export function donoDoStream(streamKey: string | null | undefined): string | null {
    if (typeof streamKey !== "string") return null;
    const partes = streamKey.split(":");
    const dono = partes.length >= 3 ? partes[partes.length - 1] : "";
    return /^\d+$/.test(dono) ? dono : null;
}

/**
 * Decide.
 *
 * **A leitura do Discord vale como negativa, nao como positiva.** Se ela diz que a midia sai
 * por outro lugar, esta bloqueado mesmo que o CLI jure que o tunel esta de pe -- uma observacao
 * de endereco errado e confiavel. Mas ela concordar com a saida NAO basta, porque o
 * `localAddress` envelhece.
 *
 * Medido em 11/09, derrubando o tunel com uma call no ar: o ping do Discord caiu de 131 ms para
 * 33 ms -- a midia passou a sair direto, pelo Brasil -- e o `localAddress` continuou reportando
 * o endereco da saida pelos 6 segundos inteiros da medicao. Ele e escolhido quando a conexao
 * nasce e nao e refeito quando o caminho muda por baixo.
 *
 * Uma versao que confiasse so nele liberaria exatamente o caso que este porteiro existe para
 * pegar: entrar na call com o tunel de pe, o tunel cair, e clicar em Go Live em seguida.
 *
 * Por isso os dois precisam concordar para liberar, e qualquer discordancia bloqueia.
 */
export function decidir(s: Situacao): Veredito {
    if (!s.exigirTunel) {
        return { ok: true, nota: "porteiro desligado nas configuracoes" };
    }

    const saida = s.saidaEsperada;
    const local = typeof s.localAddress === "string" && s.localAddress.length > 0
        ? s.localAddress
        : null;

    if (saida !== null && local !== null && local !== saida) {
        // A negativa confiavel: o Discord viu a midia saindo de outro lugar.
        return {
            ok: false,
            motivo: `A midia esta saindo por ${local}, e nao pela saida ${saida}.`
                + " O Discord vai negar a entrega. Suba o tunel e tente de novo."
        };
    }

    if (saida !== null && local === saida && s.tunel === "conectado") {
        // Os dois concordam. E a unica combinacao que libera com certeza.
        return { ok: true, nota: null };
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
                // Vale mesmo quando o `localAddress` diz o endereco da saida: ele envelhece, e
                // com o tunel fora a leitura antiga e justamente a que engana.
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

// ---------------------------------------------------------------------------------------------
// O tunel em dois niveis (spec de 2026-09-11, 4.4)
// ---------------------------------------------------------------------------------------------

/** O que o clique do Go Live sabe depois de pedir o completo e esperar a troca. */
export interface Clique {
    exigirTunel: boolean;
    /** O tunel em dois niveis vale agora. Fora dele, e a regra de `decidir` que manda. */
    doisNiveis: boolean;
    /** O resultado da troca: se deu certo, e se o que ficou no ar e o completo. */
    troca: { ok: boolean; completo: boolean; motivo: string | null; };
    /** O `localAddress` da voz. So conta no completo sempre. */
    localAddress: string | null;
    saidaEsperada: string | null;
}

/**
 * Decide o clique do Go Live.
 *
 * **Em dois niveis, a voz nao diz nada sobre o Go Live.** A regra de `decidir` usa o
 * `localAddress` da voz como negativa, e isso so fazia sentido com o tunel levando tudo o tempo
 * todo: voz e stream saiam pelo mesmo caminho. Agora a voz anda no controle a maior parte do
 * tempo, a transmissao anda na conexao de stream, que e outra e ainda vai nascer, e quem cuida da
 * voz e a unidade `voz`. O que decide e a troca para o completo ter dado certo; o que confere e
 * `conferirNascimento`, logo depois.
 *
 * No completo sempre, a regra de antes continua valendo inteira.
 */
export function decidirClique(c: Clique): Veredito {
    if (!c.exigirTunel) return { ok: true, nota: "porteiro desligado nas configuracoes" };

    if (!c.troca.ok || !c.troca.completo) {
        return {
            ok: false,
            motivo: `O StreamFix nao conseguiu por o tunel no ar: ${c.troca.motivo ?? "motivo desconhecido"}.`
                + " Sem ele o Discord nega a transmissao para quem esta no Brasil."
        };
    }

    if (c.doisNiveis) return { ok: true, nota: null };

    // A troca so e feita pelo `controle`, que confere o `status`: "conectado" e o que ela provou.
    return decidir({
        tunel: "conectado",
        localAddress: c.localAddress,
        saidaEsperada: c.saidaEsperada,
        exigirTunel: true
    });
}

export const AVISO_STREAM_FORA =
    "StreamFix: sua transmissao nasceu fora do tunel, e quem assiste vai ver tela preta."
    + " Pare e comece de novo.";

/**
 * Confere por onde a transmissao nasceu, lendo o `localAddress` da conexao de stream no
 * `RTC_CONNECTED`.
 *
 * Nesse instante ele e exato: e o IP que o servidor de midia viu no nascimento, e e ali que o
 * Discord decide (pesquisa, 12g). O envelhecimento que obriga `decidir` a desconfiar dele so
 * acontece depois. Nascida fora, a transmissao esta condenada, e trocar o tunel agora nao
 * adianta (fato 6): so recria-la resolve.
 *
 * `null` quando nao ha o que dizer, inclusive quando nao deu para ler. Sem leitura, avisar seria
 * chute, e alarme falso ensina a ignorar o aviso.
 */
export function conferirNascimento(localAddress: string | null | undefined, saidaEsperada: string | null): string | null {
    if (saidaEsperada === null) return null;
    if (typeof localAddress !== "string" || localAddress.length === 0) return null;
    return localAddress === saidaEsperada ? null : AVISO_STREAM_FORA;
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
