#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

# Install this repository as the current user's global Pi harness.
#
# Managed:
#   - AGENTS.md
#   - pinned Pi packages from packages/pi-packages.txt
#   - curated skills and prompts from config/resources.json
#   - permission hooks
#   - optional harness extensions
#
# Authentication, secrets, session history, and project-local configuration
# are deliberately outside this installer's scope.

DRY_RUN=0
SKIP_PACKAGES=0
SKIP_MCP=0
BACKUP_CREATED=0
BACKUP_PLANNED=0

usage() {
    cat <<'EOF'
Usage: ./scripts/install.sh [options]

Options:
  --dry-run         Show the exact planned operations without changing files
                    or invoking package installation.
  --skip-packages   Skip packages listed in packages/pi-packages.txt.
  --skip-mcp        Do not merge required servers into Pi's MCP override.
  -h, --help        Show this help message.

Environment:
  PI_AGENT_DIR      Override where this installer writes harness state
                    (default: ~/.pi/agent). This is the harness's own
                    variable; running Pi against that profile also
                    requires PI_CODING_AGENT_DIR set to the same path,
                    since Pi reads its own variable, not this one.
EOF
}

while (($# > 0)); do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            ;;
        --skip-packages)
            SKIP_PACKAGES=1
            ;;
        --skip-mcp)
            SKIP_MCP=1
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
SETTINGS_DEFAULTS_FILE="$HARNESS_ROOT/config/settings-defaults.json"
MODELS_FILE="$PI_AGENT_DIR/models.json"
MODELS_DEFAULTS_FILE="$HARNESS_ROOT/config/models-defaults.json"
PACKAGE_FILE="$HARNESS_ROOT/packages/pi-packages.txt"
RESOURCE_MANIFEST="$HARNESS_ROOT/config/resources.json"
REQUIRED_MCP_FILE="$HARNESS_ROOT/config/required-mcp.json"
NPM_ALLOW_SCRIPTS_FILE="$HARNESS_ROOT/config/npm-allow-scripts.json"

# Lowest Pi release the pinned packages are known to load under.
#
# Three pinned packages (pi-web-access, pi-subagents, pi-permissions)
# import '@earendil-works/pi-ai/compat', a subpath that first appears in
# pi-ai@0.81.0. Older releases cannot resolve it and Pi fails to start.
#
# 0.81.0 is the theoretical minimum; 0.84.1 is the version every pinned
# package was verified against. Bump this when packages are upgraded and
# re-verified.
MINIMUM_PI_VERSION="0.84.1"

SOURCE_AGENTS="$HARNESS_ROOT/AGENTS.md"
SOURCE_EXTENSIONS="$HARNESS_ROOT/extensions"
SOURCE_PERMISSIONS="$HARNESS_ROOT/permissions"

TARGET_AGENTS="$PI_AGENT_DIR/AGENTS.md"
TARGET_EXTENSIONS="$PI_AGENT_DIR/extensions"
TARGET_PERMISSIONS="$PI_AGENT_DIR/permissions"
TARGET_HARNESS_ROOT="$PI_AGENT_DIR/harness"
TARGET_MCP_FILE="$PI_AGENT_DIR/mcp.json"
TARGET_NPM_PACKAGE_FILE="$PI_AGENT_DIR/npm/package.json"
MANAGED_STATE_HELPER="$HARNESS_ROOT/scripts/lib/managed_state.py"
RECEIPT_FILE="$TARGET_HARNESS_ROOT/.managed-state.json"

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_DIR="$PI_AGENT_DIR/backups/harness-$TIMESTAMP-$$"

RESOURCE_KINDS=()
RESOURCE_NAMES=()
RESOURCE_SOURCES=()

log() {
    printf '\n==> %s\n' "$1"
}

info() {
    printf '    %s\n' "$1"
}

warn() {
    printf 'WARNING: %s\n' "$1" >&2
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

stat_mode() {
    python3 - "$1" <<'PY'
import stat
import sys
from pathlib import Path

print(f"{stat.S_IMODE(Path(sys.argv[1]).stat().st_mode):o}")
PY
}

on_error() {
    local exit_code=$?
    local line_number="${BASH_LINENO[0]:-${LINENO}}"
    printf 'ERROR: installer failed at line %s with exit code %s\n' \
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

require_command() {
    command -v "$1" >/dev/null 2>&1 ||
        fail "Required command is not installed or not on PATH: $1"
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

absolute_path_preserving_symlinks() {
    python3 - "$1" <<'PY'
import os
import sys

print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
}

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

directory_has_entries() {
    [[ -d "$1" ]] || return 1
    find "$1" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

directory_has_typescript_files() {
    [[ -d "$1" ]] || return 1
    find "$1" -mindepth 1 -maxdepth 1 -type f -name '*.ts' -print -quit |
        grep -q .
}

load_resource_manifest() {
    local resource_output
    resource_output="$(
        HARNESS_ROOT="$HARNESS_ROOT" RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
            python3 <<'PY'
import json
import os
import re
from pathlib import Path

root = Path(os.environ["HARNESS_ROOT"]).resolve()
manifest_path = Path(os.environ["RESOURCE_MANIFEST"])

try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except FileNotFoundError as exc:
    raise SystemExit(f"Missing resource manifest: {manifest_path}") from exc
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid resource manifest JSON: {exc}") from exc

if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
    raise SystemExit("Resource manifest must be an object with schemaVersion 1.")

name_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")

skill_exclusions = manifest.get("skillExclusions", [])
if not isinstance(skill_exclusions, list):
    raise SystemExit("Resource manifest key 'skillExclusions' must be an array.")
seen_exclusions = set()
for entry in skill_exclusions:
    if not isinstance(entry, dict):
        raise SystemExit("Every skill exclusion must be an object.")
    path = entry.get("path")
    reason = entry.get("reason")
    if not isinstance(path, str) or not path.startswith("~/") or any(
        character in path for character in "\t\n"
    ):
        raise SystemExit(f"Invalid skill exclusion path: {path!r}")
    if path in seen_exclusions:
        raise SystemExit(f"Duplicate skill exclusion path: {path}")
    seen_exclusions.add(path)
    if not isinstance(reason, str) or not reason.strip():
        raise SystemExit(f"Skill exclusion {path!r} requires a reason.")

for kind in ("skills", "prompts"):
    entries = manifest.get(kind)
    if not isinstance(entries, list):
        raise SystemExit(f"Resource manifest key {kind!r} must be an array.")

    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise SystemExit(f"Every {kind} entry must be an object.")
        name = entry.get("name")
        source = entry.get("source")
        if not isinstance(name, str) or not name_pattern.fullmatch(name):
            raise SystemExit(f"Invalid {kind} resource name: {name!r}")
        if name in seen:
            raise SystemExit(f"Duplicate {kind} resource name: {name}")
        seen.add(name)
        if not isinstance(source, str) or not source or "\t" in source or "\n" in source:
            raise SystemExit(f"Invalid source for {kind} resource {name!r}.")

        source_path = (root / source).resolve()
        try:
            source_path.relative_to(root)
        except ValueError as exc:
            raise SystemExit(
                f"Resource {kind}/{name} escapes the harness repository: {source}"
            ) from exc
        if not source_path.exists():
            raise SystemExit(f"Resource source does not exist: {source_path}")
        if not source_path.is_dir():
            raise SystemExit(f"Resource source is not a directory: {source_path}")

        print(f"{kind}\t{name}\t{source_path}")
PY
    )" || fail "Resource manifest validation failed."

    local kind
    local name
    local source
    while IFS=$'\t' read -r kind name source; do
        [[ -n "$kind" ]] || continue
        RESOURCE_KINDS+=("$kind")
        RESOURCE_NAMES+=("$name")
        RESOURCE_SOURCES+=("$source")
    done <<<"$resource_output"
}

validate_settings_file() {
    SETTINGS_FILE="$SETTINGS_FILE" \
    SETTINGS_DEFAULTS_FILE="$SETTINGS_DEFAULTS_FILE" \
    RECEIPT_FILE="$RECEIPT_FILE" \
        python3 <<'PY'
import json
import os
from pathlib import Path


def recorded_settings():
    """Object settings this harness installed, per the managed-state receipt.

    An installed value matching the receipt exactly is ours, so a manifest
    change may replace it. Anything else was tuned by the user and is still
    a conflict. Without this, retuning any managed default would fail every
    existing installation's preflight.
    """
    receipt_path = Path(os.environ.get("RECEIPT_FILE", "")).expanduser()
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    owned = {}
    for entry in receipt.get("settings", []):
        if isinstance(entry, dict) and isinstance(entry.get("kind"), str):
            owned[entry["kind"]] = entry.get("value")
    return owned


OWNED_SETTINGS = recorded_settings()

path = Path(os.environ["SETTINGS_FILE"]).expanduser()
if not path.exists():
    raise SystemExit(0)

try:
    settings = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Cannot use invalid JSON in {path}: {exc}") from exc

if not isinstance(settings, dict):
    raise SystemExit(f"Expected a JSON object in {path}.")

for key in ("skills", "prompts"):
    value = settings.get(key)
    if value is not None and not isinstance(value, list):
        raise SystemExit(f"Expected settings key {key!r} to contain an array.")

defaults_path = Path(os.environ["SETTINGS_DEFAULTS_FILE"])
try:
    defaults = json.loads(defaults_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid settings defaults JSON in {defaults_path}: {exc}") from exc
if not isinstance(defaults, dict) or defaults.get("schemaVersion") != 1:
    raise SystemExit(f"Expected a schemaVersion 1 object in {defaults_path}.")
declared = defaults.get("settings")
if not isinstance(declared, dict) or not declared:
    raise SystemExit(f"Expected a non-empty settings object in {defaults_path}.")
for kind, value in declared.items():
    if not isinstance(value, dict) or not value:
        raise SystemExit(f"Settings default {kind!r} must be a non-empty object.")
    installed = settings.get(kind)
    if installed is not None and not isinstance(installed, dict):
        raise SystemExit(f"Expected settings key {kind!r} to contain an object.")
    if (
        installed is not None
        and installed != value
        and installed != OWNED_SETTINGS.get(kind)
    ):
        raise SystemExit(
            f"Existing settings key {kind!r} in {path} conflicts with the "
            "harness rate-limit defaults. Merge your overrides into the "
            "harness manifest or resolve the conflict before installation."
        )
PY
}

validate_models_file() {
    MODELS_FILE="$MODELS_FILE" \
    MODELS_DEFAULTS_FILE="$MODELS_DEFAULTS_FILE" \
    RECEIPT_FILE="$RECEIPT_FILE" \
        python3 <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["MODELS_FILE"]).expanduser()
defaults_path = Path(os.environ["MODELS_DEFAULTS_FILE"])


def recorded_overrides():
    """Model overrides this harness installed, per the managed-state receipt.

    An installed value matching the receipt exactly is ours, so a manifest
    change may replace it. Anything else was chosen by the user and is a
    conflict. Without this, retiring a declared key would fail every
    existing installation's preflight.
    """
    receipt_path = Path(os.environ.get("RECEIPT_FILE", "")).expanduser()
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    owned = {}
    for entry in receipt.get("models", []):
        if not isinstance(entry, dict):
            continue
        provider, model = entry.get("provider"), entry.get("model")
        if isinstance(provider, str) and isinstance(model, str):
            owned[(provider, model)] = entry.get("value")
    return owned


OWNED = recorded_overrides()
try:
    defaults = json.loads(defaults_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid models defaults JSON in {defaults_path}: {exc}") from exc
if not isinstance(defaults, dict) or defaults.get("schemaVersion") != 1:
    raise SystemExit(f"Expected a schemaVersion 1 object in {defaults_path}.")
declared = defaults.get("models")
if not isinstance(declared, dict) or not declared:
    raise SystemExit(f"Expected a non-empty models object in {defaults_path}.")

if not path.exists():
    raise SystemExit(0)
try:
    models = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Cannot use invalid JSON in {path}: {exc}") from exc
if not isinstance(models, dict):
    raise SystemExit(f"Expected a JSON object in {path}.")
providers = models.get("providers")
if providers is None:
    raise SystemExit(0)
if not isinstance(providers, dict):
    raise SystemExit(f"Expected models key 'providers' in {path} to contain an object.")

for provider, overrides in declared.items():
    if not isinstance(overrides, dict) or not overrides:
        raise SystemExit(f"Models default {provider!r} must be a non-empty object.")
    provider_obj = providers.get(provider)
    if provider_obj is not None and not isinstance(provider_obj, dict):
        raise SystemExit(f"Expected provider {provider!r} in {path} to contain an object.")
    installed = (
        provider_obj.get("modelOverrides") if isinstance(provider_obj, dict) else None
    )
    if installed is not None and not isinstance(installed, dict):
        raise SystemExit(
            f"Expected provider {provider!r} modelOverrides in {path} to contain an object."
        )
    for model, value in overrides.items():
        if not isinstance(value, dict) or not value:
            raise SystemExit(f"Models default {provider}/{model} must be a non-empty object.")
        if isinstance(installed, dict) and model in installed and installed[model] != value:
            if installed[model] == OWNED.get((provider, model)):
                continue
            raise SystemExit(
                f"Existing model override {provider}/{model} in {path} conflicts "
                "with the harness default. Merge your overrides into the "
                "harness manifest or resolve the conflict before installation."
            )
PY
}

audit_existing_skill_collisions() {
    SETTINGS_FILE="$SETTINGS_FILE" \
    HARNESS_ROOT="$HARNESS_ROOT" \
    RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
    TARGET_HARNESS_ROOT="$TARGET_HARNESS_ROOT" \
        python3 <<'PY'
import json
import os
import re
import sys
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_FILE"]).expanduser()
if not settings_path.exists():
    raise SystemExit(0)

settings = json.loads(settings_path.read_text(encoding="utf-8"))
root = Path(os.environ["HARNESS_ROOT"]).resolve()
manifest = json.loads(Path(os.environ["RESOURCE_MANIFEST"]).read_text(encoding="utf-8"))
target_root = Path(os.environ["TARGET_HARNESS_ROOT"]).expanduser()
excluded_skill_dirs = {
    Path(entry["path"]).expanduser().resolve(strict=False)
    for entry in manifest.get("skillExclusions", [])
}


def skill_names(resource_root: Path) -> dict[str, Path]:
    if not resource_root.is_dir():
        return {}
    direct = resource_root / "SKILL.md"
    candidates = [direct] if direct.is_file() else sorted(resource_root.rglob("SKILL.md"))
    result = {}
    for skill_file in candidates:
        relative = skill_file.relative_to(resource_root)
        if any(part.startswith(".") for part in relative.parts[:-1]):
            continue
        text = skill_file.read_text(encoding="utf-8", errors="replace")
        match = re.match(r"^---\s*$([\s\S]*?)^---\s*$", text, re.MULTILINE)
        name = skill_file.parent.name
        if match:
            name_match = re.search(r"^name:\s*([^\n#]+?)\s*$", match.group(1), re.MULTILINE)
            if name_match:
                name = name_match.group(1).strip(" '\"")
        result[name] = skill_file
    return result


harness_skills = {}
for entry in manifest["skills"]:
    source = (root / entry["source"]).resolve()
    for name, skill_file in skill_names(source).items():
        harness_skills[name] = skill_file

ignored = {
    (root / "skills").resolve(strict=False),
    (target_root / "skills").resolve(strict=False),
}
for entry in manifest["skills"]:
    ignored.add((target_root / "skills" / entry["name"]).resolve(strict=False))

collisions = []
for raw_path in settings.get("skills") or []:
    if raw_path.startswith(("!", "+", "-")):
        continue
    configured = Path(raw_path).expanduser().resolve(strict=False)
    if configured in ignored:
        continue
    for name, skill_file in skill_names(configured).items():
        if skill_file.parent.resolve(strict=False) in excluded_skill_dirs:
            continue
        harness_file = harness_skills.get(name)
        if harness_file is not None and skill_file.resolve() != harness_file.resolve():
            collisions.append((name, configured, harness_file))

for name, configured, harness_file in collisions:
    print(
        "WARNING: existing configured skill path "
        f"{configured} also provides {name!r}; the harness provides it at "
        f"{harness_file}. Pi may report a duplicate skill name until one source "
        "is removed from settings.",
        file=sys.stderr,
    )
PY
}

validate_package_manifest() {
    local count=0
    local package
    local raw_line
    while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
        package="$(trim_whitespace "$raw_line")"
        [[ -z "$package" || "$package" == \#* ]] && continue
        if [[ ! "$package" =~ ^npm:((@[a-zA-Z0-9._-]+/)?[a-zA-Z0-9._-]+)@[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
            [[ ! "$package" =~ ^git:github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+@((v?[0-9]+\.[0-9]+\.[0-9]+)|([0-9a-f]{7,40}))$ ]]; then
            fail "Pi package source is not pinned to an exact version or immutable ref: $package"
        fi
        count=$((count + 1))
    done <"$PACKAGE_FILE"
    ((count > 0)) || fail "Package manifest contains no package sources."
}

validate_npm_allow_scripts() {
    [[ -f "$NPM_ALLOW_SCRIPTS_FILE" ]] ||
        fail "Missing npm allow-scripts manifest: $NPM_ALLOW_SCRIPTS_FILE"

    NPM_ALLOW_SCRIPTS_FILE="$NPM_ALLOW_SCRIPTS_FILE" python3 <<'PY'
import json
import os
import re
from pathlib import Path

path = Path(os.environ["NPM_ALLOW_SCRIPTS_FILE"])
try:
    manifest = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid npm allow-scripts JSON in {path}: {exc}") from exc

approvals = manifest.get("allowScripts") if isinstance(manifest, dict) else None
if not isinstance(approvals, dict):
    raise SystemExit(f"{path} must contain an 'allowScripts' object.")

# npm keys an approval by exact version, so a later release of the same
# dependency arrives unapproved and has to be reviewed before it can build.
pinned = re.compile(r"^(@[a-zA-Z0-9._-]+/)?[a-zA-Z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+$")
for name, allowed in approvals.items():
    if not pinned.match(name):
        raise SystemExit(
            f"npm install-script approval is not pinned to an exact version: {name}"
        )
    if allowed is not True:
        raise SystemExit(f"npm install-script approval must be true: {name}")
PY
}

validate_required_mcp() {
    [[ -f "$REQUIRED_MCP_FILE" ]] ||
        fail "Missing required MCP manifest: $REQUIRED_MCP_FILE"

    REQUIRED_MCP_FILE="$REQUIRED_MCP_FILE" \
    TARGET_MCP_FILE="$TARGET_MCP_FILE" \
    SKIP_MCP="$SKIP_MCP" \
        python3 <<'PY'
import json
import os
from pathlib import Path

required_path = Path(os.environ["REQUIRED_MCP_FILE"])
target_path = Path(os.environ["TARGET_MCP_FILE"]).expanduser()

try:
    required = json.loads(required_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid required MCP JSON in {required_path}: {exc}") from exc

servers = required.get("mcpServers") if isinstance(required, dict) else None
if not isinstance(servers, dict) or not servers:
    raise SystemExit("Required MCP manifest must contain a non-empty mcpServers object.")
for name, server in servers.items():
    if not isinstance(name, str) or not name:
        raise SystemExit("Required MCP server names must be non-empty strings.")
    if not isinstance(server, dict):
        raise SystemExit(f"Required MCP server {name!r} must be an object.")
    transports = [key for key in ("url", "command", "socket") if key in server]
    if len(transports) != 1:
        raise SystemExit(
            f"Required MCP server {name!r} must declare exactly one transport."
        )

if os.environ["SKIP_MCP"] == "1" or not target_path.exists():
    raise SystemExit(0)

try:
    existing = json.loads(target_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Cannot merge invalid MCP JSON in {target_path}: {exc}") from exc
if not isinstance(existing, dict):
    raise SystemExit(f"Expected a JSON object in {target_path}.")
existing_servers = existing.get("mcpServers")
if existing_servers is None:
    existing_servers = {}
if not isinstance(existing_servers, dict):
    raise SystemExit(f"Expected mcpServers in {target_path} to be an object.")

for name, server in servers.items():
    existing_server = existing_servers.get(name)
    if existing_server is not None and (
        not isinstance(existing_server, dict)
        or any(existing_server.get(key) != value for key, value in server.items())
    ):
        raise SystemExit(
            f"Existing MCP server {name!r} in {target_path} conflicts with the "
            "required harness definition. Resolve it before installation."
        )
PY
}

# version_lt <a> <b>
#
# Succeeds (exit 0) when version <a> is strictly lower than version <b>,
# and fails (exit 1) when <a> is equal to or higher than <b>.
#
# Both arguments arrive as bare dotted versions ("0.78.1", "0.84.1").
# A trailing prerelease suffix ("0.85.0-beta.1") may be present and is
# compared on its numeric components alone.
#
# Note the comparison must be numeric, not lexical: "0.9.0" is LOWER
# than "0.84.1" as a string, but HIGHER as a version.
#
# Pure Bash: no dependency on 'sort -V', whose support varies across the
# BSD sort shipped on macOS. The 10# prefix forces base ten so a
# zero-padded component ("0.08.1") is never read as octal.
version_lt() {
    local left right index
    IFS='.-' read -ra left <<<"$1"
    IFS='.-' read -ra right <<<"$2"

    for index in 0 1 2; do
        ((10#${left[index]:-0} < 10#${right[index]:-0})) && return 0
        ((10#${left[index]:-0} > 10#${right[index]:-0})) && return 1
    done

    return 1
}

validate_pi_version() {
    log "Validating Pi runtime"

    require_command pi

    local reported
    local current
    reported="$(pi --version 2>&1 || true)"

    [[ "$reported" =~ ([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?) ]] ||
        fail "Could not read a version from 'pi --version': $reported"
    current="${BASH_REMATCH[1]}"

    if version_lt "$current" "$MINIMUM_PI_VERSION"; then
        fail "Pi $current is older than the required $MINIMUM_PI_VERSION.
       The pinned harness packages import @earendil-works/pi-ai/compat,
       which is unavailable before Pi 0.81.0.
       Upgrade with: pi update pi"
    fi

    info "Pi version: $current (>= $MINIMUM_PI_VERSION)"
}

validate_repository() {
    log "Validating harness repository"

    [[ -f "$SOURCE_AGENTS" ]] ||
        fail "Missing global instructions file: $SOURCE_AGENTS"
    [[ -f "$PACKAGE_FILE" ]] ||
        fail "Missing package manifest: $PACKAGE_FILE"
    [[ -f "$RESOURCE_MANIFEST" ]] ||
        fail "Missing resource manifest: $RESOURCE_MANIFEST"
    [[ -f "$SETTINGS_DEFAULTS_FILE" ]] ||
        fail "Missing settings defaults manifest: $SETTINGS_DEFAULTS_FILE"
    [[ -f "$MODELS_DEFAULTS_FILE" ]] ||
        fail "Missing models defaults manifest: $MODELS_DEFAULTS_FILE"
    [[ -f "$MANAGED_STATE_HELPER" ]] ||
        fail "Missing managed-state helper: $MANAGED_STATE_HELPER"

    load_resource_manifest
    validate_settings_file
    validate_models_file
    validate_package_manifest
    validate_required_mcp
    validate_npm_allow_scripts
    audit_existing_skill_collisions
    if ((SKIP_MCP)); then
        managed_state preflight-install --skip-mcp
        managed_state preflight-reconcile-install \
            --backup-dir "$BACKUP_DIR" --skip-mcp
    else
        managed_state preflight-install
        managed_state preflight-reconcile-install --backup-dir "$BACKUP_DIR"
    fi

    if directory_has_typescript_files "$SOURCE_PERMISSIONS"; then
        grep -Eq \
            '^[[:space:]]*npm:@thurstonsand/pi-permissions@[0-9]+\.[0-9]+\.[0-9]+[[:space:]]*$' \
            "$PACKAGE_FILE" ||
            fail "Permission hooks require a pinned @thurstonsand/pi-permissions package."
    fi

    info "Harness root: $HARNESS_ROOT"
    info "Pi agent directory: $PI_AGENT_DIR"
}

mcp_needs_update() {
    REQUIRED_MCP_FILE="$REQUIRED_MCP_FILE" \
    TARGET_MCP_FILE="$TARGET_MCP_FILE" \
        python3 <<'PY'
import json
import os
from pathlib import Path

required = json.loads(Path(os.environ["REQUIRED_MCP_FILE"]).read_text(encoding="utf-8"))
target_path = Path(os.environ["TARGET_MCP_FILE"]).expanduser()
existing = json.loads(target_path.read_text(encoding="utf-8")) if target_path.exists() else {}
existing_servers = existing.get("mcpServers") or {}

for name, server in required["mcpServers"].items():
    existing_server = existing_servers.get(name)
    if not isinstance(existing_server, dict) or any(
        existing_server.get(key) != value for key, value in server.items()
    ):
        raise SystemExit(10)
raise SystemExit(0)
PY
}

install_required_mcp() {
    if ((SKIP_MCP)); then
        log "Skipping required MCP configuration"
        return 0
    fi

    log "Registering required MCP servers"
    local update_required=0
    if mcp_needs_update; then
        update_required=0
    else
        local status=$?
        if [[ "$status" -eq 10 ]]; then
            update_required=1
        else
            return "$status"
        fi
    fi

    if ((update_required == 0)); then
        info "Pi MCP override already contains every required server."
        return 0
    fi

    if ((DRY_RUN)); then
        info "Would merge required MCP servers into: $TARGET_MCP_FILE"
        return 0
    fi

    mkdir -p "$PI_AGENT_DIR"
    if [[ -f "$TARGET_MCP_FILE" ]]; then
        ensure_backup_dir
        mkdir -p "$(dirname "$BACKUP_DIR/mcp.json")"
        if path_exists "$BACKUP_DIR/mcp.json"; then
            info "Original Pi MCP configuration already preserved at:"
        else
            cp -a "$TARGET_MCP_FILE" "$BACKUP_DIR/mcp.json"
            info "Pi MCP configuration backup:"
        fi
        info "  $BACKUP_DIR/mcp.json"
    fi

    REQUIRED_MCP_FILE="$REQUIRED_MCP_FILE" \
    TARGET_MCP_FILE="$TARGET_MCP_FILE" \
        python3 <<'PY'
import json
import os
import stat
import tempfile
from pathlib import Path

required = json.loads(Path(os.environ["REQUIRED_MCP_FILE"]).read_text(encoding="utf-8"))
target_path = Path(os.environ["TARGET_MCP_FILE"]).expanduser()
target_path.parent.mkdir(parents=True, exist_ok=True)

if target_path.exists():
    existing = json.loads(target_path.read_text(encoding="utf-8"))
    mode = stat.S_IMODE(target_path.stat().st_mode)
else:
    existing = {}
    mode = 0o600

servers = existing.setdefault("mcpServers", {})
for name, server in required["mcpServers"].items():
    servers.setdefault(name, server)

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

ensure_backup_dir() {
    if ((DRY_RUN)); then
        BACKUP_PLANNED=1
        return 0
    fi
    if ((BACKUP_CREATED == 0)); then
        mkdir -p "$BACKUP_DIR"
        BACKUP_CREATED=1
    fi
}

backup_target() {
    local target="$1"
    local relative_backup_path="$2"
    local destination="$BACKUP_DIR/$relative_backup_path"

    path_exists "$target" || return 0
    ensure_backup_dir

    if ((DRY_RUN)); then
        run mkdir -p "$(dirname "$destination")"
        run mv "$target" "$destination"
        info "Would preserve existing resource at:"
    else
        mkdir -p "$(dirname "$destination")"
        mv "$target" "$destination"
        info "Preserved existing resource at:"
    fi
    info "  $destination"
}

reconcile_legacy_pair_extension() {
    local target="$TARGET_EXTENSIONS/pair.ts"
    local former_source="$HARNESS_ROOT/extensions/pair.ts"

    path_exists "$target" || return 0
    if [[ -L "$target" ]] &&
        [[ "$(canonical_path "$target")" == "$(canonical_path "$former_source")" ]]; then
        backup_target "$target" "extensions/pair.ts"
        return 0
    fi

    warn "Leaving foreign legacy extension in place: $target"
}

reconcile_managed_state() {
    log "Reconciling managed state"
    local args=(reconcile-install --backup-dir "$BACKUP_DIR")
    ((DRY_RUN)) && args+=(--dry-run)
    ((SKIP_MCP)) && args+=(--skip-mcp)

    local output
    output="$(managed_state "${args[@]}")" || {
        local status=$?
        [[ -n "$output" ]] && printf '%s\n' "$output"
        return "$status"
    }
    [[ -n "$output" ]] && printf '%s\n' "$output"

    if ((DRY_RUN)); then
        if [[ "$output" == *"DRY-RUN: Owned "* ]]; then
            BACKUP_PLANNED=1
        fi
    elif [[ -d "$BACKUP_DIR" ]]; then
        BACKUP_CREATED=1
    fi

    reconcile_legacy_pair_extension
}

link_managed_resource() {
    local source="$1"
    local target="$2"
    local backup_name="$3"

    path_exists "$source" || fail "Managed source does not exist: $source"

    local source_canonical
    local target_canonical=""
    local link_source
    source_canonical="$(canonical_path "$source")"
    link_source="$(absolute_path_preserving_symlinks "$source")"

    if path_exists "$target"; then
        target_canonical="$(canonical_path "$target")"
    fi
    if [[ -L "$target" && "$source_canonical" == "$target_canonical" ]]; then
        info "Already linked: $target"
        return 0
    fi

    if path_exists "$target"; then
        backup_target "$target" "$backup_name"
    fi

    run mkdir -p "$(dirname "$target")"
    run ln -s "$link_source" "$target"
    info "Linked:"
    info "  $target"
    info "    -> $link_source"
}

copy_managed_file() {
    local source="$1"
    local target="$2"
    local backup_name="$3"

    [[ -f "$source" ]] || fail "Managed file source does not exist: $source"

    if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
        info "Already copied: $target"
        return 0
    fi

    if path_exists "$target"; then
        backup_target "$target" "$backup_name"
    fi

    run mkdir -p "$(dirname "$target")"
    run cp -p "$source" "$target"
    info "Copied:"
    info "  $target"
    info "    <- $source"
}

# Pi installs its extension packages with npm, and npm 11.6+ leaves a
# dependency's install script unrun until the project approves it by exact
# version. Anything absent from config/npm-allow-scripts.json stays unrun
# until a human reviews it and pins it there; approvals are seeded before
# `pi install` so the reviewed build steps run during installation rather
# than being skipped with a warning.
#
# The manifest is empty today. The only install script npm has reported here
# is tree-sitter-bash's `node-gyp-build`, which builds a native addon that
# nothing in this harness loads: pi-permissions parses shell through
# web-tree-sitter and the package's .wasm grammar.
npm_allow_scripts_declared() {
    NPM_ALLOW_SCRIPTS_FILE="$NPM_ALLOW_SCRIPTS_FILE" python3 -c '
import json
import os
from pathlib import Path

approvals = json.loads(
    Path(os.environ["NPM_ALLOW_SCRIPTS_FILE"]).read_text(encoding="utf-8")
)["allowScripts"]
raise SystemExit(0 if approvals else 1)
'
}

install_npm_allow_scripts() {
    if ((SKIP_PACKAGES)); then
        log "Skipping npm install-script approvals"
        return 0
    fi

    log "Approving reviewed npm install scripts"

    if ! npm_allow_scripts_declared; then
        info "No install scripts are approved; leaving the npm project alone."
        return 0
    fi

    if ((DRY_RUN)); then
        info "Would merge approvals into: $TARGET_NPM_PACKAGE_FILE"
        return 0
    fi

    NPM_ALLOW_SCRIPTS_FILE="$NPM_ALLOW_SCRIPTS_FILE" \
    TARGET_NPM_PACKAGE_FILE="$TARGET_NPM_PACKAGE_FILE" \
        python3 <<'PY'
import json
import os
import stat
import tempfile
from pathlib import Path

approvals = json.loads(
    Path(os.environ["NPM_ALLOW_SCRIPTS_FILE"]).read_text(encoding="utf-8")
)["allowScripts"]
target_path = Path(os.environ["TARGET_NPM_PACKAGE_FILE"]).expanduser()
target_path.parent.mkdir(parents=True, exist_ok=True)

if target_path.exists():
    existing = json.loads(target_path.read_text(encoding="utf-8"))
    mode = stat.S_IMODE(target_path.stat().st_mode)
else:
    # Same seed Pi writes when it creates the extension project itself, so
    # pre-creating the file here is invisible to Pi.
    existing = {"name": "pi-extensions", "private": True}
    mode = 0o644

allowed = existing.setdefault("allowScripts", {})
for name, decision in approvals.items():
    allowed.setdefault(name, decision)

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

install_packages() {
    if ((SKIP_PACKAGES)); then
        log "Skipping Pi package installation"
        return 0
    fi

    require_command pi
    if grep -Eq '^[[:space:]]*git:' "$PACKAGE_FILE"; then
        require_command git
    fi
    log "Installing pinned Pi packages"

    local package
    local raw_line
    while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
        package="$(trim_whitespace "$raw_line")"
        [[ -z "$package" || "$package" == \#* ]] && continue
        info "Ensuring package is installed: $package"
        run pi install "$package"
    done <"$PACKAGE_FILE"
}

install_global_agents_file() {
    log "Installing global AGENTS.md"
    link_managed_resource "$SOURCE_AGENTS" "$TARGET_AGENTS" "AGENTS.md"
}

prepare_resource_containers() {
    local kind
    for kind in skills prompts; do
        local has_kind=0
        local resource_kind
        for resource_kind in "${RESOURCE_KINDS[@]}"; do
            if [[ "$resource_kind" == "$kind" ]]; then
                has_kind=1
                break
            fi
        done
        ((has_kind)) || continue

        local container="$TARGET_HARNESS_ROOT/$kind"
        if [[ -d "$container" && ! -L "$container" ]]; then
            continue
        fi
        if path_exists "$container"; then
            backup_target "$container" "harness/$kind"
        fi
        run mkdir -p "$container"
    done
}

install_resources() {
    log "Installing curated harness resources"

    prepare_resource_containers

    local index
    local kind
    local name
    local source
    local target
    for index in "${!RESOURCE_KINDS[@]}"; do
        kind="${RESOURCE_KINDS[$index]}"
        name="${RESOURCE_NAMES[$index]}"
        source="${RESOURCE_SOURCES[$index]}"
        target="$TARGET_HARNESS_ROOT/$kind/$name"
        link_managed_resource "$source" "$target" "harness/$kind/$name"
    done
}

install_permission_hooks() {
    if ! directory_has_typescript_files "$SOURCE_PERMISSIONS"; then
        log "No TypeScript permission hooks found; skipping"
        return 0
    fi

    log "Installing global permission hooks"
    local permission_file
    local permission_relative
    while IFS= read -r -d '' permission_file; do
        permission_relative="${permission_file#"$SOURCE_PERMISSIONS/"}"
        copy_managed_file \
            "$permission_file" \
            "$TARGET_PERMISSIONS/$permission_relative" \
            "permissions/$permission_relative"
    done < <(
        find "$SOURCE_PERMISSIONS" \
            -mindepth 1 -type f \
            \( -name '*.ts' -o -name '*.js' \) -print0
    )
}

install_extensions() {
    if ! directory_has_entries "$SOURCE_EXTENSIONS"; then
        log "No harness-managed extensions found; skipping"
        return 0
    fi

    log "Installing harness-managed extensions"
    local extension
    local extension_name
    while IFS= read -r -d '' extension; do
        extension_name="$(basename "$extension")"
        link_managed_resource \
            "$extension" \
            "$TARGET_EXTENSIONS/$extension_name" \
            "extensions/$extension_name"
    done < <(
        find "$SOURCE_EXTENSIONS" -mindepth 1 -maxdepth 1 -print0
    )
}

settings_need_update() {
    SETTINGS_FILE="$SETTINGS_FILE" \
    HARNESS_ROOT="$HARNESS_ROOT" \
    RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
    SETTINGS_DEFAULTS_FILE="$SETTINGS_DEFAULTS_FILE" \
    TARGET_HARNESS_ROOT="$TARGET_HARNESS_ROOT" \
        python3 <<'PY'
import json
import os
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_FILE"]).expanduser()
root = Path(os.environ["HARNESS_ROOT"]).resolve()
manifest = json.loads(Path(os.environ["RESOURCE_MANIFEST"]).read_text(encoding="utf-8"))
defaults = json.loads(
    Path(os.environ["SETTINGS_DEFAULTS_FILE"]).read_text(encoding="utf-8")
)["settings"]
target_root = Path(os.environ["TARGET_HARNESS_ROOT"]).expanduser()
settings = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}

for kind in ("skills", "prompts"):
    values = settings.get(kind) or []
    legacy_paths = {str(root / kind), str(target_root / kind)}
    if any(value in legacy_paths for value in values):
        raise SystemExit(10)
    for entry in manifest[kind]:
        expected = str(target_root / kind / entry["name"])
        if expected not in values:
            raise SystemExit(10)
for entry in manifest.get("skillExclusions", []):
    expected = f"-{Path(entry['path']).expanduser().resolve(strict=False)}"
    if expected not in settings.get("skills", []):
        raise SystemExit(10)
for kind, value in defaults.items():
    if settings.get(kind) != value:
        raise SystemExit(10)
raise SystemExit(0)
PY
}

backup_settings_file() {
    [[ -f "$SETTINGS_FILE" ]] || return 0
    ensure_backup_dir
    if path_exists "$BACKUP_DIR/settings.json"; then
        info "Original Pi settings already preserved at:"
    else
        if ((DRY_RUN)); then
            run cp -a "$SETTINGS_FILE" "$BACKUP_DIR/settings.json"
        else
            cp -a "$SETTINGS_FILE" "$BACKUP_DIR/settings.json"
        fi
        info "Pi settings backup:"
    fi
    info "  $BACKUP_DIR/settings.json"
}

merge_resource_settings() {
    log "Registering curated skills and prompt paths"

    local update_required=0
    if settings_need_update; then
        update_required=0
    else
        local status=$?
        if [[ "$status" -eq 10 ]]; then
            update_required=1
        else
            return "$status"
        fi
    fi

    if ((update_required == 0)); then
        info "Pi settings already contain every curated harness resource path."
        return 0
    fi

    if ((DRY_RUN)); then
        backup_settings_file
        local planned_changes
        planned_changes="$(
            SETTINGS_FILE="$SETTINGS_FILE" \
            RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
            SETTINGS_DEFAULTS_FILE="$SETTINGS_DEFAULTS_FILE" \
            TARGET_HARNESS_ROOT="$TARGET_HARNESS_ROOT" \
                python3 <<'PY'
import json
import os
from pathlib import Path

settings_path = Path(os.environ["SETTINGS_FILE"]).expanduser()
manifest = json.loads(Path(os.environ["RESOURCE_MANIFEST"]).read_text(encoding="utf-8"))
defaults = json.loads(
    Path(os.environ["SETTINGS_DEFAULTS_FILE"]).read_text(encoding="utf-8")
)["settings"]
target_root = Path(os.environ["TARGET_HARNESS_ROOT"]).expanduser()
settings = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}

for kind in ("skills", "prompts"):
    existing = settings.get(kind) or []
    for entry in manifest[kind]:
        value = str(target_root / kind / entry["name"])
        if value not in existing:
            print(f"register\t{kind}\t{value}")

existing_skills = settings.get("skills") or []
for entry in manifest.get("skillExclusions", []):
    value = str(Path(entry["path"]).expanduser().resolve(strict=False))
    if f"-{value}" not in existing_skills:
        print(f"exclude\tskills\t{value}")

for kind in sorted(defaults):
    if kind not in settings:
        print(f"default\t{kind}")
PY
        )" || fail "Dry-run settings planning failed."

        local action
        local kind
        local value
        while IFS=$'\t' read -r action kind value; do
            [[ -n "$action" ]] || continue
            if [[ "$action" == "register" ]]; then
                info "Would register $kind path: $value"
            elif [[ "$action" == "exclude" ]]; then
                info "Would exclude external duplicate skill path from Pi: $value"
            elif [[ "$action" == "default" ]]; then
                info "Would set harness default settings key: $kind"
            fi
        done <<<"$planned_changes"
        return 0
    fi

    mkdir -p "$PI_AGENT_DIR"
    backup_settings_file

    SETTINGS_FILE="$SETTINGS_FILE" \
    HARNESS_ROOT="$HARNESS_ROOT" \
    RESOURCE_MANIFEST="$RESOURCE_MANIFEST" \
    SETTINGS_DEFAULTS_FILE="$SETTINGS_DEFAULTS_FILE" \
    TARGET_HARNESS_ROOT="$TARGET_HARNESS_ROOT" \
    RECEIPT_FILE="$RECEIPT_FILE" \
        python3 <<'PY'
import json
import os
import stat
import tempfile
from pathlib import Path


def recorded_settings():
    """Object settings this harness installed, per the receipt. See preflight."""
    receipt_path = Path(os.environ.get("RECEIPT_FILE", "")).expanduser()
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    owned = {}
    for entry in receipt.get("settings", []):
        if isinstance(entry, dict) and isinstance(entry.get("kind"), str):
            owned[entry["kind"]] = entry.get("value")
    return owned


OWNED_SETTINGS = recorded_settings()

settings_path = Path(os.environ["SETTINGS_FILE"]).expanduser()
root = Path(os.environ["HARNESS_ROOT"]).resolve()
manifest = json.loads(Path(os.environ["RESOURCE_MANIFEST"]).read_text(encoding="utf-8"))
defaults = json.loads(
    Path(os.environ["SETTINGS_DEFAULTS_FILE"]).read_text(encoding="utf-8")
)["settings"]
target_root = Path(os.environ["TARGET_HARNESS_ROOT"]).expanduser()
settings_path.parent.mkdir(parents=True, exist_ok=True)

if settings_path.exists():
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    mode = stat.S_IMODE(settings_path.stat().st_mode)
else:
    settings = {}
    mode = 0o600

for kind in ("skills", "prompts"):
    existing = settings.get(kind)
    if existing is None:
        existing = []
    legacy_paths = {str(root / kind), str(target_root / kind)}
    existing = [value for value in existing if value not in legacy_paths]
    for entry in manifest[kind]:
        value = str(target_root / kind / entry["name"])
        if value not in existing:
            existing.append(value)
    if existing:
        settings[kind] = existing

skills = settings.get("skills", [])
for entry in manifest.get("skillExclusions", []):
    value = f"-{Path(entry['path']).expanduser().resolve(strict=False)}"
    if value not in skills:
        skills.append(value)
if skills:
    settings["skills"] = skills

for kind, value in defaults.items():
    # Absent: install it. Present but exactly what we recorded last time:
    # ours to replace, so a retuned default reaches existing installs.
    # Anything else is the user's and preflight has already allowed it.
    if kind not in settings or settings[kind] == OWNED_SETTINGS.get(kind):
        settings[kind] = value

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
print(f"Updated {settings_path}")
PY
}

models_need_update() {
    MODELS_FILE="$MODELS_FILE" \
    MODELS_DEFAULTS_FILE="$MODELS_DEFAULTS_FILE" \
        python3 <<'PY'
import json
import os
from pathlib import Path

models_path = Path(os.environ["MODELS_FILE"]).expanduser()
defaults = json.loads(
    Path(os.environ["MODELS_DEFAULTS_FILE"]).read_text(encoding="utf-8")
)["models"]
models = json.loads(models_path.read_text(encoding="utf-8")) if models_path.exists() else {}
providers = models.get("providers")
if not isinstance(providers, dict):
    raise SystemExit(10)
for provider, overrides in defaults.items():
    provider_obj = providers.get(provider)
    installed = (
        provider_obj.get("modelOverrides") if isinstance(provider_obj, dict) else None
    )
    for model, value in overrides.items():
        if not isinstance(installed, dict) or installed.get(model) != value:
            raise SystemExit(10)
raise SystemExit(0)
PY
}

backup_models_file() {
    [[ -f "$MODELS_FILE" ]] || return 0
    ensure_backup_dir
    if path_exists "$BACKUP_DIR/models.json"; then
        info "Original Pi models already preserved at:"
    else
        if ((DRY_RUN)); then
            run cp -a "$MODELS_FILE" "$BACKUP_DIR/models.json"
        else
            cp -a "$MODELS_FILE" "$BACKUP_DIR/models.json"
        fi
        info "Pi models backup:"
    fi
    info "  $BACKUP_DIR/models.json"
}

merge_models_defaults() {
    log "Applying harness model overrides"

    local update_required=0
    if models_need_update; then
        update_required=0
    else
        local status=$?
        if [[ "$status" -eq 10 ]]; then
            update_required=1
        else
            return "$status"
        fi
    fi

    if ((update_required == 0)); then
        info "Pi models already contain every harness model override."
        return 0
    fi

    if ((DRY_RUN)); then
        backup_models_file
        info "Would apply harness model overrides to:"
        info "  $MODELS_FILE"
        return 0
    fi

    mkdir -p "$PI_AGENT_DIR"
    backup_models_file

    MODELS_FILE="$MODELS_FILE" \
    MODELS_DEFAULTS_FILE="$MODELS_DEFAULTS_FILE" \
    RECEIPT_FILE="$RECEIPT_FILE" \
        python3 <<'PY'
import json
import os
import stat
import tempfile
from pathlib import Path

models_path = Path(os.environ["MODELS_FILE"]).expanduser()
defaults = json.loads(
    Path(os.environ["MODELS_DEFAULTS_FILE"]).read_text(encoding="utf-8")
)["models"]
models_path.parent.mkdir(parents=True, exist_ok=True)


def recorded_overrides():
    """Overrides this harness installed, per the receipt. See preflight."""
    receipt_path = Path(os.environ.get("RECEIPT_FILE", "")).expanduser()
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    owned = {}
    for entry in receipt.get("models", []):
        if not isinstance(entry, dict):
            continue
        provider, model = entry.get("provider"), entry.get("model")
        if isinstance(provider, str) and isinstance(model, str):
            owned[(provider, model)] = entry.get("value")
    return owned


OWNED = recorded_overrides()

if models_path.exists():
    models = json.loads(models_path.read_text(encoding="utf-8"))
    mode = stat.S_IMODE(models_path.stat().st_mode)
else:
    models = {}
    mode = 0o600

providers = models.get("providers")
if not isinstance(providers, dict):
    providers = {}
    models["providers"] = providers

for provider, overrides in defaults.items():
    provider_obj = providers.get(provider)
    if not isinstance(provider_obj, dict):
        provider_obj = {}
        providers[provider] = provider_obj
    installed = provider_obj.get("modelOverrides")
    if not isinstance(installed, dict):
        installed = {}
        provider_obj["modelOverrides"] = installed
    for model, value in overrides.items():
        # Absent: install it. Present but exactly what we recorded last time:
        # ours to replace, so a retired key does not linger forever. Anything
        # else belongs to the user and preflight has already allowed it.
        if model not in installed or installed[model] == OWNED.get((provider, model)):
            installed[model] = value

with tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=models_path.parent,
    prefix=f".{models_path.name}.",
    suffix=".tmp",
    delete=False,
) as handle:
    json.dump(models, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
    temporary_path = Path(handle.name)

temporary_path.chmod(mode)
os.replace(temporary_path, models_path)
print(f"Updated {models_path}")
PY
}

validate_link() {
    local source="$1"
    local target="$2"
    local description="$3"
    [[ "$(canonical_path "$source")" == "$(canonical_path "$target")" ]] ||
        fail "$description does not resolve to the harness repository."
}

validate_installation() {
    if ((DRY_RUN)); then
        log "Dry run complete; no filesystem changes were made"
        return 0
    fi

    log "Validating global harness installation"
    validate_link "$SOURCE_AGENTS" "$TARGET_AGENTS" "Global AGENTS.md"

    local index
    local kind
    local name
    local source
    local target
    for index in "${!RESOURCE_KINDS[@]}"; do
        kind="${RESOURCE_KINDS[$index]}"
        name="${RESOURCE_NAMES[$index]}"
        source="${RESOURCE_SOURCES[$index]}"
        target="$TARGET_HARNESS_ROOT/$kind/$name"
        validate_link "$source" "$target" "Harness resource $kind/$name"
    done

    if directory_has_typescript_files "$SOURCE_PERMISSIONS"; then
        local permission_file
        local permission_relative
        while IFS= read -r -d '' permission_file; do
            permission_relative="${permission_file#"$SOURCE_PERMISSIONS/"}"
            local installed_permission="$TARGET_PERMISSIONS/$permission_relative"
            [[ -f "$installed_permission" && ! -L "$installed_permission" ]] ||
                fail "Permission file is not an installed regular file: $installed_permission"
            cmp -s "$permission_file" "$installed_permission" ||
                fail "Permission file differs from harness source: $installed_permission"
        done < <(
            find "$SOURCE_PERMISSIONS" \
                -mindepth 1 -type f \
                \( -name '*.ts' -o -name '*.js' \) -print0
        )
    fi

    if directory_has_entries "$SOURCE_EXTENSIONS"; then
        local extension
        local extension_name
        while IFS= read -r -d '' extension; do
            extension_name="$(basename "$extension")"
            validate_link \
                "$extension" \
                "$TARGET_EXTENSIONS/$extension_name" \
                "Harness extension $extension_name"
            info "Harness extension $extension_name: valid"
        done < <(
            find "$SOURCE_EXTENSIONS" -mindepth 1 -maxdepth 1 -print0
        )
    fi

    [[ -f "$SETTINGS_FILE" ]] || fail "Pi settings file was not created."
    python3 -m json.tool "$SETTINGS_FILE" >/dev/null ||
        fail "Pi settings file is not valid JSON: $SETTINGS_FILE"
    settings_need_update || fail "Pi settings do not contain every curated resource path."
    [[ -f "$MODELS_FILE" ]] || fail "Pi models file was not created."
    python3 -m json.tool "$MODELS_FILE" >/dev/null ||
        fail "Pi models file is not valid JSON: $MODELS_FILE"
    models_need_update || fail "Pi models do not contain every harness model override."

    if ((SKIP_MCP == 0)); then
        [[ -f "$TARGET_MCP_FILE" ]] ||
            fail "Pi MCP override was not created: $TARGET_MCP_FILE"
        python3 -m json.tool "$TARGET_MCP_FILE" >/dev/null ||
            fail "Pi MCP override is not valid JSON: $TARGET_MCP_FILE"
        mcp_needs_update || fail "Pi MCP override is missing required servers."
    fi

    info "Global AGENTS.md: valid"
    info "Curated resources: valid"
    info "Pi settings JSON: valid"
    if ((SKIP_MCP == 0)); then
        info "Required MCP servers: valid"
    fi
    info "Permission hooks: valid"
}

write_managed_state_receipt() {
    log "Recording managed state"
    if ((DRY_RUN)); then
        info "Would write managed-state receipt at:"
        info "  $RECEIPT_FILE"
        return 0
    fi

    local args=(write-receipt)
    ((SKIP_MCP)) && args+=(--skip-mcp)
    managed_state "${args[@]}"
    [[ -f "$RECEIPT_FILE" ]] || fail "Managed-state receipt was not created."
    [[ "$(stat_mode "$RECEIPT_FILE")" == "600" ]] ||
        fail "Managed-state receipt mode is not 0600."
}

print_summary() {
    log "Pi harness setup complete"
    info "Harness source:"
    info "  $HARNESS_ROOT"
    info ""
    info "Global Pi directory:"
    info "  $PI_AGENT_DIR"
    info ""
    info "Authentication, secrets, sessions, and project settings were not modified."

    if ((DRY_RUN && BACKUP_PLANNED)); then
        info ""
        info "Existing resources would be preserved under:"
        info "  $BACKUP_DIR"
    elif ((BACKUP_CREATED)); then
        info ""
        info "Existing resources were preserved under:"
        info "  $BACKUP_DIR"
    fi

    info ""
    info "Backups are not automatically pruned."
    info "Restart Pi, inspect resources with 'pi config', then verify '/permissions'."
}

main() {
    require_command cmp
    require_command find
    require_command grep
    require_command python3

    if ((SKIP_PACKAGES == 0)); then
        validate_pi_version
    fi
    validate_repository
    run mkdir -p "$PI_AGENT_DIR"
    install_npm_allow_scripts
    install_packages
    reconcile_managed_state
    install_global_agents_file
    install_resources
    install_permission_hooks
    install_extensions
    install_required_mcp
    merge_resource_settings
    merge_models_defaults
    validate_installation
    write_managed_state_receipt
    print_summary
}

main "$@"
