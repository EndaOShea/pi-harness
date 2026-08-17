#!/usr/bin/env bash

set -Eeuo pipefail

HARNESS_ROOT="$(
    cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1
    pwd -P
)"

export PYTHONDONTWRITEBYTECODE=1

bash -n "$HARNESS_ROOT/scripts/install.sh"
bash -n "$HARNESS_ROOT/scripts/uninstall.sh"

if command -v shellcheck >/dev/null 2>&1; then
    shellcheck \
        "$HARNESS_ROOT/scripts/install.sh" \
        "$HARNESS_ROOT/scripts/uninstall.sh" \
        "$HARNESS_ROOT/scripts/validate.sh"
elif [[ "${HARNESS_REQUIRE_POLICY_INTEGRATION:-0}" == "1" ]]; then
    printf 'ERROR: shellcheck is required in strict CI validation.\n' >&2
    exit 1
else
    printf 'NOTE: shellcheck not found; static shell analysis skipped.\n'
fi

python3 -m unittest discover -s "$HARNESS_ROOT/tests" -p 'test_*.py' -v

printf '\nHarness validation passed.\n'
