#!/usr/bin/env bash
#
# Testes de caracterizacao da camada de descoberta do instalador (streamfix-installer.sh),
# Linux e macOS.
#
# Shell puro, sem framework: o repositorio nao tem manifesto de dependencias para a parte de
# instalador, e um framework a mais seria a maior adicao desta spec. Roda com o que ja vem
# numa maquina Linux ou macOS comum -- o ramo Darwin da descoberta e exercitado por fixture em
# qualquer runner, sem precisar de um Mac de verdade (ver fixture_setup()).
#
# Uso:
#   ./installer/tests/run-tests.sh
#
# Cada teste monta uma arvore de fixtures num diretorio temporario, aponta FS_PREFIX e HOME
# para dentro dela e chama as funcoes de descoberta do instalador. Nada disso toca o sistema
# de arquivos de verdade: FS_PREFIX prefixa as raizes absolutas que a descoberta varre, e HOME
# aponta a arvore inteira relativa ao usuario para a fixture.

set -uo pipefail

# Nome proprio, e nao SCRIPT_DIR: o instalador tambem define uma variavel SCRIPT_DIR ao ser
# carregado logo abaixo, e ela sobrescreveria esta.
TESTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$TESTS_DIR/../streamfix-installer.sh"

# shellcheck source=../streamfix-installer.sh
source "$INSTALLER"

# A guarda de sourcing ja impediu o banner e o menu de rodarem; set -e do script sourceado
# ficaria em vigor daqui pra frente e derrubaria o runner no primeiro `[ ... ] || true` mal
# colocado. Os testes tratam falha explicitamente, entao desligamos -e e -o pipefail.
set +e +o pipefail

TESTS_RUN=0
TESTS_FAILED=0

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    TESTS_RUN=$((TESTS_RUN + 1))
    if [ "$expected" = "$actual" ]; then
        printf '  ok - %s\n' "$desc"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        printf '  FALHOU - %s\n    esperado: %s\n    recebido: %s\n' "$desc" "$expected" "$actual"
    fi
}

# Compara dois conjuntos de linhas ignorando ordem: a descoberta nao promete varrer as raizes
# numa ordem estavel, so promete achar tudo que existe.
assert_set_eq() {
    local desc="$1" expected="$2" actual="$3"
    local expected_sorted actual_sorted
    expected_sorted="$(printf '%s\n' "$expected" | sed '/^$/d' | sort)"
    actual_sorted="$(printf '%s\n' "$actual" | sed '/^$/d' | sort)"
    assert_eq "$desc" "$expected_sorted" "$actual_sorted"
}

assert_true() {
    local desc="$1"; shift
    TESTS_RUN=$((TESTS_RUN + 1))
    if "$@" >/dev/null 2>&1; then
        printf '  ok - %s\n' "$desc"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        printf '  FALHOU - %s (esperava sucesso)\n' "$desc"
    fi
}

assert_false() {
    local desc="$1"; shift
    TESTS_RUN=$((TESTS_RUN + 1))
    if "$@" >/dev/null 2>&1; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        printf '  FALHOU - %s (esperava falha)\n' "$desc"
    else
        printf '  ok - %s\n' "$desc"
    fi
}

# ------------------------------------------------------------------------------- fixtures

FIXTURE_ROOT=""

# fixture_setup [Linux|Darwin]
#
# O padrao e Linux, e nao o uname -s de verdade do runner: os dois jobs do CI (ubuntu-latest e
# macos-latest) rodam o mesmo run-tests.sh, e sem isto os testes de Linux quebrariam so por
# rodar no runner macOS. Cada teste que quer o ramo Darwin passa isso explicitamente.
fixture_setup() {
    FIXTURE_ROOT="$(mktemp -d)"
    FS_PREFIX="$FIXTURE_ROOT/root"
    HOME="$FIXTURE_ROOT/home"
    OS_NAME="${1:-Linux}"
    unset XDG_CONFIG_HOME XDG_DATA_HOME 2>/dev/null
    mkdir -p "$FS_PREFIX" "$HOME"
}

fixture_teardown() {
    [ -n "$FIXTURE_ROOT" ] && rm -rf "$FIXTURE_ROOT"
    FIXTURE_ROOT=""
}

# make_asar <diretorio-resources>
make_asar() {
    mkdir -p "$1"
    : > "$1/app.asar"
}

# make_checkout <diretorio> <nome-no-package-json>
make_checkout() {
    local dir="$1" name="$2"
    mkdir -p "$dir/src/utils" "$dir/.git"
    printf '{"name":"%s"}\n' "$name" > "$dir/package.json"
    : > "$dir/src/utils/types.ts"
}

# make_injected <diretorio-resources> <diretorio-checkout>
#
# Reproduz o que o Equicord/Vencord deixam para tras: o app.asar original renomeado para
# _app.asar, e uma pasta app/index.js que so faz require() do checkout.
make_injected() {
    local resources="$1" checkout="$2"
    mkdir -p "$resources/app"
    printf 'require("%s/dist/desktop");\n' "$checkout" > "$resources/app/index.js"
    : > "$resources/_app.asar"
}

# ------------------------------------------------------------------------------- descoberta

test_pacote_nativo() {
    printf '\n== descoberta: pacote nativo com o app embutido ==\n'
    fixture_setup
    make_asar "$FS_PREFIX/usr/share/discord/resources"

    assert_set_eq "acha o resources do pacote nativo" \
        "$FS_PREFIX/usr/share/discord/resources" \
        "$(discord_resources)"
    assert_eq "install_location sobe uma pasta" \
        "$FS_PREFIX/usr/share/discord" \
        "$(install_location "$FS_PREFIX/usr/share/discord/resources")"

    fixture_teardown
}

test_bootstrap_usuario() {
    printf '\n== descoberta: esquema de bootstrap no diretorio do usuario ==\n'
    fixture_setup
    make_asar "$HOME/.config/discord/app-1.0.9/resources"

    assert_set_eq "acha o resources baixado na primeira execucao" \
        "$HOME/.config/discord/app-1.0.9/resources" \
        "$(discord_resources)"
    assert_eq "install_location sobe duas pastas (passa por app-1.0.9)" \
        "$HOME/.config/discord" \
        "$(install_location "$HOME/.config/discord/app-1.0.9/resources")"

    fixture_teardown
}

test_flatpak_sistema() {
    printf '\n== descoberta: flatpak de sistema ==\n'
    fixture_setup
    make_asar "$FS_PREFIX/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources"

    local achado
    achado="$(discord_resources)"
    assert_set_eq "acha o resources dentro do deploy do flatpak" \
        "$FS_PREFIX/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources" \
        "$achado"
    assert_eq "flatpak_app_id le o id do caminho" \
        "com.discordapp.Discord" \
        "$(flatpak_app_id "$achado")"
    assert_eq "install_location para antes do current/active" \
        "$FS_PREFIX/var/lib/flatpak/app/com.discordapp.Discord" \
        "$(install_location "$achado")"

    fixture_teardown
}

test_flatpak_usuario() {
    printf '\n== descoberta: flatpak de usuario ==\n'
    fixture_setup
    make_asar "$HOME/.local/share/flatpak/app/com.discordapp.DiscordPTB/current/active/files/discordptb/resources"

    local achado
    achado="$(discord_resources)"
    assert_set_eq "acha o resources dentro do deploy do flatpak de usuario" \
        "$HOME/.local/share/flatpak/app/com.discordapp.DiscordPTB/current/active/files/discordptb/resources" \
        "$achado"
    assert_eq "flatpak_app_id le o id do canal PTB" \
        "com.discordapp.DiscordPTB" \
        "$(flatpak_app_id "$achado")"
    assert_eq "install_location para antes do current/active tambem no flatpak de usuario" \
        "$HOME/.local/share/flatpak/app/com.discordapp.DiscordPTB" \
        "$(install_location "$achado")"

    fixture_teardown
}

test_discord_ja_injetado() {
    printf '\n== descoberta: Discord ja injetado (asar original renomeado) ==\n'
    fixture_setup
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    make_injected "$FS_PREFIX/opt/discord/resources" "$checkout"

    assert_set_eq "o resources injetado continua aparecendo na descoberta (_app.asar conta)" \
        "$FS_PREFIX/opt/discord/resources" \
        "$(discord_resources)"
    assert_eq "checkout_from_injection acha o checkout pelo stub" \
        "$checkout" \
        "$(checkout_from_injection)"
    assert_eq "installed_mod le Equicord pelo require() do stub" \
        "Equicord" \
        "$(installed_mod)"
    assert_true "injected_from_checkout confirma que este checkout esta injetado" \
        injected_from_checkout "$checkout"
    assert_eq "install_location continua resolvendo com o Discord ja injetado" \
        "$FS_PREFIX/opt/discord" \
        "$(install_location "$FS_PREFIX/opt/discord/resources")"

    fixture_teardown
}

test_mais_de_um_discord() {
    printf '\n== descoberta: mais de um Discord ao mesmo tempo ==\n'
    fixture_setup
    make_asar "$FS_PREFIX/usr/share/discord/resources"
    make_asar "$HOME/.config/discordptb/app-1.2.3/resources"

    local achado count
    achado="$(discord_resources)"
    count="$(printf '%s\n' "$achado" | sed '/^$/d' | wc -l | tr -d ' ')"
    assert_eq "acha os dois Discords" "2" "$count"
    assert_set_eq "os dois caminhos aparecem, em qualquer ordem" \
        "$FS_PREFIX/usr/share/discord/resources
$HOME/.config/discordptb/app-1.2.3/resources" \
        "$achado"
    assert_eq "install_location resolve o nativo mesmo com outro Discord por perto" \
        "$FS_PREFIX/usr/share/discord" \
        "$(install_location "$FS_PREFIX/usr/share/discord/resources")"
    assert_eq "install_location resolve o bootstrap mesmo com outro Discord por perto" \
        "$HOME/.config/discordptb" \
        "$(install_location "$HOME/.config/discordptb/app-1.2.3/resources")"

    fixture_teardown
}

test_nenhum_discord() {
    printf '\n== descoberta: nenhum Discord instalado ==\n'
    fixture_setup

    assert_eq "discord_resources nao acha nada" "" "$(discord_resources)"
    assert_false "installed_mod falha sem Discord" installed_mod
    assert_false "checkout_from_injection falha sem Discord" checkout_from_injection

    fixture_teardown
}

# ------------------------------------------------------------------------ descoberta: macOS

test_macos_sistema() {
    printf '\n== descoberta (Darwin): canal estavel em /Applications ==\n'
    fixture_setup Darwin
    make_asar "$FS_PREFIX/Applications/Discord.app/Contents/Resources"

    assert_set_eq "acha o resources dentro do bundle de sistema" \
        "$FS_PREFIX/Applications/Discord.app/Contents/Resources" \
        "$(discord_resources)"
    assert_eq "install_location resolve o bundle inteiro, nao o Contents" \
        "$FS_PREFIX/Applications/Discord.app" \
        "$(install_location "$FS_PREFIX/Applications/Discord.app/Contents/Resources")"

    fixture_teardown
}

test_macos_usuario() {
    printf '\n== descoberta (Darwin): canal PTB em ~/Applications ==\n'
    fixture_setup Darwin
    make_asar "$HOME/Applications/Discord PTB.app/Contents/Resources"

    assert_set_eq "acha o resources dentro do bundle do usuario" \
        "$HOME/Applications/Discord PTB.app/Contents/Resources" \
        "$(discord_resources)"
    assert_eq "install_location resolve o bundle do usuario" \
        "$HOME/Applications/Discord PTB.app" \
        "$(install_location "$HOME/Applications/Discord PTB.app/Contents/Resources")"

    fixture_teardown
}

test_macos_quatro_canais() {
    printf '\n== descoberta (Darwin): os quatro canais ao mesmo tempo ==\n'
    fixture_setup Darwin
    make_asar "$FS_PREFIX/Applications/Discord.app/Contents/Resources"
    make_asar "$FS_PREFIX/Applications/Discord PTB.app/Contents/Resources"
    make_asar "$HOME/Applications/Discord Canary.app/Contents/Resources"
    make_asar "$HOME/Applications/Discord Development.app/Contents/Resources"

    local achado count
    achado="$(discord_resources)"
    count="$(printf '%s\n' "$achado" | sed '/^$/d' | wc -l | tr -d ' ')"
    assert_eq "acha os quatro canais" "4" "$count"
    assert_set_eq "os quatro caminhos aparecem, em qualquer ordem" \
        "$FS_PREFIX/Applications/Discord.app/Contents/Resources
$FS_PREFIX/Applications/Discord PTB.app/Contents/Resources
$HOME/Applications/Discord Canary.app/Contents/Resources
$HOME/Applications/Discord Development.app/Contents/Resources" \
        "$achado"

    fixture_teardown
}

test_macos_injetado() {
    printf '\n== descoberta (Darwin): bundle ja injetado (asar original renomeado) ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    make_injected "$FS_PREFIX/Applications/Discord.app/Contents/Resources" "$checkout"

    assert_set_eq "o resources injetado continua aparecendo na descoberta (_app.asar conta)" \
        "$FS_PREFIX/Applications/Discord.app/Contents/Resources" \
        "$(discord_resources)"
    assert_eq "checkout_from_injection acha o checkout pelo stub" \
        "$checkout" \
        "$(checkout_from_injection)"
    assert_eq "installed_mod le Equicord pelo require() do stub" \
        "Equicord" \
        "$(installed_mod)"
    assert_true "injected_from_checkout confirma que este checkout esta injetado" \
        injected_from_checkout "$checkout"
    assert_eq "install_location resolve o bundle mesmo ja injetado" \
        "$FS_PREFIX/Applications/Discord.app" \
        "$(install_location "$FS_PREFIX/Applications/Discord.app/Contents/Resources")"

    fixture_teardown
}

test_macos_sem_flatpak() {
    printf '\n== descoberta (Darwin): nao alcanca o ramo de flatpak ==\n'
    fixture_setup Darwin
    # As mesmas fixtures que os testes Linux usam para achar Discord de flatpak. No ramo
    # Darwin elas tem que ficar invisiveis: nada de flatpak existe no macOS.
    make_asar "$FS_PREFIX/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources"
    make_asar "$HOME/.var/app/com.discordapp.Discord/config/discord/app-1.0.9/resources"
    make_asar "$FS_PREFIX/usr/share/discord/resources"

    assert_eq "discord_resources nao ve nenhuma fixture ao estilo Linux/flatpak" \
        "" "$(discord_resources)"

    fixture_teardown
}

# ------------------------------------------------------------------ macOS: settings do mod

test_macos_settings_path() {
    printf '\n== settings (Darwin): pasta de suporte a aplicativos do usuario ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"

    assert_eq "settings ficam em Library/Application Support, nao em .config" \
        "$HOME/Library/Application Support/Equicord/settings/settings.json" \
        "$(mod_settings_file "$checkout")"

    EQUICORD_USER_DATA_DIR="$HOME/Custom/EquicordData"
    assert_eq "a variavel de override continua valendo no macOS" \
        "$HOME/Custom/EquicordData/settings/settings.json" \
        "$(mod_settings_file "$checkout")"
    unset EQUICORD_USER_DATA_DIR

    fixture_teardown
}

# ------------------------------------------------------------------- macOS: injecao via CLI

test_macos_cli_arch() {
    printf '\n== injecao (Darwin): o nome do asset do Equilotl ==\n'
    fixture_setup Darwin

    # O asset NAO tem "darwin" no nome: o workflow do Equilotl compila EquilotlCli-darwin e
    # publica renomeado para EquilotlCli-<arch>. Pedir com "darwin" da 404 -- foi o que fez a
    # injecao cair na janela num Mac, em 21/09, sem dizer por que.
    MACOS_ARCH="arm64"
    assert_eq "Apple Silicon pede EquilotlCli-arm64" \
        "EquilotlCli-arm64 EquilotlCli-universal" "$(macos_cli_assets | tr '\n' ' ' | sed 's/ $//')"

    MACOS_ARCH="x64"
    assert_eq "Intel pede EquilotlCli-x64" \
        "EquilotlCli-x64 EquilotlCli-universal" "$(macos_cli_assets | tr '\n' ' ' | sed 's/ $//')"

    # Numa CPU que nao mapeamos sobra o universal, que e o mesmo binario com as duas.
    MACOS_ARCH=""
    assert_eq "CPU nao mapeada cai no universal" \
        "EquilotlCli-universal" "$(macos_cli_assets | tr '\n' ' ' | sed 's/ $//')"

    MACOS_ARCH="arm64"
    assert_eq "nenhum candidato leva darwin no nome" "" "$(macos_cli_assets | grep darwin || true)"

    MACOS_ARCH=""
    fixture_teardown
}

test_macos_cli_cache_path() {
    printf '\n== injecao (Darwin): caminho do cache do binario ==\n'
    fixture_setup Darwin

    assert_eq "cache fica na pasta de caches do usuario, nao na de suporte a aplicativos" \
        "$HOME/Library/Caches/StreamFix/EquilotlCli-arm64" \
        "$(macos_equilotl_cli_cache_path "EquilotlCli-arm64")"

    fixture_teardown
}

test_macos_cli_reaproveita_cache() {
    printf '\n== injecao (Darwin): reaproveita o binario ja em cache ==\n'
    fixture_setup Darwin
    MACOS_ARCH="arm64"

    local cache="$HOME/Library/Caches/StreamFix/EquilotlCli-arm64"
    mkdir -p "$(dirname "$cache")"
    printf '#!/bin/sh\n' > "$cache"
    chmod +x "$cache"

    assert_eq "devolve o caminho em cache sem tentar baixar de novo" \
        "$cache" "$(ensure_equilotl_cli)"

    MACOS_ARCH=""
    fixture_teardown
}

test_macos_cli_sem_curl_nem_wget_falha() {
    printf '\n== injecao (Darwin): sem curl nem wget, falha em vez de travar ==\n'
    fixture_setup Darwin
    MACOS_ARCH="arm64"

    have() { return 1; }
    assert_false "ensure_equilotl_cli falha sem um jeito de baixar" ensure_equilotl_cli
    unset -f have

    MACOS_ARCH=""
    fixture_teardown
}

test_macos_cli_contrato_de_variaveis() {
    printf '\n== injecao (Darwin): variaveis de ambiente do contrato do wrapper ==\n'
    fixture_setup Darwin
    MACOS_ARCH="arm64"

    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local cache="$HOME/Library/Caches/StreamFix/EquilotlCli-arm64"
    mkdir -p "$(dirname "$cache")"
    printf '#!/bin/sh\n' > "$cache"
    chmod +x "$cache"

    local capturado=""
    macos_exec_equilotl_cli() {
        capturado="USER_DATA=$EQUICORD_USER_DATA_DIR DIRECTORY=$EQUICORD_DIRECTORY DEV_INSTALL=$EQUICORD_DEV_INSTALL LOC=$2"
    }

    macos_run_inject_cli "$checkout" "$FS_PREFIX/Applications/Discord.app"

    assert_eq "as tres variaveis do contrato e o --location chegam certas" \
        "USER_DATA=$checkout DIRECTORY=$checkout/dist/desktop DEV_INSTALL=1 LOC=$FS_PREFIX/Applications/Discord.app" \
        "$capturado"

    unset -f macos_exec_equilotl_cli
    MACOS_ARCH=""
    fixture_teardown
}

test_macos_cli_sem_location_nao_roda() {
    printf '\n== injecao (Darwin): sem --location explicito, nao tenta rodar ==\n'
    fixture_setup Darwin

    assert_false "macos_run_inject_cli recusa sem um --location explicito" \
        macos_run_inject_cli "$HOME/Equicord" ""

    fixture_teardown
}

test_macos_so_equicord_tem_cli() {
    printf '\n== injecao (Darwin): so o Equicord tem build de linha de comando ==\n'
    fixture_setup Darwin

    local equicord="$HOME/Equicord" vencord="$HOME/Vencord"
    make_checkout "$equicord" "equicord"
    make_checkout "$vencord" "vencord"

    assert_true "Equicord tem CLI no macOS" macos_has_cli_installer "$equicord"
    assert_false "Vencord nao tem CLI no macOS (so publica o zip GUI)" macos_has_cli_installer "$vencord"

    fixture_teardown
}

test_macos_run_inject_tenta_cli_primeiro_para_equicord() {
    printf '\n== injecao (Darwin): Equicord tenta o CLI antes da janela ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    mkdir -p "$resources"

    local cli_chamado=0 gui_chamado=0
    macos_run_inject_cli() { cli_chamado=1; make_injected "$resources" "$checkout"; return 0; }
    run_inject() { gui_chamado=1; }

    macos_run_inject "$checkout" "$bundle" >/dev/null 2>&1

    assert_eq "tenta o build de linha de comando" "1" "$cli_chamado"
    assert_eq "nao abre a janela quando o build de linha de comando pega" "0" "$gui_chamado"

    unset -f macos_run_inject_cli run_inject
    fixture_teardown
}

test_macos_run_inject_pula_cli_para_vencord() {
    printf '\n== injecao (Darwin): Vencord vai direto pra janela ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Vencord"
    make_checkout "$checkout" "vencord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    mkdir -p "$resources"

    local cli_chamado=0 gui_chamado=0
    macos_run_inject_cli() { cli_chamado=1; return 1; }
    run_inject() { gui_chamado=1; make_injected "$resources" "$checkout"; }

    macos_run_inject "$checkout" "$bundle" >/dev/null 2>&1

    assert_eq "nao tenta o build de linha de comando (Vencord nao tem CLI no macOS)" "0" "$cli_chamado"
    assert_eq "abre a janela do instalador direto" "1" "$gui_chamado"

    unset -f macos_run_inject_cli run_inject
    fixture_teardown
}

test_macos_run_inject_explica_o_clique_para_vencord() {
    printf '\n== injecao (Darwin): antes da janela, explica o que clicar ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Vencord"
    make_checkout "$checkout" "vencord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    mkdir -p "$resources"

    run_inject() { make_injected "$resources" "$checkout"; }

    local saida
    saida="$(macos_run_inject "$checkout" "$bundle" 2>&1)"

    case "$saida" in
        *Install*) assert_true "menciona o botao Install" true ;;
        *) assert_true "menciona o botao Install" false ;;
    esac
    case "$saida" in
        *Discord.app*) assert_true "menciona o bundle certo para escolher na lista" true ;;
        *) assert_true "menciona o bundle certo para escolher na lista" false ;;
    esac

    unset -f run_inject
    fixture_teardown
}

test_macos_run_inject_degrada_quando_cli_falha() {
    printf '\n== injecao (Darwin): download do CLI falhando degrada pra janela, nao aborta ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    mkdir -p "$resources"

    local gui_chamado=0
    macos_run_inject_cli() { return 1; }
    run_inject() { gui_chamado=1; make_injected "$resources" "$checkout"; }

    assert_true "macos_run_inject nao aborta quando o download do CLI falha" \
        macos_run_inject "$checkout" "$bundle"
    assert_eq "cai para a janela do instalador do mod" "1" "$gui_chamado"

    unset -f macos_run_inject_cli run_inject
    fixture_teardown
}

test_macos_permissao_alvo_de_sistema() {
    printf '\n== injecao (Darwin): distincao usuario/sistema para a mensagem de permissao ==\n'
    fixture_setup Darwin

    assert_true "bundle em /Applications e alvo de sistema" \
        macos_is_system_target "$FS_PREFIX/Applications/Discord.app"
    assert_false "bundle em ~/Applications nao e alvo de sistema" \
        macos_is_system_target "$HOME/Applications/Discord.app"

    fixture_teardown
}

test_macos_mensagem_permissao_cobre_as_duas_causas() {
    printf '\n== injecao (Darwin): mensagem de falha de permissao cobre as duas causas ==\n'
    fixture_setup Darwin

    local msg
    msg="$(macos_permission_failure_message "$FS_PREFIX/Applications/Discord.app")"
    case "$msg" in
        *"administrador"*"Gerenciamento de Apps"*)
            assert_true "menciona conta sem admin e a permissao de Gerenciamento de Apps" true
            ;;
        *)
            assert_true "menciona conta sem admin e a permissao de Gerenciamento de Apps" false
            ;;
    esac

    fixture_teardown
}

# ------------------------------------------------------------- desinstalacao/restauracao: macOS

test_macos_uninject_cli_contrato_de_variaveis() {
    printf '\n== desinstalacao (Darwin): variaveis de ambiente e flag --uninstall no contrato ==\n'
    fixture_setup Darwin
    MACOS_ARCH="arm64"

    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local cache="$HOME/Library/Caches/StreamFix/EquilotlCli-arm64"
    mkdir -p "$(dirname "$cache")"
    printf '#!/bin/sh\n' > "$cache"
    chmod +x "$cache"

    local capturado=""
    macos_exec_equilotl_cli() {
        capturado="USER_DATA=$EQUICORD_USER_DATA_DIR DIRECTORY=$EQUICORD_DIRECTORY DEV_INSTALL=$EQUICORD_DEV_INSTALL LOC=$2 FLAG=$3"
    }

    macos_run_uninject_cli "$checkout" "$FS_PREFIX/Applications/Discord.app"

    assert_eq "as tres variaveis do contrato, o --location e o --uninstall chegam certos" \
        "USER_DATA=$checkout DIRECTORY=$checkout/dist/desktop DEV_INSTALL=1 LOC=$FS_PREFIX/Applications/Discord.app FLAG=--uninstall" \
        "$capturado"

    unset -f macos_exec_equilotl_cli
    MACOS_ARCH=""
    fixture_teardown
}

test_macos_run_inject_cli_ainda_manda_install() {
    printf '\n== injecao (Darwin): macos_run_inject_cli continua mandando --install (regressao) ==\n'
    fixture_setup Darwin
    MACOS_ARCH="arm64"

    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local cache="$HOME/Library/Caches/StreamFix/EquilotlCli-arm64"
    mkdir -p "$(dirname "$cache")"
    printf '#!/bin/sh\n' > "$cache"
    chmod +x "$cache"

    # Roda numa subshell com o instalador resourced de novo: outros testes deste arquivo
    # substituem macos_run_inject_cli por um espiao e terminam com "unset -f", que apaga a
    # funcao de verdade para o resto do processo (nao a restaura). Isolando aqui, este teste
    # nao depende de rodar antes deles.
    local flag_capturado
    flag_capturado="$(
        source "$INSTALLER"
        FS_PREFIX="$FS_PREFIX" HOME="$HOME" OS_NAME="Darwin" MACOS_ARCH="arm64"
        macos_exec_equilotl_cli() { printf '%s' "$3"; }
        macos_run_inject_cli "$checkout" "$FS_PREFIX/Applications/Discord.app"
    )"

    assert_eq "macos_run_inject_cli manda --install, nao --uninstall" "--install" "$flag_capturado"

    MACOS_ARCH=""
    fixture_teardown
}

test_macos_run_uninject_tenta_cli_primeiro_para_equicord() {
    printf '\n== desinstalacao (Darwin): Equicord tenta o CLI antes da janela ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    make_injected "$resources" "$checkout"

    local cli_chamado=0 gui_chamado=0
    macos_run_uninject_cli() { cli_chamado=1; rm -rf "$resources"; make_asar "$resources"; return 0; }
    run_inject() { gui_chamado=1; }

    macos_run_uninject "$checkout" "$bundle" >/dev/null 2>&1

    assert_eq "tenta o build de linha de comando" "1" "$cli_chamado"
    assert_eq "nao abre a janela quando o build de linha de comando desfaz" "0" "$gui_chamado"
    assert_false "checkout deixou de estar injetado" injected_from_checkout "$checkout"

    unset -f macos_run_uninject_cli run_inject
    fixture_teardown
}

test_macos_run_uninject_pula_cli_para_vencord() {
    printf '\n== desinstalacao (Darwin): Vencord vai direto pra janela ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Vencord"
    make_checkout "$checkout" "vencord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    make_injected "$resources" "$checkout"

    local cli_chamado=0
    macos_run_uninject_cli() { cli_chamado=1; return 1; }

    macos_run_uninject "$checkout" "$bundle" >/dev/null 2>&1

    assert_eq "nao tenta o build de linha de comando (Vencord nao tem CLI no macOS)" "0" "$cli_chamado"

    unset -f macos_run_uninject_cli
    fixture_teardown
}

test_macos_bundle_for_checkout() {
    printf '\n== restauracao (Darwin): resolve o bundle a partir do checkout injetado ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"
    local bundle="$FS_PREFIX/Applications/Discord PTB.app"
    make_injected "$bundle/Contents/Resources" "$checkout"

    assert_eq "acha o bundle certo (o canal PTB, nao qualquer um)" \
        "$bundle" "$(macos_bundle_for_checkout "$checkout")"

    fixture_teardown
}

test_macos_bundle_for_checkout_sem_injecao() {
    printf '\n== restauracao (Darwin): sem injecao, nao ha bundle para resolver ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"

    assert_false "macos_bundle_for_checkout falha sem injecao" macos_bundle_for_checkout "$checkout"

    fixture_teardown
}

test_macos_discord_running_por_canal() {
    printf '\n== fechar/reabrir (Darwin): macos_discord_running distingue canal pelo caminho do bundle ==\n'
    fixture_setup Darwin

    pgrep() {
        case "$*" in *"Discord PTB.app"*) return 0 ;; *) return 1 ;; esac
    }

    assert_true "acha o processo do canal PTB" \
        macos_discord_running "$FS_PREFIX/Applications/Discord PTB.app"
    assert_false "nao confunde com o canal estavel" \
        macos_discord_running "$FS_PREFIX/Applications/Discord.app"

    unset -f pgrep
    fixture_teardown
}

# --------------------------------------------------------------------- identificacao de mod

test_checkout_mod() {
    printf '\n== identificacao: qual mod um checkout e ==\n'
    fixture_setup

    make_checkout "$HOME/a" "equicord"
    assert_eq "package.json com name equicord" "Equicord" "$(checkout_mod "$HOME/a")"

    make_checkout "$HOME/b" "vencord"
    assert_eq "package.json com name vencord" "Vencord" "$(checkout_mod "$HOME/b")"

    # Pasta com nome que nao diz nada (quem baixou o ZIP do GitHub, ex.: Equicord-main):
    # a identidade vem do package.json, nao do nome da pasta.
    make_checkout "$HOME/Equicord-main" "equicord"
    assert_eq "nome da pasta nao importa quando o package.json responde" \
        "Equicord" "$(checkout_mod "$HOME/Equicord-main")"

    fixture_teardown
}

# ------------------------------------------------------------- modo temporario: elegibilidade

test_select_persistence_nega_temporario_vencord_macos() {
    printf '\n== modo temporario (Darwin): nao oferece a escolha para Vencord ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Vencord"
    make_checkout "$checkout" "vencord"

    # Stdin fechado (< /dev/null): se a elegibilidade nao fosse checada antes do "read", a
    # pergunta bateria em EOF em vez de devolver "permanente" silenciosamente, e o teste pegaria
    # a diferenca pelo codigo de saida.
    assert_true "decide sozinho por permanente, sem perguntar" \
        select_persistence "$checkout" < /dev/null

    fixture_teardown
}

test_select_persistence_oferece_temporario_equicord_macos() {
    printf '\n== modo temporario (Darwin): oferece a escolha para Equicord ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"

    local rc=0
    printf '2\n' | select_persistence "$checkout" >/dev/null 2>&1 || rc=$?
    assert_eq "escolher [2] devolve temporario (saida 1)" "1" "$rc"

    fixture_teardown
}

# ------------------------------------------------------------- instalacao sem perguntas (--yes)

test_do_install_falha_cedo_vencord_macos_assume_yes() {
    printf '\n== instalacao (Darwin): --yes com Vencord falha cedo, antes de compilar ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Vencord"
    make_checkout "$checkout" "vencord"

    select_target() { printf '%s\n' "$checkout"; }
    # Se o guard nao barrar antes, o fluxo chegaria aqui: o sentinela na saida denuncia isso.
    ensure_toolchain() { fail "NAO_DEVERIA_CHEGAR_AQUI"; }

    local prev="$ASSUME_YES" rc=0 saida
    ASSUME_YES=1
    saida="$(do_install "$checkout" </dev/null 2>&1)"; rc=$?
    ASSUME_YES="$prev"

    assert_eq "sai com erro" "1" "$rc"
    case "$saida" in
        *NAO_DEVERIA_CHEGAR_AQUI*) assert_true "nao chega a instalar o toolchain" false ;;
        *) assert_true "nao chega a instalar o toolchain" true ;;
    esac
    case "$saida" in
        *"--yes"*) assert_true "explica que o modo --yes nao tem quem clique na janela" true ;;
        *) assert_true "explica que o modo --yes nao tem quem clique na janela" false ;;
    esac

    unset -f select_target ensure_toolchain
    fixture_teardown
}

test_do_install_nao_falha_cedo_vencord_ja_injetado_macos_assume_yes() {
    printf '\n== instalacao (Darwin): --yes com Vencord ja injetado so reinicia, sem barrar ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Vencord"
    make_checkout "$checkout" "vencord"
    local bundle="$FS_PREFIX/Applications/Discord.app"
    local resources="$bundle/Contents/Resources"
    make_injected "$resources" "$checkout"

    select_target() { printf '%s\n' "$checkout"; }
    select_proxy() { printf '\n'; }
    # Um checkout ja injetado nunca chega perto da janela do instalador do mod (do_install so
    # reinicia o Discord nesse caso); o sentinela confere que o guard nao barra sem necessidade.
    macos_ensure_wireguard() { fail "CHEGOU_NO_TUNEL"; }

    local prev="$ASSUME_YES" saida
    ASSUME_YES=1
    saida="$(do_install "$checkout" </dev/null 2>&1)"
    ASSUME_YES="$prev"

    case "$saida" in
        *CHEGOU_NO_TUNEL*) assert_true "nao barra um Vencord ja injetado (nao precisaria da janela)" true ;;
        *) assert_true "nao barra um Vencord ja injetado (nao precisaria da janela)" false ;;
    esac

    unset -f select_target macos_ensure_wireguard
    fixture_teardown
}

test_do_install_nao_falha_cedo_equicord_macos_assume_yes() {
    printf '\n== instalacao (Darwin): --yes com Equicord segue normal (tem CLI) ==\n'
    fixture_setup Darwin
    local checkout="$HOME/Equicord"
    make_checkout "$checkout" "equicord"

    select_target() { printf '%s\n' "$checkout"; }
    select_proxy() { printf '\n'; }
    # Marca que o fluxo normal seguiu ate aqui, sem rodar pnpm de verdade.
    macos_ensure_wireguard() { fail "CHEGOU_NO_TUNEL"; }

    local prev="$ASSUME_YES" saida
    ASSUME_YES=1
    saida="$(do_install "$checkout" </dev/null 2>&1)"
    ASSUME_YES="$prev"

    case "$saida" in
        *CHEGOU_NO_TUNEL*) assert_true "nao barra o Equicord (tem build de linha de comando)" true ;;
        *) assert_true "nao barra o Equicord (tem build de linha de comando)" false ;;
    esac

    unset -f select_target macos_ensure_wireguard
    fixture_teardown
}

# ------------------------------------------------------------ toolchain (Darwin): git e Node

# Simula "command -v git" resolvendo para o caminho passado, sem executar o git de verdade --
# so assim da para testar macos_git_ready() nos dois lados (stub do sistema vs. um git de
# verdade, tipo o do Homebrew) sem depender de onde o git desta maquina de teste realmente
# mora. "builtin command" repassa qualquer outro uso para o builtin de verdade.
stub_git_path() {
    GIT_PATH="$1"
    # shellcheck disable=SC2317
    command() {
        if [ "$1" = "-v" ] && [ "$2" = "git" ]; then
            [ -n "$GIT_PATH" ] && printf '%s\n' "$GIT_PATH"
            return 0
        fi
        builtin command "$@"
    }
}

test_macos_missing_tools_detecta_git_sem_clt() {
    printf '\n== toolchain (Darwin): sem as ferramentas de linha de comando, falta git ==\n'
    fixture_setup Darwin
    xcode-select() { return 1; }
    have() { [ "$1" = "node" ]; }
    stub_git_path "/usr/bin/git"

    assert_eq "macos_missing_tools reporta git, nao 'command -v git'" "git" "$(macos_missing_tools)"

    unset -f xcode-select have command
    fixture_teardown
}

test_macos_missing_tools_git_do_homebrew_sem_clt_nao_falta() {
    printf '\n== toolchain (Darwin): git do Homebrew sem CLT ja e suficiente ==\n'
    fixture_setup Darwin
    xcode-select() { return 1; }
    have() { [ "$1" = "node" ]; }
    stub_git_path "/opt/homebrew/bin/git"

    assert_eq "macos_missing_tools nao reporta git quando ele nao e o stub do sistema" "" "$(macos_missing_tools)"

    unset -f xcode-select have command
    fixture_teardown
}

test_macos_missing_tools_detecta_node() {
    printf '\n== toolchain (Darwin): sem node, falta node ==\n'
    fixture_setup Darwin
    xcode-select() { return 0; }
    have() { [ "$1" != "node" ]; }

    assert_eq "macos_missing_tools reporta node" "node" "$(macos_missing_tools)"

    unset -f xcode-select have
    fixture_teardown
}

test_macos_missing_tools_nada_faltando() {
    printf '\n== toolchain (Darwin): git e node presentes, nada falta ==\n'
    fixture_setup Darwin
    xcode-select() { return 0; }
    have() { return 0; }

    assert_eq "macos_missing_tools nao reporta nada" "" "$(macos_missing_tools)"

    unset -f xcode-select have
    fixture_teardown
}

test_macos_ensure_toolchain_sem_homebrew_mostra_linha_oficial_e_para() {
    printf '\n== toolchain (Darwin): sem Homebrew, mostra a linha oficial e para ==\n'
    fixture_setup Darwin
    xcode-select() { return 1; }
    have() { case "$1" in node) return 0 ;; *) return 1 ;; esac; }
    stub_git_path "/usr/bin/git"

    local rc=0 saida
    saida="$(macos_ensure_git_and_node </dev/null 2>&1)"; rc=$?

    assert_eq "sai com erro" "1" "$rc"
    case "$saida" in
        *"Homebrew/install"*) assert_true "mostra a linha oficial de instalacao do Homebrew" true ;;
        *) assert_true "mostra a linha oficial de instalacao do Homebrew" false ;;
    esac

    unset -f xcode-select have command
    fixture_teardown
}

test_macos_ensure_toolchain_nega_confirmacao_nao_instala() {
    printf '\n== toolchain (Darwin): recusando a confirmacao, nao instala nada ==\n'
    fixture_setup Darwin
    xcode-select() { return 1; }
    have() { case "$1" in node) return 0 ;; brew) return 0 ;; *) return 1 ;; esac; }
    stub_git_path "/usr/bin/git"
    brew() { printf 'BREW_CALLED\n' >&2; return 0; }

    local rc=0 saida
    saida="$(printf 'n\n' | macos_ensure_git_and_node 2>&1)"; rc=$?

    assert_eq "sai com erro" "1" "$rc"
    case "$saida" in
        *BREW_CALLED*) assert_true "nao roda brew install sem confirmacao" false ;;
        *) assert_true "nao roda brew install sem confirmacao" true ;;
    esac

    unset -f xcode-select have brew command
    fixture_teardown
}

test_macos_ensure_toolchain_assume_yes_nao_pergunta_e_instala() {
    printf '\n== toolchain (Darwin): --yes nao pergunta e instala com o Homebrew ==\n'
    fixture_setup Darwin
    xcode-select() { return 1; }
    have() { case "$1" in node) return 0 ;; brew) return 0 ;; *) return 1 ;; esac; }
    stub_git_path "/usr/bin/git"
    brew() { printf 'BREW_CALLED\n' >&2; return 0; }

    local prev="$ASSUME_YES" saida
    ASSUME_YES=1
    saida="$(macos_ensure_git_and_node </dev/null 2>&1)"
    ASSUME_YES="$prev"

    case "$saida" in
        *BREW_CALLED*) assert_true "roda brew install sem perguntar, como as outras confirmacoes em --yes" true ;;
        *) assert_true "roda brew install sem perguntar, como as outras confirmacoes em --yes" false ;;
    esac

    unset -f xcode-select have brew command
    fixture_teardown
}

test_macos_ensure_toolchain_clt_ainda_falta_falha_com_mensagem_clara() {
    printf '\n== toolchain (Darwin): CLT ainda ausente depois do brew, falha em vez de travar ==\n'
    fixture_setup Darwin
    # xcode-select nunca "resolve" nesta simulacao, e o brew install nao move o git do lugar --
    # reproduz a maquina em que o brew install do git nao basta porque o git que sobra ainda e
    # o stub do sistema, sem as ferramentas de linha de comando do Xcode por tras.
    xcode-select() { return 1; }
    have() { case "$1" in node) return 0 ;; brew) return 0 ;; *) return 1 ;; esac; }
    stub_git_path "/usr/bin/git"
    brew() { return 0; }

    local prev="$ASSUME_YES" rc=0 saida
    ASSUME_YES=1
    saida="$(macos_ensure_git_and_node </dev/null 2>&1)"; rc=$?
    ASSUME_YES="$prev"

    assert_eq "sai com erro em vez de travar" "1" "$rc"
    case "$saida" in
        *"dialogo"*) assert_true "explica o dialogo grafico em vez de so travar" true ;;
        *) assert_true "explica o dialogo grafico em vez de so travar" false ;;
    esac

    unset -f xcode-select have brew command
    fixture_teardown
}

test_macos_ensure_toolchain_brew_resolve_git_mesmo_sem_clt() {
    printf '\n== toolchain (Darwin): brew install git basta mesmo sem as CLT ==\n'
    fixture_setup Darwin
    # As ferramentas de linha de comando do Xcode nunca aparecem nesta simulacao, mas o brew
    # install troca o git que "command -v" acha pelo do Homebrew -- que nao e o stub do
    # sistema, e por isso nao precisa das CLT. Regressao do bug em que o instalador so conferia
    # xcode-select -p depois do brew install e falhava mesmo com um git ja funcionando.
    xcode-select() { return 1; }
    have() { case "$1" in node) return 0 ;; brew) return 0 ;; *) return 1 ;; esac; }
    stub_git_path "/usr/bin/git"
    brew() { GIT_PATH="/opt/homebrew/bin/git"; return 0; }

    local prev="$ASSUME_YES" rc=0 saida
    ASSUME_YES=1
    saida="$(macos_ensure_git_and_node </dev/null 2>&1)"; rc=$?
    ASSUME_YES="$prev"

    assert_eq "termina sem erro: o git do Homebrew ja basta" "0" "$rc"

    unset -f xcode-select have brew command
    fixture_teardown
}

test_macos_ensure_toolchain_node_some_do_path_apos_brew() {
    printf '\n== toolchain (Darwin): Node continua fora do PATH depois do brew, mensagem clara ==\n'
    fixture_setup Darwin
    xcode-select() { return 0; }
    have() { case "$1" in brew) return 0 ;; *) return 1 ;; esac; }
    brew() { return 0; }

    local prev="$ASSUME_YES" rc=0 saida
    ASSUME_YES=1
    saida="$(macos_ensure_git_and_node </dev/null 2>&1)"; rc=$?
    ASSUME_YES="$prev"

    assert_eq "sai com erro" "1" "$rc"
    case "$saida" in
        *"PATH"*) assert_true "explica que o Node nao apareceu no PATH" true ;;
        *) assert_true "explica que o Node nao apareceu no PATH" false ;;
    esac

    unset -f xcode-select have brew
    fixture_teardown
}

test_macos_ensure_toolchain_sucesso_comunica_versao_minima_do_node() {
    printf '\n== toolchain (Darwin): sucesso ainda comunica a versao minima do Node ==\n'
    fixture_setup Darwin
    xcode-select() { return 0; }
    NODE_OK=0
    have() {
        case "$1" in
            node) [ "$NODE_OK" -eq 1 ] ;;
            brew) return 0 ;;
            *) return 1 ;;
        esac
    }
    brew() { NODE_OK=1; return 0; }

    local prev="$ASSUME_YES" rc=0 saida
    ASSUME_YES=1
    saida="$(macos_ensure_git_and_node </dev/null 2>&1)"; rc=$?
    ASSUME_YES="$prev"

    assert_eq "termina sem erro" "0" "$rc"
    case "$saida" in
        *"22"*) assert_true "comunica a versao minima do Node" true ;;
        *) assert_true "comunica a versao minima do Node" false ;;
    esac

    unset -f xcode-select have brew
    fixture_teardown
}

# ------------------------------------------------------------------------------- sourcing

test_guarda_de_sourcing() {
    printf '\n== seam: guarda de sourcing ==\n'
    # Stdin fechado (< /dev/null): se a guarda falhasse e o menu rodasse, o "read" do menu
    # bateria em EOF na hora em vez de travar o teste esperando por um humano.
    local saida
    saida="$(cd "$TESTS_DIR" && bash -c 'source "../streamfix-installer.sh"; echo SOURCED_OK' < /dev/null 2>&1)"
    assert_eq "carregar com source nao imprime o banner nem abre o menu" \
        "SOURCED_OK" "$saida"
}

# --------------------------------------------------------------------------- tunel ausente

# O Linux nao tem implementacao de tunel (adiado em 11/09/2026), e sem tunel o plugin nao serve
# para nada. Este teste guarda a guarda: se alguem religar a instalacao antes de o wg-quick
# existir, isto falha -- em vez de a pessoa descobrir com um plugin instalado que nao funciona.
test_recusa_de_instalacao() {
    printf '\n== instalacao recusada enquanto o tunel nao tem Linux ==\n'

    local saida codigo
    saida="$(cd "$TESTS_DIR" && bash -c 'source "../streamfix-installer.sh"; refuse_install_for_now' < /dev/null 2>&1)"
    codigo=$?

    assert_true "recusar devolve codigo de falha" [ "$codigo" -ne 0 ]
    case "$saida" in
        *tunel*) assert_true "a recusa explica que o motivo e o tunel" true ;;
        *) assert_true "a recusa explica que o motivo e o tunel" false ;;
    esac

    # do_install ainda existe, mas nada no caminho de quem instala pode chamar ela.
    local chamadas
    chamadas="$(grep -cE '^\s+(1\)|install\))\s+do_install' "$TESTS_DIR/../streamfix-installer.sh")"
    assert_eq "nenhum caminho de instalacao chama do_install" "0" "$chamadas"
}

# ------------------------------------------------------------------------------------ main

test_recusa_de_instalacao
test_pacote_nativo
test_bootstrap_usuario
test_flatpak_sistema
test_flatpak_usuario
test_discord_ja_injetado
test_mais_de_um_discord
test_nenhum_discord
test_macos_sistema
test_macos_usuario
test_macos_quatro_canais
test_macos_injetado
test_macos_sem_flatpak
test_macos_settings_path
test_macos_cli_arch
test_macos_cli_cache_path
test_macos_cli_reaproveita_cache
test_macos_cli_sem_curl_nem_wget_falha
test_macos_cli_contrato_de_variaveis
test_macos_cli_sem_location_nao_roda
test_macos_so_equicord_tem_cli
test_macos_run_inject_tenta_cli_primeiro_para_equicord
test_macos_run_inject_pula_cli_para_vencord
test_macos_run_inject_explica_o_clique_para_vencord
test_macos_run_inject_degrada_quando_cli_falha
test_macos_permissao_alvo_de_sistema
test_macos_mensagem_permissao_cobre_as_duas_causas
test_macos_uninject_cli_contrato_de_variaveis
test_macos_run_inject_cli_ainda_manda_install
test_macos_run_uninject_tenta_cli_primeiro_para_equicord
test_macos_run_uninject_pula_cli_para_vencord
test_macos_bundle_for_checkout
test_macos_bundle_for_checkout_sem_injecao
test_macos_discord_running_por_canal
test_select_persistence_nega_temporario_vencord_macos
test_select_persistence_oferece_temporario_equicord_macos
test_do_install_falha_cedo_vencord_macos_assume_yes
test_do_install_nao_falha_cedo_vencord_ja_injetado_macos_assume_yes
test_do_install_nao_falha_cedo_equicord_macos_assume_yes
test_macos_missing_tools_detecta_git_sem_clt
test_macos_missing_tools_git_do_homebrew_sem_clt_nao_falta
test_macos_missing_tools_detecta_node
test_macos_missing_tools_nada_faltando
test_macos_ensure_toolchain_sem_homebrew_mostra_linha_oficial_e_para
test_macos_ensure_toolchain_nega_confirmacao_nao_instala
test_macos_ensure_toolchain_assume_yes_nao_pergunta_e_instala
test_macos_ensure_toolchain_clt_ainda_falta_falha_com_mensagem_clara
test_macos_ensure_toolchain_brew_resolve_git_mesmo_sem_clt
test_macos_ensure_toolchain_node_some_do_path_apos_brew
test_macos_ensure_toolchain_sucesso_comunica_versao_minima_do_node
test_checkout_mod
test_guarda_de_sourcing

printf '\n%s de %s testes passaram\n' "$((TESTS_RUN - TESTS_FAILED))" "$TESTS_RUN"
[ "$TESTS_FAILED" -eq 0 ]
