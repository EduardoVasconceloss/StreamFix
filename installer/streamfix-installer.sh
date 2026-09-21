#!/usr/bin/env bash
#
# StreamFix - instalador automatico
#
# Encontra sozinho o Equicord ou o Vencord que voce tem, instala o plugin, compila e injeta.
# Se voce nao tiver nenhum dos dois, pergunta qual quer e instala junto.
#
# Uso:
#   ./streamfix-installer.sh
#   ./streamfix-installer.sh --source ~/Equicord
#   ./streamfix-installer.sh --mod vencord --yes
#   ./streamfix-installer.sh --uninstall
#
# Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
# GoLiveBypass e abriu o caminho para este aqui.

set -euo pipefail

# Resolvida a ultima release estavel (nao "main"): evita execucao remota de codigo via um push
# nao revisado, sem precisar editar isto a cada release -- resolve_repo_raw() consulta a API do
# GitHub e resolve uma vez por execucao, memoizando o resultado.
REPO_RAW=""
# As fases 1 a 6 quebraram o plugin em modulos. Copiar so os dois de cima deixaria um plugin que
# nem compila -- os imports de ./tunnel/ nao resolveriam. Espelha $PluginFiles do
# StreamFix-Installer.ps1, e um teste de drift compara as duas listas.
PLUGIN_FILES=(
    "streamFix/index.tsx"
    "streamFix/native.ts"
    "streamFix/tunnel/coletor.ts"
    "streamFix/tunnel/controle.ts"
    "streamFix/tunnel/controle-wg.ts"
    "streamFix/tunnel/emprestimos.ts"
    "streamFix/tunnel/entrada.ts"
    "streamFix/tunnel/monitor.ts"
    "streamFix/tunnel/observador.ts"
    "streamFix/tunnel/perfil.ts"
    "streamFix/tunnel/porteiro.ts"
    "streamFix/tunnel/trava.ts"
    "streamFix/tunnel/voz.ts"
)
PLUGIN_DIR_NAME="streamFix"
LEGACY_PLUGIN_DIR_NAME="goLiveBypass"
EQUICORD_GIT="https://github.com/Equicord/Equicord"
VENCORD_GIT="https://github.com/Vendicated/Vencord"
FLATPAK_IDS=("com.discordapp.Discord" "com.discordapp.DiscordPTB" "com.discordapp.DiscordCanary")

# Os quatro canais que o Equilotl reconhece no macOS (find_discord_darwin.go, macosNames),
# cada um como bundle solto em /Applications ou ~/Applications -- sem bootstrap, sem flatpak.
MACOS_BUNDLE_NAMES=("Discord.app" "Discord PTB.app" "Discord Canary.app" "Discord Development.app")

# Vazio em producao. Os testes exportam isto antes de carregar o script e prefixam as raizes
# absolutas que a descoberta varre (/usr/..., /opt/..., /var/lib/flatpak/..., /Applications),
# para rodar contra uma arvore de fixtures sem tocar no sistema de arquivos de verdade. As
# raizes que ja sao relativas a $HOME nao precisam disto: o teste aponta o proprio HOME para a
# fixture.
FS_PREFIX="${FS_PREFIX:-}"

# Mesmo esquema do FS_PREFIX: em producao vem do uname -s de verdade, e os testes exportam
# "Linux" ou "Darwin" antes de carregar o script para exercitar os dois ramos de descoberta em
# qualquer runner, sem depender de em qual sistema operacional o CI de fato roda.
OS_NAME="${OS_NAME:-$(uname -s)}"

# Mesma ideia para a arquitetura: em producao vem do uname -m de verdade, ja mapeado pro
# sufixo de asset do Equilotl (arm64 ou x64; uname -m devolve x86_64 no Intel, nao x64), e os
# testes exportam o sufixo direto, sem depender da CPU de quem roda o teste. Uma CPU nao
# mapeada (nem arm64 nem x86_64) deixa MACOS_ARCH vazio, e macos_cli_arch() falha nela.
case "$(uname -m 2>/dev/null)" in
    arm64)   MACOS_ARCH="${MACOS_ARCH:-arm64}" ;;
    x86_64)  MACOS_ARCH="${MACOS_ARCH:-x64}" ;;
    *)       MACOS_ARCH="${MACOS_ARCH:-}" ;;
esac

# URL de release do instalador do Equicord/Vencord (Equilotl), a mesma que o wrapper de
# injecao (Equicord/scripts/runInstaller.mjs, BASE_URL) ja usa hoje para baixar o build GUI no
# macOS. So o nome do asset muda: aqui pegamos o EquilotlCli-darwin-<arch>, que le linha de
# comando, em vez do Equilotl-darwin-<arch>.zip, que so abre janela.
MACOS_EQUILOTL_BASE_URL="https://github.com/Equicord/Equilotl/releases/latest/download"

MODE="menu"
MOD=""
SOURCE=""
ASSUME_YES=0

# A saida padrao do projeto, a mesma do StreamFix-Installer.ps1 -- os dois descrevem a MESMA
# maquina, e um teste de drift compara os dois valores.
#
# A chave publica nao e enfeite: o registro vai por HTTP puro, e e ela que impede alguem no meio
# do caminho de devolver a PROPRIA saida e levar a midia junto.
EXIT_URL="${EXIT_URL:-http://159.112.151.37:8787/registrar}"
EXIT_KEY="${EXIT_KEY:-fbv+rSWSp36QfVdcNvPHdtEFzeOvCrzB1cyNBfGSvWY=}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ -t 1 ]; then
    C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
    C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
    C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_BOLD=""; C_OFF=""
fi

# Sempre em stderr: estas funcoes sao chamadas de dentro de $(...) e qualquer coisa que
# fosse para stdout seria capturada como se fosse o valor de retorno.
step() { printf '  %s[*] %s%s\n' "$C_DIM" "$1" "$C_OFF" >&2; }
ok()   { printf '  %s[OK] %s%s\n' "$C_GREEN" "$1" "$C_OFF" >&2; }
warn() { printf '  %s[!] %s%s\n' "$C_YELLOW" "$1" "$C_OFF" >&2; }
fail() { printf '\n  %s[X] %s%s\n\n' "$C_RED" "$1" "$C_OFF" >&2; exit 1; }

banner() {
    printf '\n  %sStreamFix%s\n' "$C_CYAN$C_BOLD" "$C_OFF"
    printf '  %sGo Live e camera de volta no Discord%s\n' "$C_DIM" "$C_OFF"
    printf '  %shttps://github.com/EduardoVasconceloss/StreamFix (fork de bezumiya/GoLiveBypass)%s\n\n' "$C_DIM" "$C_OFF"
}

confirm() {
    [ "$ASSUME_YES" -eq 1 ] && return 0
    local answer
    read -r -p "  $1 [s/N] " answer
    [[ "$answer" =~ ^[sSyY] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

# O instalador inteiro precisa rodar como a pessoa dona do checkout. Ele ja eleva sozinho, e
# somente nas operacoes que realmente exigem privilegio (por exemplo, injetar num flatpak de
# sistema). Se o script inteiro nasce sob sudo, HOME vira /root e um checkout novo pode acabar
# em /root/Equicord ou /root/Vencord; depois o Discord flatpak, executado como usuario normal,
# nao consegue carregar esse caminho e abre com "Cannot find module".
ensure_not_root() {
    [ "$(id -u)" -ne 0 ] && return 0

    local usuario="${SUDO_USER:-}"
    if [ -n "$usuario" ] && [ "$usuario" != "root" ]; then
        fail "Nao rode o instalador inteiro com sudo. Rode o mesmo comando sem sudo como $usuario. Quando precisar escrever no Discord/flatpak de sistema, o proprio instalador pede sudo."
    fi

    fail "Nao rode este instalador como root. Execute como seu usuario normal. Quando precisar escrever no Discord/flatpak de sistema, o proprio instalador pede sudo."
}

lower() { tr '[:upper:]' '[:lower:]' <<<"${1:-}"; }
upper() { tr '[:lower:]' '[:upper:]' <<<"${1:-}"; }

# GNU stat usa -c%s; o BSD/macOS usa -f%z. Sem nenhum dos dois (raro), cai pro wc -c, que e
# POSIX mas le o arquivo inteiro em vez de so consultar o inode.
file_size() {
    stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || wc -c <"$1" 2>/dev/null || echo 0
}

# O id do flatpak a que um caminho pertence, ou nada se o caminho nao for de flatpak. Serve
# para os dois lugares onde o Discord de flatpak aparece: o deploy em .../flatpak/app/<id>/ e
# o HOME do sandbox em ~/.var/app/<id>/.
flatpak_app_id() {
    local parte
    while IFS= read -r parte; do
        case "$parte" in com.discordapp.*) printf '%s\n' "$parte"; return 0 ;; esac
    done < <(printf '%s\n' "${1:-}" | tr '/' '\n')
    return 1
}

# Instalacao do usuario nao precisa de raiz para nada; a do sistema precisa para tudo. O
# `flatpak override` obedece essa mesma divisao, e passar --user na do sistema falha.
flatpak_is_user_install() {
    have flatpak && flatpak info --user "$1" >/dev/null 2>&1
}

# A liberacao ja existente aparece no --show-permissions, que nao precisa de raiz. Conferir
# antes evita pedir a senha do sudo toda vez que o instalador roda de novo.
flatpak_has_access() {
    local entrada
    # Entrada por entrada, e comparando o texto inteiro: depois de um --nofilesystem a pasta
    # continua aparecendo na lista, so que como !pasta. Procurar o pedaco solto acharia essa
    # negacao e concluiria que o acesso existe, justamente quando ele nao existe mais.
    while IFS= read -r entrada; do
        case "$entrada" in
            "$2"|"$2:rw"|"$2:ro"|"$2:create") return 0 ;;
        esac
    done < <(flatpak info --show-permissions "$1" 2>/dev/null | sed -n 's/^filesystems=//p' | tr ';' '\n')
    return 1
}

# O flatpak so enxerga o proprio sandbox. Sem liberar a pasta de build do mod, o Discord abre
# reclamando de modulo nao encontrado: o index.js injetado faz require de um caminho que de
# dentro do sandbox nao existe. O instalador do mod ja faz isso sozinho, mas nao no caminho em
# que a injecao ja estava pronta e nos so reiniciamos o Discord.
grant_flatpak_access() {
    local id="$1" dir="$2"
    have flatpak || return 0
    flatpak_has_access "$id" "$dir" && return 0

    if flatpak_is_user_install "$id"; then
        flatpak override --user "$id" --filesystem="$dir" >/dev/null 2>&1 && return 0
    else
        step "Liberando $dir para o $id (pode pedir sua senha do sudo)"
        sudo flatpak override "$id" --filesystem="$dir" >/dev/null 2>&1 && return 0
    fi

    warn "Nao consegui liberar $dir para o $id. Se o Discord abrir com erro de modulo, rode:"
    printf '  %s  flatpak override %s--filesystem=%s %s%s\n' \
        "$C_DIM" "$(flatpak_is_user_install "$id" && printf -- '--user ')" "$dir" "$id" "$C_OFF" >&2
    return 1
}

# So testar se o comando existe nao prova nada: o Corepack cria o atalho antes de saber a
# versao, e as chaves embutidas no Node 22 estao velhas ("Cannot find matching keyid").
have_pnpm() {
    have pnpm || return 1
    local version
    version="$(pnpm --version 2>/dev/null)" || return 1
    step "pnpm encontrado: $version"
}

usage() {
    sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --install) MODE="install" ;;
        --uninstall) MODE="uninstall" ;;
        --restore) MODE="restore" ;;
        --mod) MOD="${2:-}"; shift ;;
        --source) SOURCE="${2:-}"; shift ;;
        --exit-url) EXIT_URL="${2:-}"; shift ;;
        --exit-key) EXIT_KEY="${2:-}"; shift ;;
        --yes|-y) ASSUME_YES=1 ;;
        --help|-h) usage ;;
        *) fail "Opcao desconhecida: $1" ;;
    esac
    shift
done

# ----------------------------------------------------------------------------- descoberta

is_checkout() {
    [ -n "${1:-}" ] || return 1
    [ -f "$1/package.json" ] || return 1
    [ -f "$1/src/utils/types.ts" ] || return 1

    # O build roda "git rev-parse" pra gravar o hash na versao compilada; uma pasta sem clone
    # git de verdade (ZIP baixado, clone interrompido) so quebraria mais tarde, sem contexto.
    [ -d "$1/.git" ]
}

# O bundle inteiro fica em /Applications ou ~/Applications, sem bootstrap e sem flatpak: o
# Squirrel.Mac troca o .app inteiro a cada atualizacao, entao o app.asar de verdade esta sempre
# dentro do proprio bundle, em Contents/Resources. Mesma coisa que o Equilotl faz em
# find_discord_darwin.go para achar o Discord no macOS.
macos_discord_resources() {
    local base nome sub
    for base in "$FS_PREFIX/Applications" "$HOME/Applications"; do
        [ -d "$base" ] || continue
        for nome in "${MACOS_BUNDLE_NAMES[@]}"; do
            sub="$base/$nome/Contents/Resources"
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
            fi
        done
    done
    return 0
}

# Procura o app.asar de verdade em vez de confiar numa lista de caminhos.
#
# Desde a versao 1.0.136, de maio de 2026, o pacote de Linux do Discord (tar.gz, .deb, o
# oficial do Arch e o RPM) traz SO um bootstrap: o app de verdade, com o app.asar, e baixado na
# primeira execucao para dentro do HOME. Quem so olha /usr/share e /opt nao acha Discord nenhum
# numa instalacao atual.
discord_resources() {
    local raiz sub base id

    if [ "$OS_NAME" = "Darwin" ]; then
        macos_discord_resources
        return 0
    fi

    base="${XDG_CONFIG_HOME:-$HOME/.config}"
    for sub in \
        "$base"/discord/app-*/resources \
        "$base"/discordptb/app-*/resources \
        "$base"/discordcanary/app-*/resources
    do
        if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
            printf '%s\n' "$sub"
        fi
    done

    # Pacotes que ainda embutem o app: discord_arch_electron e os AUR de PTB e Canary.
    for raiz in \
        "$FS_PREFIX/usr/share/discord" "$FS_PREFIX/usr/share/discord-ptb" "$FS_PREFIX/usr/share/discord-canary" \
        "$FS_PREFIX/usr/lib/discord" "$FS_PREFIX/usr/lib/discord-ptb" "$FS_PREFIX/usr/lib/discord-canary" "$FS_PREFIX/usr/lib64/discord" \
        "$FS_PREFIX/opt/discord" "$FS_PREFIX/opt/Discord" "$FS_PREFIX/opt/discord-ptb" "$FS_PREFIX/opt/discord-canary" \
        "$FS_PREFIX/usr/local/share/discord" \
        "$HOME/.local/share/discord" "$HOME/Discord" "$HOME/discord" \
        "$HOME/.local/share/DiscordPTB" "$HOME/.local/share/DiscordCanary"
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
                break
            fi
        done
    done

    # Flatpak. O app fica no deploy do ostree, que e do root, mas e um diretorio comum num
    # sistema de arquivos comum: a injecao troca o nome do app.asar e cria uma pasta ao lado,
    # sem reescrever nenhum arquivo, entao os objetos do repositorio ficam intactos. E o que o
    # instalador do Equicord e o do Vencord ja fazem ha tempos. O preco e que um
    # `flatpak update` refaz o deploy e leva a injecao junto.
    for raiz in "$FS_PREFIX/var/lib/flatpak/app" "${XDG_DATA_HOME:-$HOME/.local/share}/flatpak/app"; do
        [ -d "$raiz" ] || continue
        for id in "${FLATPAK_IDS[@]}"; do
            for sub in "$raiz/$id"/current/active/files/*/resources; do
                if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                    printf '%s\n' "$sub"
                fi
            done
        done
    done

    # E o bootstrap de que fala o comentario aqui em cima, so que dentro do flatpak: o HOME do
    # Discord vira ~/.var/app/<id>, e o app baixado cai la. Este e do proprio usuario, sem sudo.
    for id in "${FLATPAK_IDS[@]}"; do
        for sub in "$HOME/.var/app/$id"/config/discord*/app-*/resources; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
            fi
        done
    done

    return 0
}

# O que passar em --location para o instalador do mod. Ele quer a pasta de cima, e no flatpak
# quer o diretorio do app inteiro: e de la que ele descobre que aquilo e um flatpak e libera o
# sandbox. Apontar direto para .../current/active/files/discord faz a liberacao nao acontecer,
# e o Discord abre com erro de modulo. No macOS o Equilotl tambem quer o bundle inteiro
# (find_discord_darwin.go espera o .app, nao o Contents por cima do Resources), do mesmo jeito
# que quer o app inteiro no flatpak.
install_location() {
    local resources="$1"
    case "$resources" in
        */Contents/Resources) dirname "$(dirname "$resources")" ;;
        */current/active/*) printf '%s\n' "${resources%%/current/active/*}" ;;
        */app-*/resources)  dirname "$(dirname "$resources")" ;;
        */resources)        dirname "$resources" ;;
        *)                  printf '%s\n' "$resources" ;;
    esac
}

# O stub que o Equicord/Vencord deixa no lugar do app.asar so faz require da pasta de build --
# aponta direto pro checkout, forma mais confiavel de acha-lo.
injected_path() {
    local resources="$1" file text
    for file in "$resources/app/index.js" "$resources/app.asar"; do
        [ -f "$file" ] || continue
        [ "$(file_size "$file")" -lt 65536 ] || continue
        text="$(tr -d '\0' < "$file" 2>/dev/null || true)"
        if [[ "$text" =~ require\(\"([^\"]+)\"\) ]]; then
            printf '%s\n' "${BASH_REMATCH[1]}"
            return 0
        fi
    done
    return 1
}

installed_mod() {
    local resources path
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        case "$(lower "$path")" in
            *equibop*) echo "Equibop"; return 0 ;;
            *equicord*) echo "Equicord"; return 0 ;;
            *vesktop*) echo "Vesktop"; return 0 ;;
            *vencord*) echo "Vencord"; return 0 ;;
        esac
    done < <(discord_resources)
    return 1
}

checkout_from_injection() {
    local resources path root
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        root="$(dirname "$(dirname "$path")")"   # <checkout>/dist/desktop -> <checkout>
        if is_checkout "$root"; then printf '%s\n' "$root"; return 0; fi
    done < <(discord_resources)
    return 1
}

checkout_on_disk() {
    local root name candidate
    for root in "$HOME" "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads" \
                "$HOME/dev" "$HOME/git" "$HOME/repos" "$HOME/projects" "$HOME/src" \
                "$HOME/.local/share"
    do
        [ -d "$root" ] || continue
        for name in Equicord equicord Vencord vencord; do
            candidate="$root/$name"
            if is_checkout "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
        done
    done

    step "Procurando um pouco mais fundo em $HOME"
    while IFS= read -r candidate; do
        if is_checkout "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
    done < <(find "$HOME" -maxdepth 4 -type d \( -iname Equicord -o -iname Vencord \) 2>/dev/null | head -n 20)

    return 1
}

find_checkout() {
    local root
    if [ -n "$SOURCE" ]; then
        is_checkout "$SOURCE" || fail "Nao encontrei um checkout do Equicord ou Vencord em $SOURCE"
        printf '%s\n' "$SOURCE"; return 0
    fi

    if root="$(checkout_from_injection)"; then
        ok "Achei pelo Discord: $root"
        printf '%s\n' "$root"; return 0
    fi

    if root="$(checkout_on_disk)"; then
        ok "Achei no disco: $root"
        printf '%s\n' "$root"; return 0
    fi

    return 1
}

# O resources cujo app.asar aponta para este checkout, seja ele qual for. Base das tres
# perguntas que o resto do script faz: se a injecao pegou, se ela caiu num flatpak, e em qual.
injected_resources() {
    local root="${1:-}" resources path
    [ -n "$root" ] || return 1
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        case "$path" in "$root"/*) printf '%s\n' "$resources"; return 0 ;; esac
    done < <(discord_resources)
    return 1
}

injected_from_checkout() {
    injected_resources "${1:-}" >/dev/null
}

# O id do flatpak cuja injecao aponta para este checkout, se for o caso. Decide onde ficam as
# configuracoes do mod e como reabrir o Discord.
injected_flatpak_id() {
    local resources
    resources="$(injected_resources "${1:-}")" || return 1
    flatpak_app_id "$resources"
}

# ----------------------------------------------------------------------------- instalacao

choose_mod() {
    if [ -n "$MOD" ]; then
        case "$(lower "$MOD")" in
            equicord) echo "Equicord"; return 0 ;;
            vencord) echo "Vencord"; return 0 ;;
            *) fail "--mod aceita equicord ou vencord" ;;
        esac
    fi

    local installed
    installed="$(installed_mod || true)"

    printf '\n' >&2
    if [ -n "$installed" ]; then
        warn "Voce tem o $installed instalado, mas nao achei o codigo fonte dele." >&2
        printf '  %sPlugins de usuario so existem compilando do fonte, entao preciso baixar o repositorio.%s\n' "$C_DIM" "$C_OFF" >&2
    else
        warn "Nao encontrei Equicord nem Vencord no seu computador." >&2
        printf '  %sPosso baixar e instalar um dos dois junto com o plugin.%s\n' "$C_DIM" "$C_OFF" >&2
    fi

    printf '\n  %sQual voce quer instalar?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Equicord%s    recomendado, inclui tudo do Vencord e mais plugins\n' "$C_GREEN" "$C_OFF" >&2
    printf '    %s[2] Vencord%s     o original, mais enxuto\n' "$C_CYAN" "$C_OFF" >&2
    printf '    [0] Cancelar\n\n' >&2

    local choice
    read -r -p "  Escolha: " choice
    case "$choice" in
        1) echo "Equicord" ;;
        2) echo "Vencord" ;;
        *) fail "Cancelado." ;;
    esac
}

# xcode-select -p so confere se o caminho das ferramentas de linha de comando existe -- nunca
# invoca o git de verdade, entao nunca corre o risco de abrir o dialogo grafico de instalacao.
# E por isso que ensure_toolchain usa esta funcao, e nao "have git", para decidir se o git do
# macOS esta pronto (ver macos_missing_tools).
macos_has_command_line_tools() {
    xcode-select -p >/dev/null 2>&1
}

# So o git resolvido pelo stub do sistema (/usr/bin/git) corre o risco do dialogo grafico das
# ferramentas de linha de comando do Xcode -- e so quando essas ferramentas ainda nao estao
# instaladas. Um git resolvido em outro caminho (o do Homebrew, por exemplo, apos um "brew
# install git") e um binario de verdade, seguro de usar mesmo sem as CLT. "command -v" so
# resolve o PATH e nunca executa o binario, entao confere isso sem correr risco nenhum.
macos_git_ready() {
    macos_has_command_line_tools && return 0
    local path
    path="$(command -v git 2>/dev/null)" || return 1
    [ "$path" != "/usr/bin/git" ]
}

# "command -v git" no macOS nao prova nada por si so: o sistema sempre tem o stub em
# /usr/bin/git, e a primeira chamada a ele sem as ferramentas de linha de comando do Xcode
# instaladas abre um dialogo grafico de instalacao -- que numa execucao sem ninguem de olho na
# janela certa so fica pendurado. macos_git_ready() e quem sabe se o git vai funcionar, sem
# correr esse risco.
macos_missing_tools() {
    macos_git_ready || printf 'git\n'
    have node || printf 'node\n'
    return 0
}

# A mesma falta de git/Node do Linux, so que resolvida diferente: la existem varios
# gerenciadores de pacote, com nomes de pacote diferentes, e so instruir e a opcao razoavel. No
# macOS existe um so gerenciador de fato (Homebrew), com um comando previsivel -- por isso aqui
# o instalador vai alem de instruir e oferece instalar de verdade, atras da mesma confirmacao
# que as outras operacoes invasivas do instalador ja usam. Instalar coisas no sistema de
# alguem e a operacao mais invasiva que o instalador faz fora a injecao no Discord.
macos_ensure_git_and_node() {
    local missing=()
    local tool
    while IFS= read -r tool; do
        [ -n "$tool" ] && missing+=("$tool")
    done < <(macos_missing_tools)

    [ ${#missing[@]} -eq 0 ] && return 0

    warn "Faltando: ${missing[*]}"

    # Instalar o proprio Homebrew e bem mais invasivo que instalar dois pacotes por ele, e essa
    # decisao e da pessoa: aqui so mostramos a linha oficial e paramos, sem rodar nada.
    if ! have brew; then
        printf '\n  %sInstalar isso precisa do Homebrew, que voce nao tem. Instale primeiro com:%s\n' "$C_DIM" "$C_OFF" >&2
        printf '  %s  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"%s\n' "$C_DIM" "$C_OFF" >&2
        printf '\n  %sDepois rode este instalador de novo.%s\n' "$C_DIM" "$C_OFF" >&2
        fail "Sem Homebrew nao consigo instalar o que falta."
    fi

    printf '\n  %sVou instalar com o Homebrew:%s\n' "$C_BOLD" "$C_OFF" >&2
    printf '  %s  brew install %s%s\n\n' "$C_DIM" "${missing[*]}" "$C_OFF" >&2
    confirm "Pode instalar?" || fail "Instale na mao com: brew install ${missing[*]}"

    step "brew install ${missing[*]}"
    brew install "${missing[@]}" >&2 || fail "brew install falhou. Rode na mao: brew install ${missing[*]}"

    # brew install git resolve por conta propria, sem precisar das CLT (macos_git_ready aceita
    # o git do Homebrew direto). So falha aqui quando o git que sobrou de fato e o stub do
    # sistema sem as ferramentas de linha de comando por tras -- exatamente o caso que travaria
    # pendurado numa janela que ninguem viu, entao falhamos claro em vez disso.
    macos_git_ready \
        || fail "Ainda sem as ferramentas de linha de comando do Xcode. A primeira chamada ao git abre um dialogo grafico de instalacao -- procure essa janela (pode estar atras de outra) ou rode 'xcode-select --install' na mao."

    have node || fail "Instalei mas o Node ainda nao aparece no PATH. Abra um terminal novo e rode de novo."

    printf '  %sO Node precisa ser 22 ou mais novo. O que o Homebrew instala e sempre atual.%s\n' "$C_DIM" "$C_OFF" >&2
}

ensure_toolchain() {
    if [ "$OS_NAME" = "Darwin" ]; then
        macos_ensure_git_and_node
    else
        local missing=()

        # git e sempre necessario, mesmo quando ja existe um checkout: o build roda "git
        # rev-parse" pra gravar o hash na versao compilada, entao um checkout ja existente sem
        # git instalado quebrava mais tarde no "pnpm build", sem contexto nenhum.
        have git || missing+=("git")
        have node || missing+=("node")

        if [ ${#missing[@]} -gt 0 ]; then
            warn "Faltando: ${missing[*]}"

            local pkgs=()
            local tool
            for tool in "${missing[@]}"; do
                if [ "$tool" = "node" ]; then pkgs+=("nodejs"); else pkgs+=("$tool"); fi
            done

            printf '  %sInstale com o gerenciador da sua distro, por exemplo:%s\n' "$C_DIM" "$C_OFF" >&2
            printf '  %s  sudo apt install %s%s\n' "$C_DIM" "${pkgs[*]}" "$C_OFF" >&2
            printf '  %s  sudo pacman -S %s%s\n' "$C_DIM" "${pkgs[*]}" "$C_OFF" >&2
            printf '  %s  sudo dnf install %s%s\n' "$C_DIM" "${pkgs[*]}" "$C_OFF" >&2
            printf '\n  %sO Node precisa ser 22 ou mais novo. O pacote da distro costuma ser mais%s\n' "$C_DIM" "$C_OFF" >&2
            printf '  %santigo que isso; nesse caso use nvm, fnm ou o repositorio do NodeSource.%s\n' "$C_DIM" "$C_OFF" >&2
            fail "Instale o que falta e rode de novo."
        fi
    fi

    if have_pnpm; then return; fi

    # O npm instala o pnpm direto, sem a conferencia de assinatura que derruba o Corepack.
    step "Instalando o pnpm pelo npm"
    npm install -g pnpm >/dev/null 2>&1 || sudo npm install -g pnpm >/dev/null 2>&1 || true

    have_pnpm || fail 'Nao consegui deixar o pnpm funcionando. Rode: sudo npm install -g pnpm'
}

install_mod() {
    local choice="$1" git_url target
    case "$choice" in
        Equicord) git_url="$EQUICORD_GIT" ;;
        Vencord)  git_url="$VENCORD_GIT" ;;
        *) fail "Mod desconhecido: $choice" ;;
    esac
    target="$HOME/$choice"

    printf '\n  %sVou fazer:%s\n' "$C_BOLD" "$C_OFF" >&2
    printf '  %s  1. Baixar o %s em %s%s\n' "$C_DIM" "$choice" "$target" "$C_OFF" >&2
    printf '  %s  2. Instalar as dependencias%s\n' "$C_DIM" "$C_OFF" >&2
    printf '  %s  3. Compilar junto com o StreamFix%s\n' "$C_DIM" "$C_OFF" >&2
    printf '  %s  4. Injetar no Discord (o Discord vai fechar)%s\n\n' "$C_DIM" "$C_OFF" >&2
    confirm "Pode seguir?" || fail "Cancelado."

    ensure_toolchain

    if [ -d "$target" ]; then
        is_checkout "$target" || fail "$target ja existe e nao parece um checkout. Apague a pasta ou use --source."
        step "Ja existe um checkout em $target, reaproveitando" >&2
    else
        step "git clone $git_url" >&2
        git clone --depth 1 "$git_url" "$target" >&2 || fail "git clone falhou"
    fi

    printf '%s\n' "$target"
}

resolve_repo_raw() {
    [ -n "$REPO_RAW" ] && return 0

    local api="https://api.github.com/repos/EduardoVasconceloss/StreamFix/releases/latest"
    local tag=""
    if have curl; then
        tag="$(curl -fsSL -H 'User-Agent: StreamFix-Installer' "$api" 2>/dev/null | grep -o '"tag_name" *: *"[^"]*"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
    elif have wget; then
        tag="$(wget -qO- --header='User-Agent: StreamFix-Installer' "$api" 2>/dev/null | grep -o '"tag_name" *: *"[^"]*"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
    fi

    [ -n "$tag" ] || fail "Nao consegui descobrir a ultima release estavel do StreamFix pela API do GitHub. Verifique sua conexao e tente de novo."
    REPO_RAW="https://raw.githubusercontent.com/EduardoVasconceloss/StreamFix/$tag"
}

repo_file() {
    local relative="$1"
    local local_path="$SCRIPT_DIR/../$relative"
    if [ -f "$local_path" ]; then
        cat "$local_path"
        return 0
    fi

    resolve_repo_raw

    if have curl; then
        curl -fsSL "$REPO_RAW/$relative" || fail "Nao consegui baixar $relative. Verifique sua conexao."
    elif have wget; then
        wget -qO- "$REPO_RAW/$relative" || fail "Nao consegui baixar $relative. Verifique sua conexao."
    else
        fail "Preciso do curl ou do wget para baixar o plugin."
    fi
}

discord_running() {
    pgrep -x -i 'Discord|DiscordCanary|DiscordPTB' >/dev/null 2>&1 && return 0

    # Um `flatpak ps` so, e nao um por id: isto roda em laco de dois em dois segundos enquanto
    # o modo temporario espera o Discord fechar.
    if have flatpak; then
        local rodando
        rodando="$(flatpak ps --columns=application 2>/dev/null || true)"
        case "$rodando" in *com.discordapp.*) return 0 ;; esac
    fi
    return 1
}

stop_discord() {
    local bundle="${1:-}"
    if [ "$OS_NAME" = "Darwin" ] && [ -n "$bundle" ]; then
        macos_stop_discord "$bundle"
        return
    fi

    discord_running || return 0

    step "Fechando o Discord"
    pkill -x -i 'Discord|DiscordCanary|DiscordPTB' >/dev/null 2>&1 || true
    if have flatpak; then
        local id
        for id in "${FLATPAK_IDS[@]}"; do
            flatpak kill "$id" >/dev/null 2>&1 || true
        done
    fi

    local i
    for i in $(seq 1 30); do
        sleep 0.3
        discord_running || return 0
    done

    fail "O Discord nao fechou. Feche na mao e rode de novo."
}

copy_plugin() {
    local root="$1" target="$1/src/userplugins/$PLUGIN_DIR_NAME" file
    local legacy="$1/src/userplugins/$LEGACY_PLUGIN_DIR_NAME"

    # Evita pasta duplicada/orfa pra quem ja tinha o plugin instalado sob o nome antigo.
    if [ -d "$legacy" ] && [ ! -d "$target" ]; then
        step "Removendo a instalacao antiga do plugin em $legacy"
        rm -rf "$legacy"
    fi

    step "Instalando o plugin em $target"
    mkdir -p "$target"

    # versoes antigas usavam index.ts; deixar os dois quebra o build
    rm -f "$target/index.ts"

    # O caminho RELATIVO tem de ser preservado. Um `basename` aqui achataria
    # `streamFix/tunnel/coletor.ts` em `coletor.ts`, e os imports de `./tunnel/` nao
    # resolveriam -- o plugin nem compilaria. O mesmo cuidado esta no .ps1, com teste.
    for file in "${PLUGIN_FILES[@]}"; do
        local destino="$target/${file#streamFix/}"
        mkdir -p "$(dirname "$destino")"
        repo_file "$file" > "$destino"
    done
}

build_mod() {
    local root="$1"
    if [ ! -d "$root/node_modules" ]; then
        step "Instalando dependencias (na primeira vez demora alguns minutos)"
        (cd "$root" && pnpm install) || fail "pnpm install falhou"
    fi

    step "Compilando"
    (cd "$root" && pnpm build) || fail "pnpm build falhou"
}

# Sem "--" antes do --location, de proposito. O script "inject" do package.json do mod ja
# termina em "--", e o runInstaller.mjs repassa ao Equilotl tudo o que vem depois do PRIMEIRO
# "--". Escrever `pnpm inject -- --location X` monta `... -- --install -- --location X`, entao o
# Equilotl recebe um "--" solto -- e o parser de flags do Go para de ler opcoes ali e descarta o
# --location. Sem location ele abre o menu interativo de escolha do Discord, que numa instalacao
# automatica nao tem quem responda: chega EOF, ele aborta com "FATAL ^D", e o instalador cai no
# ramo do sudo achando que a injecao falhou.
run_inject() {
    local root="$1" loc="${2:-}"

    if [ -n "$loc" ] && (cd "$root" && pnpm inject --location "$loc"); then
        return 0
    fi

    (cd "$root" && pnpm inject)
}

# Em modo automatico nao existe ninguem para digitar a senha, e um sudo que precise dela fica
# pendurado sem prazo. O -n falha na hora em vez de perguntar, entao da para decidir antes de
# chamar. No modo interativo segue valendo deixar o sudo perguntar normalmente.
can_sudo() {
    sudo -n true 2>/dev/null && return 0
    [ "$ASSUME_YES" -eq 1 ] && return 1
    return 0
}

# O sudo limpa o ambiente, e sem PATH nem o pnpm nem o node sobrevivem. E o instalador do mod
# que o pnpm baixa vai parar em dist/ como root: sem devolver o dono, o proximo build sem sudo
# quebra com permissao negada numa pasta que era do usuario.
run_inject_root() {
    local root="$1" loc="${2:-}" rc=0
    local -a cmd
    if [ -n "$loc" ]; then
        cmd=(pnpm inject --location "$loc")
    else
        cmd=(pnpm inject)
    fi

    # Sem HOME de proposito: o instalador do mod ja descobre o HOME de verdade pelo SUDO_USER,
    # e mandar o do usuario so faria o pnpm encher ~/.cache de arquivo do root.
    sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" "${cmd[@]}" || rc=$?

    # Mesmo motivo do run_inject: se o --location nao chegou, tentar sem ele.
    if [ "$rc" -ne 0 ] && [ -n "$loc" ]; then
        rc=0
        sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" pnpm inject || rc=$?
    fi

    sudo chown -R "$(id -u):$(id -g)" "$root/dist" 2>/dev/null || true
    return "$rc"
}

# arm64 e x64 sao os dois sufixos de asset que o Equilotl publica (EquilotlCli-darwin-arm64 e
# EquilotlCli-darwin-x64, ver scripts/runInstaller.mjs do Equicord). O mapeamento de verdade
# ja aconteceu ao definir MACOS_ARCH; aqui so falha numa CPU que nao mapeamos.
macos_cli_arch() {
    [ -n "$MACOS_ARCH" ] || return 1
    printf '%s\n' "$MACOS_ARCH"
}

# Pasta de caches do usuario, nao a de suporte a aplicativos: o binario baixado nao e estado do
# StreamFix, e a pasta de caches e o lugar que o proprio macOS sabe que pode limpar.
macos_equilotl_cli_cache_path() {
    printf '%s\n' "$HOME/Library/Caches/StreamFix/EquilotlCli-darwin-$1"
}

# Baixa o build de linha de comando do Equilotl pela arquitetura da maquina e guarda em cache,
# reaproveitando se ja presente. Mesma URL de ultima release que o wrapper de injecao ja usa
# hoje, do mesmo publicador; sem checksum, porque o Equilotl nao emite um para nenhum binario
# dele.
ensure_equilotl_cli() {
    local arch cache
    arch="$(macos_cli_arch)" || return 1
    cache="$(macos_equilotl_cli_cache_path "$arch")"

    if [ -x "$cache" ]; then
        printf '%s\n' "$cache"
        return 0
    fi

    mkdir -p "$(dirname "$cache")" || return 1
    local url="$MACOS_EQUILOTL_BASE_URL/EquilotlCli-darwin-$arch"
    local tmp="$cache.tmp.$$"

    if have curl; then
        curl -fsSL -o "$tmp" "$url" || { rm -f "$tmp"; return 1; }
    elif have wget; then
        wget -qO "$tmp" "$url" || { rm -f "$tmp"; return 1; }
    else
        return 1
    fi

    chmod +x "$tmp" || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$cache" || { rm -f "$tmp"; return 1; }
    printf '%s\n' "$cache"
}

# Ponto de exec isolado do resto de macos_run_inject_cli/macos_run_uninject_cli para os testes
# poderem substituir por um espiao e conferir as variaveis de ambiente sem baixar nem rodar o
# binario de verdade. As tres variaveis chegam pelo ambiente herdado da chamada em
# macos_run_inject_cli/macos_run_uninject_cli (prefixo VAR=valor), nao redeclaradas aqui, para
# que um espiao que substitua esta funcao inteira ainda as veja. O flag e --install ou
# --uninstall (cli.go, uninstallFlag): a mesma operacao inversa do mesmo binario.
macos_exec_equilotl_cli() {
    local cli="$1" loc="$2" flag="${3:---install}"
    "$cli" "$flag" --location "$loc"
}

# As tres variaveis reproduzem o contrato que o wrapper de injecao (Equicord/scripts/
# runInstaller.mjs) usa para chamar o Equilotl: sem elas ele instalaria a release publicada do
# Equicord em vez do build deste checkout, e o plugin nao estaria la.
macos_run_inject_cli() {
    local root="$1" loc="${2:-}" cli
    [ -n "$loc" ] || return 1
    cli="$(ensure_equilotl_cli)" || return 1
    EQUICORD_USER_DATA_DIR="$root" \
    EQUICORD_DIRECTORY="$root/dist/desktop" \
    EQUICORD_DEV_INSTALL=1 \
    macos_exec_equilotl_cli "$cli" "$loc" --install
}

# Operacao inversa do mesmo binario: desfaz a injecao sem abrir janela, contanto que o mod seja
# o Equicord (macos_has_cli_installer). Mesmo contrato de variaveis do install: sem elas o
# Equilotl nao saberia que checkout desfazer.
macos_run_uninject_cli() {
    local root="$1" loc="${2:-}" cli
    [ -n "$loc" ] || return 1
    cli="$(ensure_equilotl_cli)" || return 1
    EQUICORD_USER_DATA_DIR="$root" \
    EQUICORD_DIRECTORY="$root/dist/desktop" \
    EQUICORD_DEV_INSTALL=1 \
    macos_exec_equilotl_cli "$cli" "$loc" --uninstall
}

# So o Equicord tem build de linha de comando para macOS; o Vencord so publica o zip GUI
# (VencordInstaller.MacOS.zip, sem CLI), entao para ele nem vale tentar (ADR 0001).
macos_has_cli_installer() {
    [ "$(checkout_mod "$1")" = "Equicord" ]
}

# O paralelo mais proximo da divisao usuario/sistema do Linux: instalar em /Applications
# normalmente e gravavel pelo usuario admin sem sudo, mas quando falha, elevar nao ajuda -- por
# isso a mensagem, e nao um pedido de privilegio.
macos_is_system_target() {
    case "$1" in
        "$FS_PREFIX/Applications"/*) return 0 ;;
        *) return 1 ;;
    esac
}

# De fora as duas causas parecem iguais (a escrita simplesmente falha) e tem solucoes
# diferentes: uma conta sem privilegio de administrador se resolve trocando de conta, e a
# permissao de Gerenciamento de Apps do macOS 15+ nao se resolve com sudo nenhum.
macos_permission_failure_message() {
    printf 'Nao consegui escrever em %s. Duas causas possiveis, que de fora parecem iguais: sua conta sem privilegio de administrador, ou a permissao de Gerenciamento de Apps do macOS 15+ (Ajustes do Sistema > Privacidade e Seguranca > Gerenciamento de Apps), que sudo nao resolve.\n' "$1"
}

# Guia o clique de quem esta do outro lado da janela do instalador do mod (hoje, sempre o
# Vencord Installer, ver macos_has_cli_installer). "acao" e "Install" ou "Uninstall", o nome do
# botao no proprio instalador. A janela abre por conta do instalador do mod, nao do StreamFix;
# esta funcao so avisa o que fazer nela antes de esperar.
macos_window_click_hint() {
    local root="$1" loc="${2:-}" acao="$3" alvo
    alvo="Discord"
    [ -n "$loc" ] && alvo="$(basename "$loc")"

    printf '\n' >&2
    warn "$(checkout_mod "$root") no macOS so injeta pela janela do instalador (ADR 0001: nao existe build de linha de comando dele para essa plataforma)."
    printf '  %sQuando a janela abrir: escolha %s na lista e clique em %s.%s\n' "$C_DIM" "$alvo" "$acao" "$C_OFF" >&2
    printf '  %sEste terminal espera e confere sozinho depois se pegou.%s\n\n' "$C_DIM" "$C_OFF" >&2
}

# No macOS a injecao nunca pede confirmacao pra elevar: o "sudo pendurado" do fluxo Linux nao
# faz sentido aqui, porque /Applications normalmente ja e gravavel sem sudo, e quando nao e,
# sudo tambem nao resolve a permissao de Gerenciamento de Apps do macOS 15+. Primeiro tenta o
# build de linha de comando do Equilotl, sem nenhuma janela; se ele nao existir para o mod, ou
# se o download falhar, degrada para o caminho com janela (run_inject) em vez de abortar.
macos_run_inject() {
    local root="$1" loc="${2:-}"

    if [ -n "$loc" ] && macos_has_cli_installer "$root"; then
        step "Injetando no Discord pelo build de linha de comando do Equilotl (sem janela)"
        if macos_run_inject_cli "$root" "$loc" && injected_from_checkout "$root"; then
            return 0
        fi
        warn "O build de linha de comando nao funcionou. Caindo para a janela do instalador do mod."
    fi

    macos_window_click_hint "$root" "$loc" "Install"
    step "Injetando no Discord (abre a janela do instalador do mod)"
    run_inject "$root" "$loc" || true
    injected_from_checkout "$root" && return 0

    if [ -n "$loc" ] && [ ! -w "$loc" ] && macos_is_system_target "$loc"; then
        fail "$(macos_permission_failure_message "$loc")"
    fi

    return 0
}

# Operacao inversa de macos_run_inject: tenta o build de linha de comando primeiro (sem janela),
# e so cai para "pnpm uninject" (janela) quando o mod nao tem CLI (Vencord) ou o binario falha.
# Quem chama confere o resultado por conta propria (injected_from_checkout), do mesmo jeito que
# a instalacao: o codigo de saida do instalador do mod nao e prova de nada.
macos_run_uninject() {
    local root="$1" loc="${2:-}"

    if [ -n "$loc" ] && macos_has_cli_installer "$root"; then
        step "Desfazendo a injecao pelo build de linha de comando do Equilotl (sem janela)"
        if macos_run_uninject_cli "$root" "$loc" && ! injected_from_checkout "$root"; then
            return 0
        fi
        warn "O build de linha de comando nao funcionou. Caindo para a janela do instalador do mod."
    fi

    macos_window_click_hint "$root" "$loc" "Uninstall"
    step "Desfazendo a injecao (abre a janela do instalador do mod)"
    (cd "$root" && pnpm uninject) || true
    return 0
}

# O bundle .app cujo app.asar aponta para este checkout, se a injecao ja tiver acontecido.
# Vazio (falha) antes da injecao ou quando o checkout nao esta injetado em lugar nenhum. E o
# elo entre "que checkout" (o que o resto do script raciocina) e "qual canal fechar e reabrir"
# (o que o macOS precisa para nao mexer no Discord errado quando ha mais de um instalado).
macos_bundle_for_checkout() {
    local root="${1:-}" resources
    resources="$(injected_resources "$root")" || return 1
    install_location "$resources"
}

# pkill -f casa o caminho inteiro do processo, nao so o nome -- necessario porque o executavel
# dentro do bundle se chama so "Discord" nos quatro canais (Contents/MacOS/Discord), e so o
# caminho do .app diferencia "Discord PTB.app" de "Discord.app". Mata so o canal pedido, mesmo
# com outro Discord aberto ao lado.
macos_discord_running() {
    pgrep -f "$1/Contents/MacOS/" >/dev/null 2>&1
}

macos_stop_discord() {
    local bundle="$1" i
    macos_discord_running "$bundle" || return 0

    step "Fechando o Discord"
    pkill -f "$bundle/Contents/MacOS/" >/dev/null 2>&1 || true

    for i in $(seq 1 30); do
        sleep 0.3
        macos_discord_running "$bundle" || return 0
    done

    fail "O Discord nao fechou. Feche na mao e rode de novo."
}

# `open` e o jeito proprio do macOS de abrir um bundle pelo caminho -- nao precisa saber o nome
# do executavel dentro dele, que muda por canal.
macos_start_discord() {
    open "$1" >/dev/null 2>&1 || true
}

inject_mod() {
    local root="$1"
    local -a alvos=()
    local alvo="" loc="" id=""

    local resources
    while IFS= read -r resources; do
        alvos+=("$resources")
    done < <(discord_resources)
    if [ "${#alvos[@]}" -eq 1 ]; then
        alvo="${alvos[0]}"
        loc="$(install_location "$alvo")"
    fi

    if [ -n "$alvo" ] && id="$(flatpak_app_id "$alvo")"; then
        step "Discord instalado por flatpak ($id)"
    fi

    # No macOS $loc ja e o bundle .app (install_location resolve para o bundle inteiro), o
    # mesmo caminho que stop_discord precisa para fechar so o canal certo. Fora do Darwin
    # stop_discord ignora este argumento.
    stop_discord "$loc"

    # A mensagem do "nao pegou" muda por sistema (ver a checagem depois deste if/elif/else),
    # mas todo o resto do ramo Darwin fica junto aqui, num unico lugar.
    local mensagem_falha="A injecao nao pegou. Se o Discord estiver em /usr/share, /opt ou num flatpak, rode: cd $root && sudo pnpm inject"

    if [ "$OS_NAME" = "Darwin" ]; then
        macos_run_inject "$root" "$loc"
        mensagem_falha="A injecao nao pegou. Confira se ha mais de um Discord instalado e use --source para apontar o checkout certo."
    # Fora do HOME a injecao precisa de raiz, e o instalador do mod nao pede sozinho: ele so
    # falha com permissao negada. Perguntar antes vale mais que falhar e mandar tentar de novo.
    elif [ -n "$alvo" ] && [ ! -w "$alvo" ]; then
        printf '  %sO Discord esta em %s, fora do seu HOME.%s\n' "$C_DIM" "$alvo" "$C_OFF" >&2
        can_sudo || fail "A injecao nesse Discord precisa de sudo, e em modo automatico nao da para pedir a senha. Rode sem --yes, ou: cd $root && sudo pnpm inject"
        confirm "A injecao ai precisa de sudo. Posso rodar com sudo?" \
            || fail "Sem sudo nao da para injetar nesse Discord. Rode: cd $root && sudo pnpm inject"
        step "Injetando no Discord"
        run_inject_root "$root" "$loc" || true
    else
        step "Injetando no Discord (pode pedir sua senha do sudo)"
        run_inject "$root" "$loc" || true

        # O instalador do mod tambem cai aqui quando o Discord escolhido na lista dele estava
        # fora do HOME, e ai o sudo so aparece como opcao depois.
        if ! injected_from_checkout "$root" && can_sudo && confirm "Nao pegou. Tentar de novo com sudo?"; then
            run_inject_root "$root" "$loc" || true
        fi
    fi

    # O pnpm inject sai com 0 mesmo quando o instalador do mod falha, entao o codigo de saida
    # nao serve de prova. Conferir se a injecao realmente passou a apontar para este checkout.
    injected_from_checkout "$root" || fail "$mensagem_falha"

    # De novo por conta propria, e nao so confiando no instalador do mod: ele so libera o
    # sandbox quando descobre sozinho que aquilo e um flatpak, e o comando e idempotente.
    if id="$(injected_flatpak_id "$root")"; then
        grant_flatpak_access "$id" "$root/dist"
    fi
}

checkout_mod() {
    # A identidade vem do package.json, nao do nome da pasta: quem baixou o ZIP tem o repo
    # numa pasta chamada Equicord-main, e ai o nome da pasta nao diz nada.
    local root="$1"
    local manifest="$root/package.json"

    if [ -f "$manifest" ]; then
        local name
        name="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).name||""))}catch(e){}' "$manifest" 2>/dev/null || true)"
        case "$(lower "$name")" in
            *equicord*) echo "Equicord"; return 0 ;;
            *vencord*) echo "Vencord"; return 0 ;;
        esac
    fi

    case "$(lower "$(basename "$root")")" in
        *vencord*) echo "Vencord" ;;
        *) echo "Equicord" ;;
    esac
}

mod_settings_file() {
    # Mesma regra do proprio mod (src/main/utils/constants.ts):
    #   DATA_DIR = <MOD>_USER_DATA_DIR ?? ~/.config/<Mod>
    local root="$1"
    local mod id
    mod="$(checkout_mod "$root")"

    # Dentro do flatpak o HOME e outro: o ~/.config do mod cai em ~/.var/app/<id>/config. Um
    # settings.json escrito no ~/.config de fora nao seria lido por ninguem, e o plugin abriria
    # desligado depois de o instalador dizer que ativou.
    if id="$(injected_flatpak_id "$root")"; then
        printf '%s\n' "$HOME/.var/app/$id/config/$mod/settings/settings.json"
        return 0
    fi

    local override="$(upper "$mod")_USER_DATA_DIR"
    if [ -n "${!override:-}" ]; then
        printf '%s\n' "${!override}/settings/settings.json"
        return 0
    fi

    # No macOS o Electron resolve app.getPath("userData") para ~/Library/Application Support,
    # nao para um diretorio ao estilo XDG.
    if [ "$OS_NAME" = "Darwin" ]; then
        printf '%s\n' "$HOME/Library/Application Support/$mod/settings/settings.json"
        return 0
    fi

    printf '%s\n' "$HOME/.config/$mod/settings/settings.json"
}

set_plugin_settings() {
    local root="$1"
    local perfil="$2"
    local endpoint="$3"
    local file
    file="$(mod_settings_file "$root")"
    mkdir -p "$(dirname "$file")"

    SFX_FILE="$file" SFX_PERFIL="$perfil" SFX_ENDPOINT="$endpoint" node -e '
        const fs = require("fs");
        const file = process.env.SFX_FILE;

        let settings = {};
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, "utf8");
            if (raw.trim() !== "") {
                try {
                    settings = JSON.parse(raw);
                } catch (error) {
                    // Nunca reescrever por cima de um arquivo ilegivel: isso apagaria todos os
                    // plugins da pessoa.
                    const backup = file + ".bak-" + Date.now();
                    fs.copyFileSync(file, backup);
                    console.error("ilegivel, copia em " + backup);
                    process.exit(2);
                }
            }
        }

        const plugin = settings.plugins && settings.plugins.StreamFix ? settings.plugins.StreamFix : {};

        // `proxy` e `excludedCountries` sairam com a proxy de gateway (fase 0), e
        // `tunelPermanente` saiu com o tunel em dois niveis. Escrever aqui um campo que o plugin
        // nao le mais so deixaria lixo no settings.json de quem atualiza.
        for (const morto of ["proxy", "excludedCountries", "tunelPermanente"]) delete plugin[morto];

        plugin.enabled = true;
        plugin.exigirTunel = true;
        plugin.perfilDoTunel = process.env.SFX_PERFIL;

        // Vem da resposta da saida, nao de um padrao escrito aqui: e contra este endereco que o
        // porteiro confere o que o Discord reporta, e um valor chutado recusaria transmissao boa.
        plugin.enderecoDaSaida = process.env.SFX_ENDPOINT;

        // Desligado por padrao: o normal e o tunel em dois niveis. So escreve quando falta, para
        // nao desfazer a escolha de quem ligou o completo e reinstalou.
        if (plugin.tunelCompletoSempre === undefined) plugin.tunelCompletoSempre = false;

        settings.plugins = settings.plugins || {};
        settings.plugins.StreamFix = plugin;
        fs.writeFileSync(file, JSON.stringify(settings, null, 4));
    ' && step "Plugin ativado em $file" || warn "Nao mexi no $file. Ative o StreamFix na mao em Configuracoes > Plugins."
}

show_status() {
    local root="${1:-}"
    local count mod plugin
    count="$(discord_resources | wc -l)"
    mod="$(installed_mod || true)"

    printf '  %sDetectado:%s\n' "$C_BOLD" "$C_OFF"
    if [ "$count" -gt 0 ]; then
        printf '  %s  Discord   instalado (%s)%s\n' "$C_DIM" "$count" "$C_OFF"
    else
        printf '  %s  Discord   nao encontrado%s\n' "$C_YELLOW" "$C_OFF"
    fi
    printf '  %s  Mod       %s%s\n' "$C_DIM" "${mod:-nenhum}" "$C_OFF"

    if [ -n "$root" ]; then
        printf '  %s  Fonte     %s%s\n' "$C_DIM" "$root" "$C_OFF"
        plugin="$root/src/userplugins/$PLUGIN_DIR_NAME"
        if [ -d "$plugin" ]; then
            printf '  %s  Plugin    ja instalado%s\n' "$C_GREEN" "$C_OFF"
        else
            printf '  %s  Plugin    nao instalado%s\n' "$C_DIM" "$C_OFF"
        fi
    else
        printf '  %s  Fonte     nao encontrado%s\n' "$C_DIM" "$C_OFF"
    fi
    printf '\n'
}

select_target() {
    local root="${1:-}"
    if [ -z "$root" ]; then
        install_mod "$(choose_mod)"
        return
    fi

    local name
    name="$(basename "$root")"
    printf '  %sOnde instalar?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Usar o %s que ja esta aqui%s\n' "$C_GREEN" "$name" "$C_OFF" >&2
    printf '  %s      %s%s\n' "$C_DIM" "$root" "$C_OFF" >&2
    printf '    %s[2] Baixar e usar outro (Equicord ou Vencord)%s\n\n' "$C_CYAN" "$C_OFF" >&2

    local choice
    read -r -p "  Escolha: " choice
    if [ "$choice" = "2" ]; then
        install_mod "$(choose_mod)"
    else
        printf '%s\n' "$root"
    fi
}

# ---------------------------------------------------------------------------------------------
# O tunel (macOS)
#
# Espelha o que o StreamFix-Installer.ps1 faz no Windows, com o WireSock trocado pelo wg-quick.
# O contrato do wg-quick esta medido em docs/research/wg-quick-no-darwin-2026-09-17.md, e tres
# achados de la governam este bloco:
#
#   - o nome do perfil nao passa de 15 caracteres, entao os nomes do Windows nao servem;
#   - ler estado exige root, nao so subir e derrubar -- por isso a regra de sudoers inclui
#     `wg show`;
#   - `wg-quick up` devolve 0 mesmo sem handshake, entao "subiu" nao prova nada. Quem confere e
#     o plugin, com `controle-wg.ts`, que tem teste.
# ---------------------------------------------------------------------------------------------

# O primeiro dos CONFIG_SEARCH_PATHS do wg-quick, e o unico que nao muda com a arquitetura.
WG_DIR="/etc/wireguard"
SUDOERS_FILE="/etc/sudoers.d/streamfix"

# Nomes curtos por obrigacao: `streamfix-santiago` tem 18 caracteres e o wg-quick recusa. O
# sufixo de controle e o `-ctl` de SUFIXO_CONTROLE em controle-wg.ts, e as duas pontas tem de
# concordar -- o plugin deduz os destinos de cada perfil por esse sufixo (destinosPorConvencao,
# em native.ts). Um teste de drift compara os dois.
TUNNEL_PROFILE="streamfix"
TUNNEL_PROFILE_CTL="streamfix-ctl"

# O fecho transitivo do provisionador: ele e os modulos que ele importa. Espelha o
# $ProvisioningFiles do StreamFix-Installer.ps1, e um teste de drift compara os dois com os
# imports reais do provisiona.mjs.
#
# **Por que baixar em vez de usar o arquivo ao lado.** A release publica o
# streamfix-installer.sh sozinho, como asset. Quem baixa de la nao tem vizinho nenhum, e
# chamar `$SCRIPT_DIR/provisiona.mjs` falharia depois de ja ter instalado o wireguard-tools e
# pedido o convite -- no pior momento possivel, com o convite ja digitado.
PROVISIONING_FILES=(
    "installer/provisiona.mjs"
    "streamFix/tunnel/perfil.ts"
    "streamFix/tunnel/controle-wg.ts"
    "provisionamento/cliente.ts"
    "provisionamento/chaves.ts"
)

# O bash 4+ que executa o wg-quick. Descoberto na instalacao e usado em todas as chamadas.
BASH4=""

macos_ensure_wireguard() {
    if ! have wg-quick || ! have wg; then
        have brew || fail "Preciso do wireguard-tools e nao achei o Homebrew para instala-lo. Instale o Homebrew em https://brew.sh e rode este instalador de novo."

        step 'Instalando o wireguard-tools (so o utilitario de linha de comando)'
        brew install wireguard-tools >/dev/null 2>&1             || fail 'O brew nao conseguiu instalar o wireguard-tools.'

        have wg-quick && have wg             || fail 'O brew terminou e o wg-quick nao apareceu no PATH.'
        ok 'wireguard-tools instalado.'
    fi

    macos_ensure_bash4
}

# **O wg-quick exige bash 4+, e o macOS traz o 3.2.**
#
# Medido em 20/09, num Mac de verdade: `sudo wg-quick up` responde "Version mismatch: bash 3
# detected, when bash 4+ required" e nao sobe nada. A Apple parou no bash 3.2 por licenca.
#
# Por que a medicao no CI nao pegou: o runner do GitHub ja tem o bash do Homebrew no PATH, entao
# la o `#!/usr/bin/env bash` do wg-quick achava um bash 5. Num Mac comum, sob `sudo`, o PATH e
# higienizado e o `env bash` acha o /bin/bash 3.2 da Apple. O modo de falha so existe na
# combinacao "Mac de verdade + sudo" -- que e exatamente a combinacao em que o StreamFix roda.
#
# A saida e chamar o interpretador pelo caminho absoluto, e nunca depender do PATH do sudo. Isso
# tambem e o que deixa a regra de sudoers ser exata, sem curinga nenhum.
macos_ensure_bash4() {
    local candidato
    for candidato in "$(brew --prefix 2>/dev/null)/bin/bash" /opt/homebrew/bin/bash /usr/local/bin/bash; do
        [ -x "$candidato" ] || continue
        if [ "$("$candidato" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null)" -ge 4 ] 2>/dev/null; then
            BASH4="$candidato"
            break
        fi
    done

    if [ -z "$BASH4" ]; then
        have brew || fail 'O wg-quick precisa de bash 4+ e esta maquina so tem o 3.2 da Apple. Instale o Homebrew em https://brew.sh e rode de novo.'
        step 'Instalando um bash moderno (o /bin/bash da Apple fica intacto)'
        brew install bash >/dev/null 2>&1 || fail 'O brew nao conseguiu instalar o bash.'
        for candidato in "$(brew --prefix 2>/dev/null)/bin/bash" /opt/homebrew/bin/bash /usr/local/bin/bash; do
            [ -x "$candidato" ] && BASH4="$candidato" && break
        done
    fi

    [ -n "$BASH4" ] || fail 'Nao achei um bash 4+ nesta maquina, e sem ele o wg-quick nao sobe tunel nenhum.'
    ok "bash para o wg-quick: $BASH4"
}

# Toda chamada ao wg-quick passa por aqui. Nenhuma o chama direto, de proposito.
wgq() {
    sudo "$BASH4" "$(command -v wg-quick)" "$@"
}

# O convite e a unica coisa que o instalador nao consegue arranjar sozinho.
#
# Lido sem eco: ele nao e exatamente uma senha, mas fica no historico do terminal e em captura de
# tela se ecoar, e um convite vale um peer na saida de alguem.
ask_invite() {
    local convite
    printf '\n  %sO convite para a saida%s\n' "$C_BOLD" "$C_OFF" >&2
    printf '  %sE a unica coisa que eu nao consigo arranjar sozinho: quem opera a saida te manda.%s\n\n' "$C_DIM" "$C_OFF" >&2
    read -r -s -p "  Convite: " convite
    printf '\n' >&2
    [ -n "$convite" ] || fail 'Sem convite nao da para montar o tunel.'
    printf '%s\n' "$convite"
}

# Troca o convite por um endereco na saida e escreve os dois perfis num diretorio temporario.
#
# Toda a decisao -- medir o MTU, gerar o par de chaves, montar o texto do perfil -- vive no
# provisiona.mjs, que e o mesmo do Windows e tem teste. Aqui fica so o que so o shell faz.
#
# O convite vai por ENTRADA PADRAO, nunca por argumento: argumento aparece na lista de processos
# para qualquer usuario da maquina. A chave privada nunca sai do provisionador a nao ser dentro
# do arquivo -- nem para stdout, nem para stderr.
# Monta o provisionador num diretorio temporario, com os caminhos relativos preservados --
# senao os imports de `../streamFix/` nao resolvem. Imprime o diretorio.
stage_provisioner() {
    local dir arquivo destino
    dir="$(mktemp -d)"
    for arquivo in "${PROVISIONING_FILES[@]}"; do
        destino="$dir/$arquivo"
        mkdir -p "$(dirname "$destino")"
        repo_file "$arquivo" > "$destino"
    done
    printf '%s\n' "$dir"
}

macos_provision_tunnel() {
    local convite="$1" url="$2" chave="$3"
    local tmp arquivo prov
    tmp="$(mktemp -d)"
    # O nome do perfil sai do nome do ARQUIVO, no wg-quick como no WireSock.
    arquivo="$tmp/$TUNNEL_PROFILE.conf"

    local args=(--url "$url" --arquivo "$arquivo" --plataforma darwin)
    [ -n "$chave" ] && args+=(--chave-da-saida "$chave")

    # O provisionador e montado ANTES de o convite ser usado: se faltar um modulo, a falha
    # acontece aqui, com o convite ainda intacto, e nao depois de gasta-lo.
    prov="$(stage_provisioner)"

    step 'Trocando o convite por um endereco na saida' >&2
    if ! printf '%s' "$convite" | node "$prov/installer/provisiona.mjs" "${args[@]}" > "$tmp/resposta.json"; then
        # **O motivo tem de sair daqui.** O provisionador explica a falha no JSON que escreve
        # em stdout -- e stdout esta redirecionado para o arquivo. Sem esta leitura, a pessoa
        # ve so "nao consegui montar o tunel", que nao diz se o problema foi o convite, a
        # saida fora do ar ou a medicao do MTU. Foi exatamente o que aconteceu na primeira
        # instalacao num Mac, em 20/09: a causa (ping do macOS) ficou escondida no arquivo.
        local motivo=""
        [ -s "$tmp/resposta.json" ] && motivo="$(tunnel_field "$tmp" erro)"
        rm -rf "$tmp" "$prov"
        if [ -n "$motivo" ]; then
            fail "Nao consegui montar o tunel: $motivo"
        fi
        fail 'Nao consegui montar o tunel, e o provisionador nao disse por que. Confira o convite e o endereco da saida.'
    fi
    rm -rf "$prov"

    printf '%s\n' "$tmp"
}

# Le um campo da resposta do provisionador. Node em vez de grep: a resposta e JSON, e casar
# JSON com expressao regular da certo ate o dia em que nao da.
tunnel_field() {
    local tmp="$1" campo="$2"
    SFX_JSON="$tmp/resposta.json" SFX_CAMPO="$campo" node -e '
        const fs = require("fs");
        const j = JSON.parse(fs.readFileSync(process.env.SFX_JSON, "utf8"));
        process.stdout.write(String(j[process.env.SFX_CAMPO] ?? ""));
    ' 2>/dev/null
}

# Instala os dois perfis em /etc/wireguard, como root e 600.
#
# `install -m 600` em vez de `cp` seguido de `chmod`: ele cria o arquivo ja com o modo certo, sem
# o instante em que um arquivo com a chave privada dentro existe legivel para outra conta.
macos_install_profiles() {
    local tmp="$1" perfil
    step "Instalando os perfis em $WG_DIR (o macOS vai pedir a sua senha)"
    sudo mkdir -p "$WG_DIR" || fail "Nao consegui criar $WG_DIR."
    for perfil in "$TUNNEL_PROFILE" "$TUNNEL_PROFILE_CTL"; do
        sudo install -m 600 -o root "$tmp/$perfil.conf" "$WG_DIR/$perfil.conf" \
            || fail "Nao consegui escrever $WG_DIR/$perfil.conf."
    done
    ok 'Perfis instalados.'
}

# A regra que deixa o plugin operar o tunel sem pedir senha a cada clique de Go Live.
#
# **Por que ela precisa existir.** O tunel em dois niveis troca de perfil no clique do Go Live e
# ao entrar numa call. Sem a regra, cada troca dispararia um prompt de senha -- e um prompt no
# meio do clique e pior do que nao ter o recurso.
#
# **Por que ela inclui `wg show`.** Medido em 17/09: o socket de controle do WireGuard e o arquivo
# que mapeia perfil para interface sao os dois so-root, entao ate LER se o tunel esta de pe exige
# privilegio. Sem isso o porteiro nao conseguiria responder a pergunta que ele existe para
# responder. `wg` e leitura pura; quem escreve e o `wg-quick`, e dele so `up` e `down` de dois
# nomes fixos estao liberados.
#
# **Por que passa pelo `visudo -c` antes.** Um arquivo invalido em /etc/sudoers.d pode quebrar o
# sudo da maquina inteira, e esse nao e um estrago que este instalador pode se dar ao luxo de
# causar. A regra e escrita num temporario, validada la, e so entao movida para o lugar.
macos_write_sudoers() {
    local wg_quick wg_bin tmp
    wg_quick="$(command -v wg-quick)"
    wg_bin="$(command -v wg)"
    tmp="$(mktemp)"

    # O interpretador entra na regra porque ele entra na chamada (ver macos_ensure_bash4).
    # Sem ele aqui, o sudo veria um comando diferente do autorizado e pediria senha no clique
    # do Go Live -- justamente o que esta regra existe para evitar.
    printf '%s ALL=(root) NOPASSWD: %s %s up %s, %s %s down %s, %s %s up %s, %s %s down %s, %s show *\n' \
        "$USER" \
        "$BASH4" "$wg_quick" "$TUNNEL_PROFILE" \
        "$BASH4" "$wg_quick" "$TUNNEL_PROFILE" \
        "$BASH4" "$wg_quick" "$TUNNEL_PROFILE_CTL" \
        "$BASH4" "$wg_quick" "$TUNNEL_PROFILE_CTL" \
        "$wg_bin" > "$tmp"
    chmod 440 "$tmp"

    if ! sudo visudo -c -f "$tmp" >/dev/null 2>&1; then
        rm -f "$tmp"
        fail 'A regra de sudoers que eu montei nao passou na validacao, entao nao instalei nada: um sudoers invalido quebra o sudo da maquina inteira.'
    fi

    step "Autorizando o plugin a operar o tunel sem senha ($SUDOERS_FILE)"
    sudo install -m 440 -o root "$tmp" "$SUDOERS_FILE" \
        || { rm -f "$tmp"; fail "Nao consegui escrever $SUDOERS_FILE."; }
    rm -f "$tmp"
    ok 'Autorizado -- so para subir, derrubar e consultar estes dois perfis.'
}

# Sobe o perfil de controle, que e o nivel normal do tunel em dois niveis.
#
# Nao confere o handshake aqui, de proposito: um `up` que devolve 0 nao prova nada (achado 4 da
# medicao), e quem sabe conferir e o `controle-wg.ts`, que tem teste. Repetir essa logica em bash
# seria duplicar em linguagem sem teste uma decisao que ja existe testada.
macos_bring_up_control() {
    step 'Subindo o tunel de controle'
    wgq down "$TUNNEL_PROFILE" >/dev/null 2>&1 || true
    wgq down "$TUNNEL_PROFILE_CTL" >/dev/null 2>&1 || true
    if wgq up "$TUNNEL_PROFILE_CTL" >/dev/null 2>&1; then
        ok 'Tunel de controle no ar.'
    else
        warn 'Nao consegui subir o tunel de controle agora. O plugin tenta de novo quando o Discord abrir.'
    fi
}

select_persistence() {
    local root="${1:-}"

    # O modo temporario promete desfazer a injecao sozinha quando o Discord fechar, sem
    # ninguem para clicar. No macOS isso so acontece com o Equicord (build de linha de
    # comando); com o Vencord desfazer abriria a janela do instalador do mod, possivelmente
    # muito depois de a pessoa ter saido do computador. Por isso nem se oferece a escolha.
    if [ "$OS_NAME" = "Darwin" ] && ! macos_has_cli_installer "$root"; then
        warn "Modo temporario indisponivel para $(checkout_mod "$root") no macOS: desfazer a injecao sozinho precisaria de um clique que ninguem vai dar quando o Discord fechar. Instalando permanente."
        return 0
    fi

    printf '\n  %sComo voce quer deixar o Discord?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Permanente%s\n' "$C_GREEN" "$C_OFF" >&2
    printf '  %s      O Discord abre com o mod toda vez, ate voce remover.%s\n' "$C_DIM" "$C_OFF" >&2
    printf '    %s[2] Temporario%s\n' "$C_YELLOW" "$C_OFF" >&2
    printf '  %s      Vale so nesta sessao. Ao fechar o Discord a injecao e desfeita.%s\n\n' "$C_DIM" "$C_OFF" >&2

    local choice
    read -r -p "  Escolha: " choice
    [ "$choice" = "2" ] && return 1
    return 0
}

start_discord() {
    local root="${1:-}" exe id bundle

    if [ "$OS_NAME" = "Darwin" ]; then
        if bundle="$(macos_bundle_for_checkout "$root")"; then
            macos_start_discord "$bundle"
        fi
        return 0
    fi

    # Quem tem o flatpak e um Discord nativo pela metade acabaria com o nativo aberto, sem o
    # mod, e concluiria que a instalacao falhou. Abrir o mesmo que foi injetado resolve.
    if id="$(injected_flatpak_id "$root")" && have flatpak; then
        nohup flatpak run "$id" >/dev/null 2>&1 &
        return 0
    fi

    for exe in discord Discord discord-ptb discord-canary; do
        if have "$exe"; then
            nohup "$exe" >/dev/null 2>&1 &
            return 0
        fi
    done
}

wait_discord_exit() {
    local root="$1" bundle=""
    [ "$OS_NAME" = "Darwin" ] && bundle="$(macos_bundle_for_checkout "$root" || true)"

    printf '\n'
    ok "Discord aberto com o StreamFix."
    warn "Deixe este terminal aberto. Quando voce fechar o Discord, eu desfaco a injecao."

    sleep 5
    if [ "$OS_NAME" = "Darwin" ] && [ -n "$bundle" ]; then
        while macos_discord_running "$bundle"; do sleep 2; done
    else
        while discord_running; do sleep 2; done
    fi

    printf '\n'
    step "Discord fechado, desfazendo a injecao"
    if [ "$OS_NAME" = "Darwin" ]; then
        if macos_run_uninject "$root" "$bundle" && ! injected_from_checkout "$root"; then
            ok "Discord restaurado."
        else
            warn "Nao consegui desfazer a injecao sozinho. Rode: cd $root && pnpm uninject"
        fi
    elif (cd "$root" && pnpm uninject); then
        ok "Discord restaurado."
    else
        warn "O pnpm uninject falhou. Rode 'pnpm uninject' na pasta do mod."
    fi
}

do_install() {
    local root="${1:-}"
    root="$(select_target "$root")"

    # No modo sem perguntas nao tem quem clique na janela do instalador do mod, e essa janela e
    # o unico jeito de injetar Vencord no macOS (ADR 0001). Falhar aqui, antes de baixar
    # toolchain e compilar, evita deixar uma janela aberta esperando alguem que nao vai aparecer.
    # So se aplica quando a injecao de fato vai acontecer: um checkout ja injetado (linha "so
    # reiniciando" mais abaixo) nunca chega perto da janela, e barrar esse caso so atrapalharia
    # quem roda --yes de novo pra atualizar um Vencord que ja estava funcionando.
    if [ "$OS_NAME" = "Darwin" ] && [ "$ASSUME_YES" -eq 1 ] && ! macos_has_cli_installer "$root" \
        && ! injected_from_checkout "$root"; then
        fail "$(checkout_mod "$root") no macOS so injeta pela janela do instalador do mod, e o modo sem perguntas (--yes) nao tem quem clique nela. Rode sem --yes, ou escolha Equicord (--mod equicord), que tem build de linha de comando para o macOS."
    fi

    # O tunel so tem implementacao para macOS por enquanto. O Linux cai fora antes daqui, no
    # refuse_install_for_now -- este ramo nunca ve outro sistema.
    [ "$OS_NAME" = "Darwin" ] || fail 'O tunel ainda so tem caminho para macOS neste instalador.'

    local permanent=0
    select_persistence "$root" || permanent=1

    # O tunel e montado ANTES do plugin, e ativar o plugin e o ultimo passo de todos. Um estado
    # pela metade que PARECE pronto e pior do que nenhum estado: se a instalacao parar no meio, a
    # pessoa fica sem plugin, e nao com um plugin ligado e sem tunel por baixo.
    macos_ensure_wireguard

    local convite tmp perfil endpoint
    convite="$(ask_invite)"
    tmp="$(macos_provision_tunnel "$convite" "$EXIT_URL" "$EXIT_KEY")"
    # O convite ja foi trocado por um peer; nao ha mais motivo para ele existir nesta sessao.
    convite=""

    perfil="$(tunnel_field "$tmp" perfil)"
    endpoint="$(tunnel_field "$tmp" endpoint)"
    [ -n "$perfil" ] && [ -n "$endpoint" ] \
        || { rm -rf "$tmp"; fail 'O provisionador nao devolveu o perfil e o endereco da saida.'; }

    macos_install_profiles "$tmp"
    # Os arquivos ja estao em /etc/wireguard; o temporario tem a chave privada dentro e nao pode
    # sobreviver a esta funcao.
    rm -rf "$tmp"

    macos_write_sudoers
    macos_bring_up_control

    ensure_toolchain
    copy_plugin "$root"
    build_mod "$root"

    if injected_from_checkout "$root"; then
        step "O Discord ja carrega deste checkout, so reiniciando"
        local bundle=""
        [ "$OS_NAME" = "Darwin" ] && bundle="$(macos_bundle_for_checkout "$root" || true)"
        stop_discord "$bundle"
    else
        inject_mod "$root"
    fi

    # Com o Discord fechado: aberto, ele regrava o settings.json a partir da memoria e
    # apaga o que escrevemos aqui.
    set_plugin_settings "$root" "$perfil" "$endpoint"

    start_discord "$root"

    printf '\n'
    ok "Pronto. O plugin ja vem ativado, nao precisa mexer em nada."
    printf '  %sSaida: %s%s\n' "$C_DIM" "$endpoint" "$C_OFF"
    printf '  %sTunel: %s (controle) e %s (completo, emprestado por segundos)%s\n' \
        "$C_DIM" "$TUNNEL_PROFILE_CTL" "$TUNNEL_PROFILE" "$C_OFF"
    # A diferenca que o macOS tem em relacao ao Windows, dita uma vez, no lugar onde importa.
    printf '  %sNo macOS o corte e por tempo: durante esses segundos o Mac inteiro sai pela saida.%s\n' \
        "$C_DIM" "$C_OFF"
    printf '  %sEntre numa call e use Go Live ou a camera.%s\n' "$C_DIM" "$C_OFF"

    [ "$permanent" -eq 1 ] && wait_discord_exit "$root"
    return 0
}

do_uninstall() {
    local root target bundle=""
    root="$(find_checkout)" || fail "Nao encontrei o checkout do Equicord/Vencord. Use --source."
    target="$root/src/userplugins/$PLUGIN_DIR_NAME"
    [ "$OS_NAME" = "Darwin" ] && bundle="$(macos_bundle_for_checkout "$root" || true)"

    if [ -d "$target" ]; then
        step "Removendo $target"
        rm -rf "$target"
    else
        warn "O plugin nao estava instalado nesse checkout."
    fi

    build_mod "$root"
    stop_discord "$bundle"
    start_discord "$root"

    printf '\n'
    ok "Plugin removido. Seu Equicord/Vencord continua funcionando."
}

# Desfaz tudo que o instalador deixou fora do checkout: os perfis, a concessao de privilegio, e
# o tunel no ar.
#
# **A regra de sudoers e o item que mais importa remover.** Ela e a unica coisa que este
# instalador deixa na maquina com poder de root, e alguem que desinstala o StreamFix nao espera
# continuar com uma autorizacao permanente para um programa que nao esta mais la.
macos_remove_tunnel() {
    [ "$OS_NAME" = "Darwin" ] || return 0
    have wg-quick || return 0

    # O --restore nao passa pela instalacao, entao o BASH4 ainda esta vazio aqui. Sem isto o
    # `wgq` chamaria `sudo "" wg-quick` e a limpeza falharia em silencio -- deixando para tras
    # justamente a regra de sudoers, que e a parte que mais importa remover.
    [ -n "$BASH4" ] || macos_ensure_bash4

    step 'Derrubando o tunel e removendo os perfis'
    wgq down "$TUNNEL_PROFILE" >/dev/null 2>&1 || true
    wgq down "$TUNNEL_PROFILE_CTL" >/dev/null 2>&1 || true
    sudo rm -f "$WG_DIR/$TUNNEL_PROFILE.conf" "$WG_DIR/$TUNNEL_PROFILE_CTL.conf" 2>/dev/null || true

    if [ -f "$SUDOERS_FILE" ]; then
        step "Removendo a autorizacao de sudo ($SUDOERS_FILE)"
        sudo rm -f "$SUDOERS_FILE" || warn "Nao consegui remover $SUDOERS_FILE. Remova a mao: sudo rm $SUDOERS_FILE"
    fi
    ok 'Tunel removido.'
}

do_restore_everything() {
    local root target bundle=""

    macos_remove_tunnel

    if root="$(find_checkout)"; then
        target="$root/src/userplugins/$PLUGIN_DIR_NAME"
        [ "$OS_NAME" = "Darwin" ] && bundle="$(macos_bundle_for_checkout "$root" || true)"
        [ -d "$target" ] && { step "Removendo $target"; rm -rf "$target"; }

        stop_discord "$bundle"
        step "Desfazendo a injecao"
        if [ "$OS_NAME" = "Darwin" ]; then
            macos_run_uninject "$root" "$bundle"
        else
            (cd "$root" && pnpm uninject) || warn "O pnpm uninject falhou."
        fi
    else
        warn "Nao achei o fonte do mod, entao so posso parar por aqui."
    fi

    printf '\n'
    ok "Tudo restaurado. Seu Discord voltou ao normal."
}

# O Linux ainda nao tem caminho de tunel neste instalador.
#
# **O que falta nao e o `Controle`.** O `controle-wg.ts` fala com o `wg-quick`, que existe no
# Linux tambem, e a identificacao dele -- por destinos, e nao por nome de interface -- funciona
# nos dois sistemas. O que falta e o lado do instalador: cada distribuicao instala o
# wireguard-tools de um jeito, o wg-quick de la usa o modulo do kernel em vez do wireguard-go, e
# nada disso foi medido. Habilitar sem medir seria repetir exatamente o erro que a medicao do
# Darwin acabou de evitar.
#
# Recusar dizendo por que e melhor do que instalar algo quebrado e deixar a pessoa descobrir
# sozinha, que e o modo de falha que este projeto mais pagou caro.
refuse_install_for_now() {
    printf '\n  %sA instalacao em Linux ainda nao esta pronta.%s\n\n' "$C_YELLOW" "$C_OFF"
    printf '  O StreamFix depende de um tunel WireGuard. O controle dele ja serve o Linux, mas\n'
    printf '  o lado do instalador -- instalar o wireguard-tools em cada distribuicao, e o que\n'
    printf '  muda no wg-quick com o modulo do kernel -- ainda nao foi medido em lugar nenhum.\n\n'
    printf '  %sHoje o caminho e o Windows ou o macOS.%s\n' "$C_DIM" "$C_OFF"
    printf '  %sAcompanhe em https://github.com/EduardoVasconceloss/StreamFix%s\n' "$C_DIM" "$C_OFF"
    return 1
}

# Instalar so segue onde ha caminho de tunel medido. Hoje: macOS.
install_or_refuse() {
    if [ "$OS_NAME" = "Darwin" ]; then
        do_install "$@"
    else
        refuse_install_for_now
    fi
}

main_menu() {
    local root
    root="$(find_checkout || true)"
    show_status "$root"

    printf '  %sO que voce quer fazer?%s\n\n' "$C_BOLD" "$C_OFF"
    printf '    %s[1] Instalar ou atualizar o StreamFix%s\n' "$C_GREEN" "$C_OFF"
    printf '    %s[2] Remover so o plugin (o mod continua)%s\n' "$C_YELLOW" "$C_OFF"
    printf '    %s[3] Restaurar tudo (remove o plugin e desfaz a injecao)%s\n' "$C_RED" "$C_OFF"
    printf '    [0] Sair\n\n'

    local choice
    read -r -p "  Escolha: " choice
    case "$choice" in
        1) install_or_refuse ;;
        2) do_uninstall ;;
        3) do_restore_everything ;;
        *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" ;;
    esac
}

# Guarda de sourcing: os testes carregam este arquivo com "." para chamar as funcoes de
# descoberta sem disparar o instalador inteiro. BASH_SOURCE[0] so e igual a $0 quando o
# script e o processo executado diretamente, nao quando outro script o esta carregando.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    ensure_not_root
    banner
    case "$MODE" in
        install) install_or_refuse ;;
        uninstall) do_uninstall ;;
        restore) do_restore_everything ;;
        *) main_menu ;;
    esac
    printf '\n'
fi
