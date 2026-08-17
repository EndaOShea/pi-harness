#!/usr/bin/env bash

set -Eeuo pipefail

HARNESS_ROOT="$(
    cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1
    pwd -P
)"

export PYTHONDONTWRITEBYTECODE=1

bash -n "$HARNESS_ROOT/scripts/install.sh"
bash -n "$HARNESS_ROOT/scripts/uninstall.sh"
bash -n "$HARNESS_ROOT/scripts/typecheck.sh"

if command -v shellcheck >/dev/null 2>&1; then
    shellcheck \
        "$HARNESS_ROOT/scripts/install.sh" \
        "$HARNESS_ROOT/scripts/uninstall.sh" \
        "$HARNESS_ROOT/scripts/typecheck.sh" \
        "$HARNESS_ROOT/scripts/validate.sh"
elif [[ "${HARNESS_REQUIRE_POLICY_INTEGRATION:-0}" == "1" ]]; then
    printf 'ERROR: shellcheck is required in strict CI validation.\n' >&2
    exit 1
else
    printf 'NOTE: shellcheck not found; static shell analysis skipped.\n'
fi

# The test suite parse-checks these modules; only tsc can see that a handler
# no longer matches the shape the permissions API declares. Exit 127 means
# the toolchain or an upstream package is absent, which is a skip locally and
# a failure in CI, where both are installed deliberately.
TYPECHECK_STATUS=0
"$HARNESS_ROOT/scripts/typecheck.sh" || TYPECHECK_STATUS=$?
if ((TYPECHECK_STATUS == 127)); then
    if [[ "${HARNESS_REQUIRE_POLICY_INTEGRATION:-0}" == "1" ]]; then
        printf 'ERROR: TypeScript type checking is required in strict CI validation.\n' >&2
        exit 1
    fi
elif ((TYPECHECK_STATUS != 0)); then
    exit "$TYPECHECK_STATUS"
fi

python3 -m unittest discover -s "$HARNESS_ROOT/tests" -p 'test_*.py' -v

printf '\nHarness validation passed.\n'
