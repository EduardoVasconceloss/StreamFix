#!/usr/bin/env bash
#
# Instrumento de medicao para macOS. NAO instala nada do StreamFix e nao mexe no seu Discord.
#
# Ele existe porque duas perguntas do porte para macOS nao tem resposta em documentacao nenhuma,
# e o runner de CI do projeto nao alcanca nenhuma das duas:
#
#   1. **Para onde vai o UDP da midia do Discord.** O projeto ja mediu, em 11/09/2026, que ele
#      NAO esta em 162.159.128.0/17 (a faixa da Cloudflare onde moram o gateway, a API, a CDN e
#      a sinalizacao de voz). Nunca mediu para onde ele vai. Sem esse numero, o tunel do macOS
#      tem de mandar a maquina inteira durante os segundos do Go Live; com ele, da para mandar
#      so o Discord, e provavelmente melhorar o lado Windows junto.
#   2. **Se uma regra restrita de sudoers de fato recusa o resto.** No runner do GitHub o
#      usuario ja tem `NOPASSWD: ALL`, entao la tudo passa e a medicao nao vale. Numa conta
#      comum, como a sua, vale.
#
# O que ele faz: le sockets abertos (`lsof`), captura 8 segundos de CABECALHOS da porta de voz
# do Discord (`tcpdump -q -s 64`, so para saber com qual servidor ela fala), consulta a quem
# pertence um bloco de IP (`whois`), e sobe um tunel WireGuard de brinquedo apontado para um
# endereco reservado para documentacao, que nao existe de verdade.
#
# Sobre a captura, porque ela merece ser dita com todas as letras: ela e filtrada na porta da
# voz, entao nenhum outro trafego seu entra; `-s 64` corta no cabecalho, entao a carga nem chega
# a ser lida; e `-q` imprime so "quem falou com quem e quanto", nunca conteudo. O audio, de
# qualquer forma, e cifrado. Ela existe porque o socket de voz do Discord NAO e conectado
# (medido em 20/09), e sem isso nao ha como saber para onde a midia vai.
#
# Ele nao toca no seu Discord e nao instala nada do StreamFix.
#
# Uso:
#   chmod +x medir-no-mac.sh
#   ./medir-no-mac.sh
#
# A saida vai para a tela e para um arquivo em ~/streamfix-medicao-<data>.txt.
# LEIA o arquivo antes de mandar para alguem: ele contem o SEU IP publico. A parte 1 marca onde
# ele aparece, para voce apagar se quiser -- os IPs que interessam sao os do Discord, nao o seu.

set -uo pipefail

SAIDA="$HOME/streamfix-medicao-$(date +%Y%m%d-%H%M).txt"

if [ -t 1 ]; then
    C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
    C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
    C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_BOLD=""; C_OFF=""
fi

titulo() { printf '\n%s== %s ==%s\n' "$C_CYAN$C_BOLD" "$1" "$C_OFF"; }
passo()  { printf '  %s[*] %s%s\n' "$C_DIM" "$1" "$C_OFF"; }
ok()     { printf '  %s[OK] %s%s\n' "$C_GREEN" "$1" "$C_OFF"; }
aviso()  { printf '  %s[!] %s%s\n' "$C_YELLOW" "$1" "$C_OFF"; }
ruim()   { printf '  %s[X] %s%s\n' "$C_RED" "$1" "$C_OFF"; }

# Tudo que este script imprime vai junto para o arquivo, para a pessoa nao precisar copiar
# terminal a mao. `tee -a` em vez de `>`: cada secao acrescenta.
exec > >(tee -a "$SAIDA") 2>&1

printf '\n  %sMedicao do StreamFix para macOS%s\n' "$C_CYAN$C_BOLD" "$C_OFF"
printf '  %sNao instala nada. Nao mexe no seu Discord.%s\n' "$C_DIM" "$C_OFF"
printf '  %sSaida: %s%s\n' "$C_DIM" "$SAIDA" "$C_OFF"

if [ "$(uname -s)" != "Darwin" ]; then
    ruim "Este script e para macOS. Aqui o uname diz $(uname -s)."
    exit 1
fi

titulo "a maquina"
sw_vers
uname -m

# ---------------------------------------------------------------------------------------------
# Parte 1: para onde vai o UDP da midia
# ---------------------------------------------------------------------------------------------
#
# A conexao de voz do Discord abre um socket UDP *conectado* (ele chama connect() no socket),
# entao o `lsof` mostra os dois lados, local e remoto. E por isso que da para descobrir o
# destino sem capturar pacote nenhum: a informacao esta na tabela de sockets, nao no trafego.
#
# A midia so existe enquanto ha call no ar. Fora de call o Discord mantem so o websocket do
# gateway, que e TCP e nao e o que estamos procurando.

titulo "parte 1: para onde a midia do Discord sai"

cat <<'INSTRUCOES'

  Para esta parte eu preciso que voce esteja NUMA CALL DE VOZ do Discord, agora.

  Nao precisa transmitir nem ligar a camera: a conexao de voz ja usa o mesmo caminho de
  midia que o Go Live usa, e e o IP dela que o Discord confere.

  Entre numa call (qualquer uma, ate sozinho num servidor seu serve) e volte aqui.

INSTRUCOES

read -r -p "  Esta numa call? [s/N] " resposta
if [[ ! "$resposta" =~ ^[sSyY] ]]; then
    aviso "Pulando a parte 1. Rode de novo quando estiver numa call -- e a medicao mais valiosa das duas."
else
    passo "lendo os sockets UDP do Discord (vai pedir a sua senha: o lsof precisa dela para ver processo de outro dono)"

    # **`-a` nao e opcional**, e a primeira execucao desta medicao (20/09) provou. No lsof,
    # varios filtros de selecao sao combinados com OU, nao com E: sem ele, `-iUDP -c Discord`
    # pede "todo socket UDP da maquina OU qualquer coisa do Discord", e a saida vem com o
    # launchd, o airportd, o mDNSResponder e cada arquivo aberto do Discord -- inclusive as
    # conexoes TCP dele. A extracao seguinte entao pegaria o IP do GATEWAY, que e TCP, e o
    # reportaria como destino de midia: resultado errado com cara de certo, que e o pior que
    # esta medicao podia produzir.
    #
    # -c Discord casa por prefixo do nome do processo, o que pega tambem os processos
    # auxiliares do Electron ("Discord Helper"), que sao justamente onde a midia vive.
    # -nP: nao resolve nome nem porta, porque queremos o numero cru.
    UDP="$(sudo lsof -nP -a -iUDP -c Discord 2>/dev/null)"

    if [ -z "$UDP" ]; then
        ruim "Nenhum socket UDP do Discord. Voce esta mesmo numa call? O Discord esta aberto?"
    else
        echo "$UDP"
        printf '\n'

        # **O socket de voz do Discord NAO e conectado.** Medido em 20/09, num Mac de verdade:
        # o lsof mostra `UDP *:49965`, sem `->`, o que significa que o Discord usa sendto/recvfrom
        # com o endereco explicito em cada pacote em vez de `connect()`. A premissa original desta
        # medicao -- "o lsof mostra os dois lados" -- estava errada, e nenhuma quantidade de
        # insistencia no lsof teria consertado isso.
        #
        # O que o lsof DA e a porta local. E com ela da para fazer a captura mais estreita
        # possivel: so os pacotes daquela porta, so os cabecalhos, por alguns segundos.
        passo 'portas UDP locais do Discord'
        PORTAS="$(printf '%s\n' "$UDP"             | grep ' UDP '             | grep -oE '[:.]([0-9]{2,5})$'             | tr -d ':.'             | sort -u)"

        if [ -z "$PORTAS" ]; then
            aviso 'Nao consegui achar a porta do socket de voz. A call pode estar so comecando -- espere uns segundos e rode de novo.'
        else
            printf '  %s\n' "$PORTAS"

            # O filtro so deixa passar a porta da voz. Nao e economia de disco: e o limite do que
            # esta medicao tem o direito de olhar na maquina de outra pessoa.
            FILTRO=""
            for porta in $PORTAS; do
                [ -n "$FILTRO" ] && FILTRO="$FILTRO or "
                FILTRO="${FILTRO}port $porta"
            done
            FILTRO="udp and ($FILTRO)"

            # A interface tem de ser escolhida: o tcpdump do macOS nao aceita `-i any`, ao
            # contrario do Linux. Sem isto a captura falha em silencio e a medicao volta vazia
            # sem dizer por que.
            IFACE="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
            [ -n "$IFACE" ] || IFACE="en0"

            passo "capturando ate 8 segundos de cabecalhos na $IFACE -- so a voz"
            printf '  %sfiltro: %s%s\n' "$C_DIM" "$FILTRO" "$C_OFF"

            # `-q` imprime so o resumo (origem, destino, tamanho) e NUNCA o conteudo do
            # pacote. `-s 64` corta no cabecalho, entao a carga nem chega a ser lida -- e ela
            # e audio cifrado de qualquer forma. `-c 200` normalmente encerra sozinho em menos
            # de um segundo numa call ativa; os 8 segundos sao so o teto.
            CAP="$(mktemp)"
            sudo tcpdump -n -q -s 64 -c 200 -i "$IFACE" "$FILTRO" > "$CAP" 2>/dev/null &
            TCPD=$!
            sleep 8
            # `sudo kill`, e nao `kill`: o tcpdump roda como root depois do exec, e uma conta
            # comum nao consegue sinalizar um processo de root. Com `kill` puro o sinal era
            # recusado, o tcpdump seguia vivo e o `wait` abaixo penduraria o script para sempre.
            sudo kill "$TCPD" 2>/dev/null
            wait "$TCPD" 2>/dev/null
            CAPTURA="$(cat "$CAP")"
            rm -f "$CAP"

            printf '%s\n' "$CAPTURA" | head -12

            # Os destinos sao o lado direito do `>`. Endereco privado sai fora: nao e servidor
            # do Discord, e o roteador de casa ou a propria maquina.
            DESTINOS="$(printf '%s\n' "$CAPTURA" \
                | grep -oE '> [0-9]{1,3}([.][0-9]{1,3}){3}[.]' \
                | sed 's/^> //; s/[.]$//' \
                | grep -vE '^(10[.]|127[.]|169[.]254[.]|192[.]168[.]|172[.](1[6-9]|2[0-9]|3[01])[.])' \
                | sort -u)"

            if [ -z "$DESTINOS" ]; then
                aviso 'A captura nao pegou nenhum destino publico. Voce estava mesmo numa call COM alguem, ou falando? Uma call vazia e silenciosa pode nao gerar trafego.'
            else
                titulo 'os destinos da midia'
                printf '  %s\n' "$DESTINOS"

                # Este e o numero que o projeto inteiro esta procurando. O `whois` de um IP
                # devolve o bloco alocado (NetRange/CIDR) e a organizacao dona -- e o bloco e
                # exatamente o que entraria numa linha de AllowedIPs.
                titulo 'a quem pertence cada destino (e qual o bloco dele)'
                for ip in $DESTINOS; do
                    printf '\n  %s--- %s ---%s\n' "$C_BOLD" "$ip" "$C_OFF"
                    whois "$ip" 2>/dev/null \
                        | grep -iE '^(netrange|cidr|netname|orgname|org-name|organization|descr|country|inetnum)' \
                        | head -12
                done
            fi
        fi
    fi

    # O IP publico proprio nao e o alvo da medicao, mas sem ele nao da para saber se algum dos
    # destinos acima e so a outra ponta de um NAT, nem para conferir depois se o tunel mudou o
    # que o Discord ve. Fica marcado para quem quiser apagar antes de compartilhar.
    titulo 'o SEU IP publico  <<< dado pessoal: apague esta secao se for compartilhar'
    curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo '(nao consegui consultar)'
    printf '\n'
    printf '  %s^^^ fim do dado pessoal%s\n' "$C_DIM" "$C_OFF"
fi

# ---------------------------------------------------------------------------------------------
# Parte 2: o contrato do wg-quick numa conta comum
# ---------------------------------------------------------------------------------------------

titulo "parte 2: o wg-quick nesta maquina"

if ! command -v brew >/dev/null 2>&1; then
    aviso 'Sem Homebrew. Pulando a parte 2 -- ela precisa do wireguard-tools, e o brew e como o instalador do StreamFix vai instala-lo.'
    aviso 'Se quiser fazer esta parte, instale o Homebrew (https://brew.sh) e rode de novo.'
else
    if ! command -v wg-quick >/dev/null 2>&1; then
        passo 'instalando o wireguard-tools (e so o utilitario de linha de comando; nao sobe nada sozinho)'
        brew install wireguard-tools
    fi

    if ! command -v wg-quick >/dev/null 2>&1; then
        ruim 'O brew terminou e o wg-quick nao apareceu. Pare por aqui.'
    else
        WG_QUICK="$(command -v wg-quick)"

        # **O wg-quick exige bash 4+, e o macOS traz o 3.2.** Medido em 20/09, num Mac de
        # verdade: `sudo wg-quick up` respondeu "Version mismatch: bash 3 detected, when bash 4+
        # required" e nao subiu nada.
        #
        # Por que o CI nao pegou: o runner do GitHub ja tem o bash do Homebrew no PATH, entao la
        # o `#!/usr/bin/env bash` do wg-quick encontrava um bash 5. Num Mac comum, sob `sudo`, o
        # PATH e higienizado e o `env bash` acha o /bin/bash 3.2 da Apple. E um modo de falha que
        # SO aparece na combinacao "Mac de verdade + sudo", que e exatamente a combinacao em que
        # o StreamFix vai rodar.
        #
        # A saida e chamar o interpretador explicitamente, em vez de confiar no PATH do sudo.
        BASH4=""
        for candidato in "$(brew --prefix 2>/dev/null)/bin/bash" /opt/homebrew/bin/bash /usr/local/bin/bash; do
            [ -x "$candidato" ] || continue
            if [ "$("$candidato" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null)" -ge 4 ] 2>/dev/null; then
                BASH4="$candidato"
                break
            fi
        done

        if [ -z "$BASH4" ]; then
            aviso 'Nenhum bash 4+ nesta maquina. O wg-quick nao roda sem um.'
            passo 'instalando o bash pelo Homebrew (nao mexe no /bin/bash da Apple)'
            brew install bash >/dev/null 2>&1
            for candidato in "$(brew --prefix 2>/dev/null)/bin/bash" /opt/homebrew/bin/bash /usr/local/bin/bash; do
                [ -x "$candidato" ] && BASH4="$candidato" && break
            done
        fi

        if [ -n "$BASH4" ]; then
            ok "bash 4+ em $BASH4 ($("$BASH4" -c 'echo $BASH_VERSION'))"
        else
            ruim 'Sem bash 4+, o wg-quick nao vai subir tunel nenhum. O resto da parte 2 vai falhar.'
        fi

        # Daqui para baixo, TODA chamada ao wg-quick passa pelo interpretador explicito.
        wgq() { sudo "$BASH4" "$WG_QUICK" "$@"; }
        ok "wg-quick em $WG_QUICK"
        wg --version

        # Os caminhos que ele varre atras do `.conf` decidem onde o instalador vai escrever o
        # perfil. O script e bash, entao a lista esta nele -- ler e melhor do que supor.
        passo 'onde ele procura perfil'
        grep -nE 'CONFIG_SEARCH_PATHS|WG_CONFIG|/etc/wireguard' "$WG_QUICK" | head -10

        # Um perfil de brinquedo, apontado para 192.0.2.1: TEST-NET-1 (RFC 5737), reservado
        # para documentacao. Nao existe ninguem do outro lado, de proposito -- assim a medicao
        # do "handshake que nao fecha" e sempre igual, em vez de depender de um servidor estar
        # no ar. E ele leva so 192.0.2.0/24, entao nao desvia trafego nenhum seu.
        # 11 caracteres, e isso importa: o wg-quick so aceita nome de ate 15 (medido em 17/09,
        # ver wg-quick-no-darwin-2026-09-17.md). "streamfix-medicao" teria 17 e cairia na
        # mesma armadilha que a medicao acabou de descobrir.
        PERFIL="sfx-medicao"
        passo "criando o perfil de brinquedo $PERFIL (endereco reservado; nao desvia nada seu)"
        sudo mkdir -p /etc/wireguard
        printf '[Interface]\nPrivateKey = %s\nAddress = 10.99.99.2/32\nMTU = 1380\n\n[Peer]\nPublicKey = %s\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 192.0.2.0/24\nPersistentKeepalive = 25\n' \
            "$(wg genkey)" "$(wg genkey | wg pubkey)" \
            | sudo tee "/etc/wireguard/$PERFIL.conf" >/dev/null
        sudo chmod 600 "/etc/wireguard/$PERFIL.conf"

        titulo 'o contrato do CLI'
        # Tudo aqui vai com sudo por causa do que a medicao no runner mostrou em 17/09: o
        # socket de controle e `srwx------ root daemon` e o arquivo .name e `-r-------- root`,
        # entao ATE LER ESTADO precisa de privilegio. Sem sudo, toda pergunta responde
        # "Unable to access interface: Permission denied", que e facil de confundir com
        # "o tunel nao esta de pe".
        echo '--- wg show de um perfil que NAO esta de pe ---'
        sudo wg show "$PERFIL"; echo "exit=$?"

        echo '--- wg-quick up ---'
        wgq up "$PERFIL"; echo "exit=$?"

        # Ja sabemos do runner que isto NAO resolve: `wg` nao consulta o .name, entao o nome do
        # perfil nao serve como argumento no Darwin. Fica aqui para confirmar numa instalacao de
        # verdade (o runner e uma VM; um Mac com outra versao do wireguard-tools pode diferir).
        echo '--- wg show PELO NOME DO PERFIL: confirma que nao resolve? ---'
        sudo wg show "$PERFIL"; echo "exit=$?"
        echo '--- o mapeamento nome -> utunN (precisa de sudo para ler) ---'
        sudo ls -la /var/run/wireguard/ 2>&1
        UTUN="$(sudo cat "/var/run/wireguard/$PERFIL.name" 2>/dev/null)"
        echo "$PERFIL -> ${UTUN:-(nao consegui ler)}"
        echo '--- interfaces ---'
        sudo wg show interfaces

        if [ -n "$UTUN" ]; then
            # O analogo do `AllowedApps` do WireSock: conferir o que o tunel REALMENTE aplicou,
            # em vez de supor que aplicou o que o arquivo pedia. E a licao mais cara do projeto.
            echo "--- allowed-ips aplicados, perguntando pelo $UTUN ---"
            sudo wg show "$UTUN" allowed-ips; echo "exit=$?"

            # Com endpoint reservado isto tem de ser 0. E a prova de que `up` dar certo NAO
            # significa tunel de pe -- a diferenca estrutural entre wg-quick e o CLI do
            # WireSock. O runner nao conseguiu chegar aqui (era tudo sem sudo).
            echo '--- handshake (endpoint reservado: tem de ser 0) ---'
            sudo wg show "$UTUN" latest-handshakes
            sudo wg show "$UTUN" transfer
        fi

        echo '--- wg-quick down ---'
        wgq down "$PERFIL"; echo "exit=$?"
        echo '--- wg-quick down DE NOVO (ja esta fora) ---'
        wgq down "$PERFIL"; echo "exit=$?"

        # ---------------------------------------------------------------------------------
        # A regra do sudoers: a medicao que so uma conta comum faz
        # ---------------------------------------------------------------------------------
        #
        # O plugin troca de perfil no clique do Go Live. Pedir senha ali e inaceitavel, entao o
        # instalador escreve uma regra que libera, sem senha, EXATAMENTE quatro comandos. O que
        # importa medir nao e que os quatro passam -- e que o resto NAO passa.
        titulo 'a regra restrita de sudoers recusa o resto?'

        USUARIO="$(whoami)"
        # `wg show` entra na regra por necessidade, nao por conveniencia: a medicao de 17/09
        # mostrou que ler estado tambem exige root. Sem isso o plugin nao consegue responder
        # "o tunel esta de pe?", que e a pergunta do porteiro a cada clique de Go Live. Em
        # compensacao `wg` e leitura pura, muito mais barato em risco do que `wg-quick`.
        WG_BIN="$(command -v wg)"
        sudo tee /etc/sudoers.d/streamfix-medicao >/dev/null <<EOF
$USUARIO ALL=(root) NOPASSWD: $BASH4 $WG_QUICK up $PERFIL, $BASH4 $WG_QUICK down $PERFIL, $WG_BIN show *
EOF
        sudo chmod 440 /etc/sudoers.d/streamfix-medicao

        echo '--- o visudo aceita a sintaxe? ---'
        sudo visudo -c -f /etc/sudoers.d/streamfix-medicao; echo "exit=$?"

        echo '--- o que esta liberado sem senha ---'
        sudo -n -l 2>&1 | tail -15

        # Tambem depois do -k: com cache valido, "passou sem senha" nao prova que a regra existe.
        sudo -k
        echo '--- o AUTORIZADO tem de passar sem senha ---'
        sudo -n "$BASH4" "$WG_QUICK" up "$PERFIL"; echo "exit=$?"
        sudo -n "$BASH4" "$WG_QUICK" down "$PERFIL"; echo "exit=$?"

        # **`sudo -k` antes, ou a medicao mente.** Em 20/09 este teste deu "autorizado" para um
        # comando que a regra nao lista -- nao porque a regra falhou, e sim porque o `sudo` ainda
        # tinha o cache da senha digitada minutos antes, e com o cache valido o `-n` passa em
        # qualquer coisa que a conta possa fazer. Numa conta de administrador do macOS, que ja
        # tem `(ALL) ALL`, isso e tudo.
        #
        # O `-k` invalida o cache, e so entao a pergunta "esta regra recusa o resto?" tem
        # sentido. Depois dele, o que passar sem senha passou POR CAUSA da regra.
        sudo -k
        echo '--- o NAO autorizado tem de ser RECUSADO (esta e a medicao que o CI nao faz) ---'
        echo "outro perfil:"; sudo -n "$BASH4" "$WG_QUICK" up outro-qualquer 2>&1 | head -3; echo "exit=${PIPESTATUS[0]}"
        echo "outro comando:"; sudo -n /bin/ls /var/root 2>&1 | head -3; echo "exit=${PIPESTATUS[0]}"

        # Nao deixar rastro: nem a concessao de privilegio, nem o perfil de brinquedo.
        titulo 'limpando'
        sudo rm -f /etc/sudoers.d/streamfix-medicao
        sudo rm -f "/etc/wireguard/$PERFIL.conf"
        wgq down "$PERFIL" >/dev/null 2>&1
        ok 'regra de sudoers removida, perfil de brinquedo apagado, nenhuma interface de pe'
        wg show interfaces
    fi
fi

titulo 'pronto'
printf '  A medicao esta em %s%s%s\n' "$C_BOLD" "$SAIDA" "$C_OFF"
printf '  %sConfira a secao marcada como dado pessoal antes de compartilhar.%s\n\n' "$C_YELLOW" "$C_OFF"
