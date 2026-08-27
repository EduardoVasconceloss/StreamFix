#!/usr/bin/env bash
# Teste de regressao para a guarda contra executar o instalador inteiro como root.

set -uo pipefail

TESTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$TESTS_DIR/../streamfix-installer.sh"

# Carregar o arquivo nao pode disparar a guarda: a suite principal tambem depende desse seam.
# shellcheck source=../streamfix-installer.sh
source "$INSTALLER"
set +e +o pipefail

falhou=0

assert_eq() {
    local desc="$1" esperado="$2" recebido="$3"
    if [ "$esperado" = "$recebido" ]; then
        printf '  ok - %s\n' "$desc"
    else
        falhou=1
        printf '  FALHOU - %s\n    esperado: %s\n    recebido: %s\n' "$desc" "$esperado" "$recebido"
    fi
}

printf '\n== seguranca: execucao como root ==\n'

id() { printf '0\n'; }
rc=0
saida="$(SUDO_USER=jeff ensure_not_root 2>&1)" || rc=$?
assert_eq "recusa execucao com UID 0" "1" "$rc"
case "$saida" in
    *"Nao rode o instalador inteiro com sudo"*"jeff"*)
        assert_eq "explica para repetir sem sudo como o usuario original" "1" "1"
        ;;
    *)
        assert_eq "explica para repetir sem sudo como o usuario original" "1" "0"
        ;;
esac

printf '\n== seguranca: usuario normal ==\n'

id() { printf '1000\n'; }
rc=0
ensure_not_root >/dev/null 2>&1 || rc=$?
assert_eq "permite usuario normal" "0" "$rc"

unset -f id

[ "$falhou" -eq 0 ]
