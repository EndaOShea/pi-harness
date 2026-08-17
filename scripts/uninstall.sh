#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

# Remove this repository's global Pi harness installation.
#
# Removed, after verifying harness ownership of each item:
#   - the AGENTS.md link and curated resource links that resolve into this
#     checkout;
#   - permission-module copies that are byte-identical to this checkout;
#   - harness-registered resource paths and skill exclusions in settings.json;
#   - required MCP servers whose installed definition exactly matches
#     config/required-mcp.json (extended or conflicting definitions are kept).
#
# Never touched: Pi packages, authentication, secrets, sessions, backups,
# project-local configuration, and any file this harness cannot prove it owns.

DRY_RUN=0
KEEP_MCP=0
BACKUP_CREATED=0
WARNINGS=0

usage() {
    cat <<'EOF'
Usage: ./scripts/uninstall.sh [options]

Options:
  --dry-run    Show the exact planned removals without changing files.
  --keep-mcp   Leave Pi's MCP override untouched.
  -h, --help   Show this help message.

Environment:
  PI_AGENT_DIR Override the Pi agent directory (default: ~/.pi/agent).

Pinned Pi packages are not uninstalled; remove them with 'pi' directly if
desired. Existing backups are never touched.
EOF
}

while (($# > 0)); do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            ;;
        --keep-mcp)
            KEEP_MCP=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown option: %s\n\n' "$1" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

HARNESS_ROOT="$(
    cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1
    pwd -P
)"

PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS_FILE="$PI_AGENT_DIR/settings.json"
RESOURCE_MANIFEST="$HARNESS_ROOT/config/resources.json"
SETTINGS_DEFAULTS_FILE="$HARNESS_ROOT/config/settings-defaults.json"
REQUIRED_MCP_FILE="$HARNESS_ROOT/config/required-mcp.json"
SOURCE_PERMISSIONS="$HARNESS_ROOT/permissions"

TARGET_AGENTS="$PI_AGENT_DIR/AGENTS.md"
TARGET_EXTENSIONS="$PI_AGENT_DIR/extensions"
TARGET_PERMISSIONS="$PI_AGENT_DIR/permissions"
TARGET_HARNESS_ROOT="$PI_AGENT_DIR/harness"
TARGET_MCP_FILE="$PI_AGENT_DIR/mcp.json"
MANAGED_STATE_HELPER="$HARNESS_ROOT/scripts/lib/managed_state.py"

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_DIR="$PI_AGENT_DIR/backups/harness-uninstall-$TIMESTAMP-$$"

log() {
    printf '\n==> %s\n' "$1"
}

info() {
    printf '    %s\n' "$1"
}

warn() {
    printf 'WARNING: %s\n' "$1" >&2
    WARNINGS=$((WARNINGS + 1))
}

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

managed_state() {
    python3 "$MANAGED_STATE_HELPER" "$@" \
        --harness-root "$HARNESS_ROOT" \
        --agent-dir "$PI_AGENT_DIR"
}

validate_json_object_if_present() {
    local path="$1"
    local description="$2"
    [[ -e "$path" || -L "$path" ]] || return 0

    python3 - "$path" "$description" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1]).expanduser()
description = sys.argv[2]
try:
    value = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid {description} JSON in {path}: {exc}") from exc
if not isinstance(value, dict):
    raise SystemExit(f"Expected {description} to be a JSON object: {path}")
PY
}

load_resource_targets() {
    RESOURCE_TARGETS="$(
        RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
        TARGET_HARNESS_ROOT="$TARGET_HARNESS_ROOT" \
            python3 <<'PY'
import json
import os
from pathlib import Path

manifest = json.loads(
    Path(os.environ["RESOURCE_MANIFEST"]).read_text(encoding="utf-8")
)
target_root = Path(os.environ["TARGET_HARNESS_ROOT"]).expanduser()
for kind in ("skills", "prompts"):
    for entry in manifest[kind]:
        print(target_root / kind / entry["name"])
PY
    )" || fail "Could not read the resource manifest."
}

preflight_uninstall() {
    validate_json_object_if_present "$SETTINGS_FILE" "Pi settings"
    validate_json_object_if_present "$TARGET_MCP_FILE" "Pi MCP override"
    local args=(preflight-uninstall --backup-dir "$BACKUP_DIR")
    ((KEEP_MCP)) && args+=(--keep-mcp)
    managed_state "${args[@]}"
}

apply_receipt_uninstall() {
    local args=(apply-uninstall --backup-dir "$BACKUP_DIR")
    ((DRY_RUN)) && args+=(--dry-run)
    ((KEEP_MCP)) && args+=(--keep-mcp)
    managed_state "${args[@]}"

    if ((!DRY_RUN)) && [[ -d "$BACKUP_DIR" ]]; then
        BACKUP_CREATED=1
    fi
}

on_error() {
    local exit_code=$?
    local line_number="${BASH_LINENO[0]:-${LINENO}}"
    printf 'ERROR: uninstaller failed at line %s with exit code %s\n' \
        "$line_number" "$exit_code" >&2
    exit "$exit_code"
}

trap on_error ERR

run() {
    if ((DRY_RUN)); then
        printf 'DRY-RUN:'
        printf ' %q' "$@"
        printf '\n'
    else
        "$@"
    fi
}

path_exists() {
    [[ -e "$1" || -L "$1" ]]
}

canonical_path() {
    python3 - "$1" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).expanduser().resolve(strict=False))
PY
}

ensure_backup_dir() {
    ((DRY_RUN)) && return 0
    if ((BACKUP_CREATED == 0)); then
        mkdir -p "$BACKUP_DIR"
        BACKUP_CREATED=1
    fi
}

remove_harness_link() {
    local target="$1"
    local description="$2"

    path_exists "$target" || return 0

    if [[ ! -L "$target" ]]; then
        warn "$description is not a symlink; leaving it in place: $target"
        return 0
    fi

    local target_canonical
    target_canonical="$(canonical_path "$target")"
    case "$target_canonical" in
        "$HARNESS_ROOT"/*|"$HARNESS_ROOT")
            run rm "$target"
            info "Removed link: $target"
            ;;
        *)
            warn "$description does not resolve into this checkout; leaving it in place: $target"
            ;;
    esac
}

remove_permission_copies() {
    [[ -d "$TARGET_PERMISSIONS" ]] || return 0
    log "Removing harness permission modules"

    local permission_file
    local permission_relative
    local installed
    while IFS= read -r -d '' permission_file; do
        permission_relative="${permission_file#"$SOURCE_PERMISSIONS/"}"
        installed="$TARGET_PERMISSIONS/$permission_relative"
        path_exists "$installed" || continue
        if [[ -L "$installed" ]]; then
            remove_harness_link "$installed" "Permission module"
        elif cmp -s "$permission_file" "$installed"; then
            run rm "$installed"
            info "Removed copy: $installed"
        else
            warn "Permission module differs from this checkout; leaving it in place: $installed"
        fi
    done < <(
        find "$SOURCE_PERMISSIONS" \
            -mindepth 1 -type f \
            \( -name '*.ts' -o -name '*.js' \) -print0
    )
}

remove_managed_links() {
    log "Removing harness-managed links"
    remove_harness_link "$TARGET_AGENTS" "Global AGENTS.md"

    local resource_target
    while IFS= read -r resource_target; do
        [[ -n "$resource_target" ]] || continue
        remove_harness_link "$resource_target" "Harness resource"
    done <<<"$RESOURCE_TARGETS"

    if [[ -d "$TARGET_EXTENSIONS" ]]; then
        local extension
        while IFS= read -r -d '' extension; do
            [[ -L "$extension" ]] || continue
            remove_harness_link "$extension" "Harness extension"
        done < <(
            find "$TARGET_EXTENSIONS" -mindepth 1 -maxdepth 1 -print0
        )
    fi
}

remove_empty_managed_directories() {
    local directory
    for directory in \
        "$TARGET_HARNESS_ROOT/skills" \
        "$TARGET_HARNESS_ROOT/prompts" \
        "$TARGET_HARNESS_ROOT" \
        "$TARGET_PERMISSIONS/lib" \
        "$TARGET_PERMISSIONS" \
        "$TARGET_EXTENSIONS"; do
        if [[ -d "$directory" && ! -L "$directory" ]] &&
            ! find "$directory" -mindepth 1 -print -quit | grep -q .; then
            run rmdir "$directory"
            info "Removed empty directory: $directory"
        fi
    done
}

clean_settings() {
    [[ -f "$SETTINGS_FILE" ]] || return 0
    log "Removing harness entries from Pi settings"

    ensure_backup_dir
    if ((DRY_RUN)); then
        run cp -a "$SETTINGS_FILE" "$BACKUP_DIR/settings.json"
    elif ! path_exists "$BACKUP_DIR/settings.json"; then
        cp -a "$SETTINGS_FILE" "$BACKUP_DIR/settings.json"
        info "Pi settings backup:"
        info "  $BACKUP_DIR/settings.json"
    fi

    if ((DRY_RUN)); then
        info "Would remove harness resource paths and skill exclusions from:"
        info "  $SETTINGS_FILE"
        return 0
    fi

    SETTINGS_FILE="$SETTINGS_FILE" \
    HARNESS_ROOT="$HARNESS_ROOT" \
    RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
    SETTINGS_DEFAULTS_FILE="$SETTINGS_DEFAULTS_FILE" \
    TARGET_HARNESS_ROOT="$TARGET_HARNESS_ROOT" \
        python3 <<'PY'
import json
import os
import stat
import tempfile
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_FILE"]).expanduser()
root = Path(os.environ["HARNESS_ROOT"]).resolve()
manifest = json.loads(
    Path(os.environ["RESOURCE_MANIFEST"]).read_text(encoding="utf-8")
)
defaults = json.loads(
    Path(os.environ["SETTINGS_DEFAULTS_FILE"]).read_text(encoding="utf-8")
)["settings"]
target_root = Path(os.environ["TARGET_HARNESS_ROOT"]).expanduser()

try:
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Cannot edit invalid JSON in {settings_path}: {exc}") from exc
if not isinstance(settings, dict):
    raise SystemExit(f"Expected a JSON object in {settings_path}.")

mode = stat.S_IMODE(settings_path.stat().st_mode)

removed = []
for kind in ("skills", "prompts"):
    values = settings.get(kind)
    if not isinstance(values, list):
        continue
    managed = {str(root / kind), str(target_root / kind)}
    for entry in manifest[kind]:
        managed.add(str(target_root / kind / entry["name"]))
    if kind == "skills":
        for entry in manifest.get("skillExclusions", []):
            resolved = Path(entry["path"]).expanduser().resolve(strict=False)
            managed.add(f"-{resolved}")
    kept = [value for value in values if value not in managed]
    removed.extend(value for value in values if value in managed)
    if kept:
        settings[kind] = kept
    else:
        settings.pop(kind, None)

for kind, value in defaults.items():
    if settings.get(kind) == value:
        settings.pop(kind)
        removed.append(f"{kind} (harness default)")

with tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=settings_path.parent,
    prefix=f".{settings_path.name}.",
    suffix=".tmp",
    delete=False,
) as handle:
    json.dump(settings, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
    temporary_path = Path(handle.name)

temporary_path.chmod(mode)
os.replace(temporary_path, settings_path)
for value in removed:
    print(f"Removed settings entry: {value}")
print(f"Updated {settings_path}")
PY
}

clean_required_mcp() {
    if ((KEEP_MCP)); then
        log "Keeping Pi MCP override untouched"
        return 0
    fi
    [[ -f "$TARGET_MCP_FILE" ]] || return 0
    log "Removing harness-required MCP servers"

    local removable
    removable="$(
        REQUIRED_MCP_FILE="$REQUIRED_MCP_FILE" \
        TARGET_MCP_FILE="$TARGET_MCP_FILE" \
            python3 <<'PY'
import json
import os
from pathlib import Path

required = json.loads(
    Path(os.environ["REQUIRED_MCP_FILE"]).read_text(encoding="utf-8")
)
target_path = Path(os.environ["TARGET_MCP_FILE"]).expanduser()
try:
    existing = json.loads(target_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Cannot edit invalid JSON in {target_path}: {exc}") from exc
existing_servers = existing.get("mcpServers") or {}

for name, server in required["mcpServers"].items():
    installed = existing_servers.get(name)
    if installed is None:
        continue
    if installed == server:
        print(f"remove\t{name}")
    else:
        print(f"keep\t{name}")
PY
    )" || fail "Could not compare the Pi MCP override."

    local action
    local name
    local to_remove=()
    while IFS=$'\t' read -r action name; do
        [[ -n "$action" ]] || continue
        if [[ "$action" == "remove" ]]; then
            to_remove+=("$name")
        else
            warn "MCP server '$name' was extended or changed by the user; leaving it in place."
        fi
    done <<<"$removable"

    if ((${#to_remove[@]} == 0)); then
        info "No unmodified harness-required MCP servers to remove."
        return 0
    fi

    ensure_backup_dir
    if ((DRY_RUN)); then
        run cp -a "$TARGET_MCP_FILE" "$BACKUP_DIR/mcp.json"
        local server_name
        for server_name in "${to_remove[@]}"; do
            info "Would remove MCP server: $server_name"
        done
        return 0
    fi

    if ! path_exists "$BACKUP_DIR/mcp.json"; then
        cp -a "$TARGET_MCP_FILE" "$BACKUP_DIR/mcp.json"
        info "Pi MCP configuration backup:"
        info "  $BACKUP_DIR/mcp.json"
    fi

    TARGET_MCP_FILE="$TARGET_MCP_FILE" \
    REMOVE_SERVERS="$(printf '%s\n' "${to_remove[@]}")" \
        python3 <<'PY'
import json
import os
import stat
import tempfile
from pathlib import Path

target_path = Path(os.environ["TARGET_MCP_FILE"]).expanduser()
names = [name for name in os.environ["REMOVE_SERVERS"].splitlines() if name]
existing = json.loads(target_path.read_text(encoding="utf-8"))
servers = existing.get("mcpServers") or {}
mode = stat.S_IMODE(target_path.stat().st_mode)

for name in names:
    servers.pop(name, None)
    print(f"Removed MCP server: {name}")
if servers:
    existing["mcpServers"] = servers
else:
    existing.pop("mcpServers", None)

with tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=target_path.parent,
    prefix=f".{target_path.name}.",
    suffix=".tmp",
    delete=False,
) as handle:
    json.dump(existing, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
    temporary_path = Path(handle.name)

temporary_path.chmod(mode)
os.replace(temporary_path, target_path)
print(f"Updated {target_path}")
PY
}

print_summary() {
    log "Pi harness uninstall complete"
    info "Pi agent directory:"
    info "  $PI_AGENT_DIR"
    info ""
    info "Pinned Pi packages were not uninstalled; remove them with 'pi' if desired."
    info "Existing backups were not touched."
    if ((BACKUP_CREATED)); then
        info ""
        info "Configuration edited during uninstall was backed up under:"
        info "  $BACKUP_DIR"
    fi
    if ((WARNINGS > 0)); then
        info ""
        info "$WARNINGS item(s) were left in place; review the warnings above."
    fi
    if ((DRY_RUN)); then
        info ""
        info "Dry run complete; no filesystem changes were made."
    fi
}

main() {
    command -v cmp >/dev/null 2>&1 || fail "Required command is not installed: cmp"
    command -v find >/dev/null 2>&1 || fail "Required command is not installed: find"
    command -v python3 >/dev/null 2>&1 || fail "Required command is not installed: python3"

    [[ -d "$PI_AGENT_DIR" ]] ||
        fail "Pi agent directory does not exist: $PI_AGENT_DIR"
    [[ -f "$RESOURCE_MANIFEST" ]] ||
        fail "Missing resource manifest: $RESOURCE_MANIFEST"
    [[ -f "$SETTINGS_DEFAULTS_FILE" ]] ||
        fail "Missing settings defaults manifest: $SETTINGS_DEFAULTS_FILE"
    [[ -f "$REQUIRED_MCP_FILE" ]] ||
        fail "Missing required MCP manifest: $REQUIRED_MCP_FILE"
    [[ -f "$MANAGED_STATE_HELPER" ]] ||
        fail "Missing managed-state helper: $MANAGED_STATE_HELPER"

    load_resource_targets
    preflight_uninstall

    local receipt_present=0
    path_exists "$TARGET_HARNESS_ROOT/.managed-state.json" && receipt_present=1
    apply_receipt_uninstall
    if ((receipt_present == 0)); then
        remove_managed_links
        remove_permission_copies
        clean_settings
        clean_required_mcp
    fi
    remove_empty_managed_directories
    print_summary
}

main "$@"
