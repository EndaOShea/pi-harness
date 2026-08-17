#!/usr/bin/env bash

set -Eeuo pipefail

# Type-check the harness's TypeScript against the real upstream types.
#
# `node --check` (in the test suite) only parses. It cannot see that a
# handler's parameter no longer matches the shape @thurstonsand/pi-permissions
# declares, or that an extension reads a field Pi stopped emitting: both load
# fine and fail at runtime. This script closes that gap.
#
# Resolution is the awkward part, so it is done here rather than committed:
#   - @thurstonsand/pi-permissions is installed by `pi install` into
#     $PI_AGENT_DIR/npm/node_modules, not into this repository;
#   - it ships raw .ts source as its types and declares
#     @earendil-works/pi-coding-agent as a peer, so that package must resolve
#     too, and it lives wherever npm's global root is;
#   - neither location is knowable at commit time.
#
# So tsconfig.json holds the machine-independent compiler options and file
# set, and this script generates a temporary overlay that extends it with the
# paths discovered on this machine. The overlay is thrown away; the reviewed
# configuration stays in Git.
#
# Exit codes:
#   0    type-check passed
#   1    type-check failed
#   127  toolchain or upstream packages unavailable (caller decides whether
#        that is a skip or an error; validate.sh treats it as an error only
#        under HARNESS_REQUIRE_POLICY_INTEGRATION=1)

HARNESS_ROOT="$(
    cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1
    pwd -P
)"

PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PI_NODE_MODULES="$PI_AGENT_DIR/npm/node_modules"
BASE_TSCONFIG="$HARNESS_ROOT/tsconfig.json"

unavailable() {
    printf 'NOTE: %s; type checking skipped.\n' "$1"
    exit 127
}

find_tsc() {
    if [[ -x "$HARNESS_ROOT/node_modules/.bin/tsc" ]]; then
        printf '%s' "$HARNESS_ROOT/node_modules/.bin/tsc"
        return 0
    fi
    if command -v tsc >/dev/null 2>&1; then
        command -v tsc
        return 0
    fi
    return 1
}

# find_in_roots <relative> <root>...
#
# Prints the first <root>/<relative> that exists, across every node_modules
# root npm and Pi use on this machine. Failing means the package is absent.
find_in_roots() {
    local relative="$1"
    shift
    local root
    for root in "$@"; do
        if [[ -e "$root/$relative" ]]; then
            printf '%s' "$root/$relative"
            return 0
        fi
    done
    return 1
}

[[ -f "$BASE_TSCONFIG" ]] || unavailable "missing $BASE_TSCONFIG"

TSC="$(find_tsc)" || unavailable "tsc is not installed or not on PATH"

GLOBAL_ROOT=""
if command -v npm >/dev/null 2>&1; then
    GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
fi
ROOTS=("$HARNESS_ROOT/node_modules" "$PI_NODE_MODULES")
[[ -n "$GLOBAL_ROOT" ]] && ROOTS+=("$GLOBAL_ROOT")

PERMISSIONS_SRC="$(
    find_in_roots "@thurstonsand/pi-permissions/src/index.ts" "${ROOTS[@]}"
)" || unavailable "@thurstonsand/pi-permissions is not installed"

# pi-permissions imports the coding agent's types from its own source, so an
# unresolved peer would report as errors inside a dependency we do not own.
CODING_AGENT_TYPES="$(
    find_in_roots "@earendil-works/pi-coding-agent/dist/index.d.ts" "${ROOTS[@]}"
)" || unavailable "@earendil-works/pi-coding-agent is not installed"

NODE_TYPES="$(find_in_roots "@types/node" "${ROOTS[@]}")" ||
    unavailable "@types/node is not installed"
TYPE_ROOT="$(dirname "$NODE_TYPES")"

OVERLAY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-harness-typecheck.XXXXXX")"
cleanup() {
    rm -rf "$OVERLAY_DIR"
}
trap cleanup EXIT

# `include` is inherited from the base config and stays anchored to the
# directory of the file that declared it, so the overlay only adds paths.
cat >"$OVERLAY_DIR/tsconfig.json" <<EOF
{
  "extends": "$BASE_TSCONFIG",
  "compilerOptions": {
    "typeRoots": ["$TYPE_ROOT"],
    "paths": {
      "@thurstonsand/pi-permissions": ["$PERMISSIONS_SRC"],
      "@earendil-works/pi-coding-agent": ["$CODING_AGENT_TYPES"]
    }
  }
}
EOF

printf 'Type-checking permissions/ and extensions/ with %s\n' "$TSC"
"$TSC" --noEmit --pretty false -p "$OVERLAY_DIR/tsconfig.json"
