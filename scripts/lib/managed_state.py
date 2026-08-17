#!/usr/bin/env python3
"""Private managed-state receipt and ownership helper for the Pi harness."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile


SCHEMA_VERSION = 1
RECEIPT_RELATIVE = Path("harness/.managed-state.json")
_COLLECTIONS = (
    "agents",
    "resources",
    "extensions",
    "permissions",
    "settings",
    "mcp",
    "models",
    "packages",
)
_FILESYSTEM_COLLECTIONS = ("agents", "resources", "extensions", "permissions")
_ENTRY_FIELDS = {
    "agents": {"source", "target"},
    "resources": {"kind", "name", "source", "target"},
    "extensions": {"source", "target"},
    "permissions": {"source", "target", "sha256"},
    "settings": {"kind", "value"},
    "mcp": {"name", "definition"},
    "models": {"provider", "model", "value"},
}
_MANAGED_SETTING_KINDS = ("skills", "prompts")
# Object-valued settings keys the harness manages as whole values. These are
# claimed only when absent, and ownership is compared by deep equality so a
# user-modified object is never overwritten or removed. `providers` is
# retained for migration only: it is no longer emitted by the desired state
# (model overrides moved to models.json), but old receipts must still load so
# reconciliation can remove the stale entry.
_OBJECT_SETTING_KINDS = ("providers", "retry")


def _setting_identity(value: object) -> object:
    """Hashable identity for a recorded setting value."""
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json_write(path: Path, payload: dict, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(raw)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _read_json(path: Path, label: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {label}: {error}") from error


def _absolute_path(path: Path) -> Path:
    """Return an absolute lexical path without following symlinks."""
    return Path(os.path.abspath(os.path.expanduser(os.fspath(path))))


def _require_safe_agent_dir(agent_dir: Path) -> Path:
    lexical = _absolute_path(agent_dir)
    if lexical.is_symlink():
        raise ValueError("Pi agent directory must not be a symlink")
    return lexical.resolve(strict=False)


def _path_relative_to(path: Path, root: Path) -> Path | None:
    try:
        return path.relative_to(root)
    except ValueError:
        return None


def _reject_symlink_components(
    path: Path, root: Path, label: str, include_final: bool = True
) -> None:
    """Reject symlinks in path components at or below a trusted root."""
    lexical_path = _absolute_path(path)
    lexical_root = _absolute_path(root)
    relative = _path_relative_to(lexical_path, lexical_root)
    if relative is None:
        if include_final and lexical_path.is_symlink():
            raise ValueError(f"{label} must not be a symlink")
        if lexical_path.parent.is_symlink():
            raise ValueError(f"{label} parent must not be a symlink")
        return

    current = lexical_root
    components = relative.parts if include_final else relative.parts[:-1]
    if current.is_symlink():
        raise ValueError(f"{label} ancestry must not contain symlinks")
    for component in components:
        current /= component
        if current.is_symlink():
            raise ValueError(f"{label} ancestry must not contain symlinks")


def _validate_receipt_path(path: Path, agent_dir: Path) -> Path:
    agent = _require_safe_agent_dir(agent_dir)
    lexical_agent = _absolute_path(agent_dir)
    lexical_path = _absolute_path(path)
    _reject_symlink_components(lexical_path, lexical_agent, "managed-state receipt")
    if lexical_path.is_symlink():
        raise ValueError("managed-state receipt must not be a symlink")
    if _path_relative_to(lexical_path.resolve(strict=False), agent) is None:
        # Receipt parsing remains usable for isolated validation fixtures, but
        # those paths must not gain access through a symlinked immediate parent.
        if lexical_path.parent.is_symlink():
            raise ValueError("managed-state receipt parent must not be a symlink")
    return lexical_path


def _read_json_object_if_present(path: Path, label: str) -> dict:
    if not _path_exists(path):
        return {}
    if path.is_symlink():
        raise ValueError(f"invalid {label}: path must not be a symlink")
    if not path.is_file():
        raise ValueError(f"invalid {label}: path must be a regular file")
    payload = _read_json(path, label)
    if not isinstance(payload, dict):
        raise ValueError(f"invalid {label}: expected a JSON object")
    return payload


def _contains_private_mcp_field(value: object) -> bool:
    if isinstance(value, dict):
        if any(key in ("headers", "env") for key in value):
            return True
        return any(_contains_private_mcp_field(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_private_mcp_field(item) for item in value)
    return False


def _installed_path(path: Path) -> Path:
    """Resolve an installed path's parent without following its final symlink."""
    lexical = _absolute_path(path)
    return lexical.parent.resolve(strict=False) / lexical.name


def _require_contained_target(raw: object, agent_dir: Path) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError("managed-state target must be a non-empty string")
    root = _require_safe_agent_dir(agent_dir)
    lexical_root = _absolute_path(agent_dir)
    lexical_target = _absolute_path(Path(raw))
    if _path_relative_to(lexical_target, lexical_root) is None:
        raise ValueError(
            f"managed-state target is outside Pi agent directory: {raw}"
        )
    _reject_symlink_components(
        lexical_target,
        lexical_root,
        "managed-state target",
        include_final=False,
    )
    target = _installed_path(Path(raw))
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError(
            f"managed-state target is outside Pi agent directory: {raw}"
        ) from error
    return str(target)


def _require_desired_target(
    raw: object, agent_dir: Path, collection: str
) -> str:
    """Validate desired targets, allowing only legacy resource aggregates."""
    try:
        return _require_contained_target(raw, agent_dir)
    except ValueError:
        if collection != "resources" or not isinstance(raw, str) or not raw:
            raise

        root = _require_safe_agent_dir(agent_dir)
        target = _absolute_path(Path(raw))
        relative = _path_relative_to(target, root)
        if (
            relative is None
            or len(relative.parts) != 3
            or relative.parts[0] != "harness"
            or relative.parts[1] not in _MANAGED_SETTING_KINDS
        ):
            raise

        harness_container = root / "harness"
        aggregate = harness_container / relative.parts[1]
        if harness_container.is_symlink() or not aggregate.is_symlink():
            raise
        return str(target)


def _require_entry_fields(entry: dict, collection: str, label: str) -> None:
    unknown = set(entry) - _ENTRY_FIELDS[collection]
    if unknown:
        raise ValueError(f"{label} contains unknown fields")


def _require_string(entry: dict, name: str, label: str, optional: bool = False) -> str:
    value = entry.get(name)
    if optional and value is None:
        return ""
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} {name} must be a non-empty string")
    return value


def _validate_state(
    state: object,
    agent_dir: Path,
    *,
    desired_state: bool = False,
    require_complete: bool = False,
) -> dict:
    agent_root = _require_safe_agent_dir(agent_dir)
    if not isinstance(state, dict):
        raise ValueError("managed-state receipt must be a JSON object")
    allowed_keys = {
        "schemaVersion", "harnessRoot", "harnessVersion", "agentDir", *_COLLECTIONS
    }
    unknown_keys = set(state) - allowed_keys
    if unknown_keys:
        raise ValueError("managed-state receipt contains unknown fields")
    if require_complete:
        missing = allowed_keys - set(state)
        if missing:
            raise ValueError(
                "managed-state receipt is missing required fields: "
                + ", ".join(sorted(missing))
            )
    if _contains_private_mcp_field(state):
        raise ValueError("managed-state receipt contains forbidden private fields")
    version = state.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool) or version != SCHEMA_VERSION:
        raise ValueError(f"unsupported managed-state schema version: {version}")

    for key in ("harnessRoot", "harnessVersion", "agentDir"):
        if key in state and (not isinstance(state[key], str) or not state[key]):
            raise ValueError(f"managed-state {key} must be a non-empty string")
    if "agentDir" in state:
        recorded = Path(state["agentDir"]).expanduser().resolve(strict=False)
        expected = agent_root
        if recorded != expected:
            raise ValueError("managed-state agentDir does not match Pi agent directory")

    for collection in _COLLECTIONS:
        if collection in state and not isinstance(state[collection], list):
            raise ValueError(f"managed-state {collection} must be a list")

    targets = set()
    for collection in _FILESYSTEM_COLLECTIONS:
        for index, entry in enumerate(state.get(collection, [])):
            label = f"managed-state {collection}[{index}]"
            if not isinstance(entry, dict):
                raise ValueError(f"{label} must be an object")
            _require_entry_fields(entry, collection, label)
            if desired_state:
                target = _require_desired_target(
                    entry.get("target"), agent_dir, collection
                )
            else:
                target = _require_contained_target(entry.get("target"), agent_dir)
            if target in targets:
                raise ValueError(f"duplicate target in managed-state receipt: {target}")
            targets.add(target)
            installed = Path(target)
            agent = agent_root
            if collection == "agents" and installed != agent / "AGENTS.md":
                raise ValueError("managed-state AGENTS target is malformed")
            if collection == "extensions" and installed.parent != agent / "extensions":
                raise ValueError("managed-state extension target is malformed")
            if collection == "permissions":
                try:
                    installed.relative_to(agent / "permissions")
                except ValueError as error:
                    raise ValueError("managed-state permission target is malformed") from error
            if collection != "permissions":
                _require_string(entry, "source", label)
            else:
                _require_string(entry, "source", label, optional=True)
                digest = entry.get("sha256")
                if (
                    not isinstance(digest, str)
                    or len(digest) != 64
                    or any(character not in "0123456789abcdefABCDEF" for character in digest)
                ):
                    raise ValueError(f"{label} SHA-256 must contain 64 hexadecimal characters")
            if collection == "resources":
                kind = _require_string(entry, "kind", label)
                name = _require_string(entry, "name", label)
                if kind not in ("skills", "prompts"):
                    raise ValueError(f"{label} kind is unsupported")
                if installed != agent / "harness" / kind / name:
                    raise ValueError("managed-state resource target is malformed")

    setting_keys = set()
    for index, entry in enumerate(state.get("settings", [])):
        label = f"managed-state settings[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{label} must be an object")
        _require_entry_fields(entry, "settings", label)
        kind = _require_string(entry, "kind", label)
        if kind not in _MANAGED_SETTING_KINDS + _OBJECT_SETTING_KINDS:
            raise ValueError(f"{label} setting kind is unsupported")
        if kind in _OBJECT_SETTING_KINDS:
            value = entry.get("value")
            if not isinstance(value, dict) or not value:
                raise ValueError(f"{label} value must be a non-empty object")
        else:
            value = _require_string(entry, "value", label)
        key = (kind, _setting_identity(value))
        if key in setting_keys:
            raise ValueError(f"duplicate setting in managed-state receipt: {kind}")
        setting_keys.add(key)

    model_keys = set()
    for index, entry in enumerate(state.get("models", [])):
        label = f"managed-state models[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{label} must be an object")
        _require_entry_fields(entry, "models", label)
        provider = _require_string(entry, "provider", label)
        model = _require_string(entry, "model", label)
        value = entry.get("value")
        if not isinstance(value, dict) or not value:
            raise ValueError(f"{label} value must be a non-empty object")
        key = (provider, model)
        if key in model_keys:
            raise ValueError(
                f"duplicate model override in managed-state receipt: {provider}/{model}"
            )
        model_keys.add(key)

    mcp_names = set()
    for index, entry in enumerate(state.get("mcp", [])):
        label = f"managed-state mcp[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{label} must be an object")
        _require_entry_fields(entry, "mcp", label)
        name = _require_string(entry, "name", label)
        definition = entry.get("definition")
        if not isinstance(definition, dict):
            raise ValueError(f"{label} definition must be an object")
        if _contains_private_mcp_field(definition):
            raise ValueError(f"{label} contains forbidden private MCP fields")
        if name in mcp_names:
            raise ValueError(f"duplicate MCP server in managed-state receipt: {name}")
        mcp_names.add(name)

    packages = set()
    for index, package in enumerate(state.get("packages", [])):
        if not isinstance(package, str) or not package:
            raise ValueError(f"managed-state packages[{index}] must be a non-empty string")
        if package in packages:
            raise ValueError("duplicate package pin in managed-state receipt")
        packages.add(package)
    return state


def _manifest_object(path: Path, label: str) -> dict:
    payload = _read_json(path, label)
    if not isinstance(payload, dict):
        raise ValueError(f"invalid {label}: expected a JSON object")
    return payload


def build_desired_state(
    harness_root: Path, agent_dir: Path, *, manage_mcp: bool = True
) -> dict:
    root = harness_root.expanduser().resolve(strict=False)
    lexical_agent = _absolute_path(agent_dir)
    agent = _require_safe_agent_dir(agent_dir)
    resources_manifest = _manifest_object(
        root / "config" / "resources.json", "resource manifest"
    )
    required_mcp = _manifest_object(
        root / "config" / "required-mcp.json", "required MCP manifest"
    )
    servers = required_mcp.get("mcpServers")
    if not isinstance(servers, dict):
        raise ValueError("invalid required MCP manifest: mcpServers must be an object")
    if _contains_private_mcp_field(servers):
        raise ValueError("invalid required MCP manifest: private MCP fields are forbidden")

    state = {
        "schemaVersion": SCHEMA_VERSION,
        "harnessRoot": str(root),
        "harnessVersion": (root / "VERSION").read_text(encoding="utf-8").strip(),
        "agentDir": str(agent),
        "agents": [{
            "source": str(root / "AGENTS.md"),
            "target": str(agent / "AGENTS.md"),
        }],
        "resources": [],
        "extensions": [],
        "permissions": [],
        "settings": [],
        "mcp": [],
        "models": [],
        "packages": [],
    }
    if not state["harnessVersion"]:
        raise ValueError("harness VERSION is empty")

    for kind in ("skills", "prompts"):
        entries = resources_manifest.get(kind)
        if not isinstance(entries, list):
            raise ValueError(f"resource manifest {kind} must be a list")
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise ValueError(f"resource manifest {kind}[{index}] must be an object")
            name = _require_string(entry, "name", f"resource manifest {kind}[{index}]")
            source_raw = _require_string(
                entry, "source", f"resource manifest {kind}[{index}]"
            )
            source = (root / source_raw).resolve(strict=False)
            if not source.exists():
                raise ValueError(f"resource source does not exist: {source_raw}")
            target = agent / "harness" / kind / name
            raw_source = str(source)
            if target.is_symlink() and target.resolve(strict=False) == source:
                raw_source = os.readlink(target)
            state["resources"].append({
                "kind": kind,
                "name": name,
                "source": raw_source,
                "target": str(target),
            })
            setting_target = lexical_agent / "harness" / kind / name
            state["settings"].append({"kind": kind, "value": str(setting_target)})

    exclusions = resources_manifest.get("skillExclusions", [])
    if not isinstance(exclusions, list):
        raise ValueError("resource manifest skillExclusions must be a list")
    for index, entry in enumerate(exclusions):
        if not isinstance(entry, dict):
            raise ValueError(
                f"resource manifest skillExclusions[{index}] must be an object"
            )
        raw_path = _require_string(
            entry, "path", f"resource manifest skillExclusions[{index}]"
        )
        value = f"-{Path(raw_path).expanduser().resolve(strict=False)}"
        state["settings"].append({"kind": "skills", "value": value})

    settings_defaults = _manifest_object(
        root / "config" / "settings-defaults.json",
        "settings defaults manifest",
    )
    if settings_defaults.get("schemaVersion") != 1:
        raise ValueError("settings defaults manifest must have schemaVersion 1")
    defaults = settings_defaults.get("settings")
    if not isinstance(defaults, dict) or not defaults:
        raise ValueError(
            "settings defaults manifest 'settings' must be a non-empty object"
        )
    for kind in sorted(defaults):
        if kind not in _OBJECT_SETTING_KINDS:
            raise ValueError(f"settings defaults manifest kind is unsupported: {kind}")
        value = defaults[kind]
        if not isinstance(value, dict) or not value:
            raise ValueError(
                f"settings defaults manifest {kind} must be a non-empty object"
            )
        state["settings"].append({"kind": kind, "value": value})

    models_defaults = _manifest_object(
        root / "config" / "models-defaults.json",
        "models defaults manifest",
    )
    if models_defaults.get("schemaVersion") != 1:
        raise ValueError("models defaults manifest must have schemaVersion 1")
    models = models_defaults.get("models")
    if not isinstance(models, dict) or not models:
        raise ValueError(
            "models defaults manifest 'models' must be a non-empty object"
        )
    for provider in sorted(models):
        provider_overrides = models[provider]
        if not isinstance(provider_overrides, dict) or not provider_overrides:
            raise ValueError(
                f"models defaults manifest provider {provider!r} must be a "
                "non-empty object"
            )
        for model in sorted(provider_overrides):
            value = provider_overrides[model]
            if not isinstance(value, dict) or not value:
                raise ValueError(
                    f"models defaults manifest {provider}/{model} must be a "
                    "non-empty object"
                )
            state["models"].append({
                "provider": provider,
                "model": model,
                "value": value,
            })

    extensions_dir = root / "extensions"
    if extensions_dir.exists():
        for source in sorted(extensions_dir.iterdir(), key=lambda item: item.name):
            resolved_source = source.resolve(strict=False)
            target = agent / "extensions" / source.name
            raw_source = str(resolved_source)
            if target.is_symlink() and target.resolve(strict=False) == resolved_source:
                raw_source = os.readlink(target)
            state["extensions"].append({
                "source": raw_source,
                "target": str(target),
            })

    permissions_dir = root / "permissions"
    permission_paths = sorted(
        path
        for path in permissions_dir.rglob("*")
        if path.is_file() and path.suffix in (".js", ".ts")
    )
    for source in permission_paths:
        relative = source.relative_to(permissions_dir)
        state["permissions"].append({
            "source": str(source.resolve(strict=False)),
            "target": str(agent / "permissions" / relative),
            "sha256": sha256_file(source),
        })

    for name in sorted(servers):
        definition = servers[name]
        if not isinstance(name, str) or not name or not isinstance(definition, dict):
            raise ValueError("required MCP server names and definitions must be objects")
        if manage_mcp:
            state["mcp"].append({"name": name, "definition": definition})

    package_path = root / "packages" / "pi-packages.txt"
    try:
        package_lines = package_path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ValueError(f"invalid package manifest: {error}") from error
    for line in package_lines:
        package = line.strip()
        if package and not package.startswith("#"):
            state["packages"].append(package)

    agents_target = agent / "AGENTS.md"
    if (
        agents_target.is_symlink()
        and agents_target.resolve(strict=False) == (root / "AGENTS.md").resolve(strict=False)
    ):
        state["agents"][0]["source"] = os.readlink(agents_target)

    return _validate_state(
        state, agent, desired_state=True, require_complete=True
    )


def load_receipt(path: Path, agent_dir: Path) -> dict | None:
    receipt_path = _validate_receipt_path(path, agent_dir)
    if not _path_exists(receipt_path):
        return None
    if receipt_path.is_symlink():
        raise ValueError("managed-state receipt must not be a symlink")
    if not receipt_path.is_file():
        raise ValueError("managed-state receipt must be a regular file")
    mode = stat.S_IMODE(receipt_path.stat().st_mode)
    if mode != 0o600:
        raise ValueError(
            f"managed-state receipt mode must be 0600, found {mode:04o}"
        )
    payload = _read_json(receipt_path, "managed-state receipt")
    if isinstance(payload, dict) and "models" not in payload:
        # Migration: receipts written before the models.json overrides feature
        # predate the `models` collection; default it so legacy receipts still
        # validate and reconcile.
        payload["models"] = []
    return _validate_state(payload, agent_dir, require_complete=True)


def _path_exists(path: Path) -> bool:
    return os.path.lexists(path)


def _filesystem_action(collection: str, entry: dict) -> dict:
    target = Path(entry["target"])
    if collection == "permissions":
        kind = "permission"
        if not _path_exists(target):
            status, detail = "absent", "recorded permission is absent"
        elif target.is_symlink() or not target.is_file():
            status, detail = "foreign", "path is not a regular permission file"
        elif sha256_file(target).lower() == entry["sha256"].lower():
            status, detail = "owned", "recorded permission hash matches"
        else:
            status, detail = "modified", "permission content differs from receipt"
    else:
        kind = "symlink"
        if not _path_exists(target):
            status, detail = "absent", "recorded symlink is absent"
        elif not target.is_symlink():
            status, detail = "foreign", "path is not a symlink"
        elif os.readlink(target) == entry["source"]:
            status, detail = "owned", "symlink target exactly matches recorded source"
        else:
            status, detail = "modified", "symlink target differs from recorded source"
    return {"kind": kind, "status": status, "target": str(target), "detail": detail}


def _agent_from_state(previous: dict, desired: dict) -> Path | None:
    raw = previous.get("agentDir") or desired.get("agentDir")
    return Path(raw) if isinstance(raw, str) and raw else None


def _setting_action(entry: dict, agent_dir: Path | None) -> dict:
    target = agent_dir / "settings.json" if agent_dir is not None else Path("settings.json")
    if agent_dir is None:
        status, detail = "foreign", "settings location is not recorded"
    elif not _path_exists(target):
        status, detail = "absent", "settings file is absent"
    elif target.is_symlink() or not target.is_file():
        status, detail = "foreign", "settings path is not a regular file"
    else:
        settings = _read_json_object_if_present(target, "Pi settings")
        value = entry["value"]
        if isinstance(value, dict):
            installed = settings.get(entry["kind"])
            if installed is None:
                status, detail = "absent", "recorded setting is absent"
            elif installed == value:
                status, detail = "owned", "exact recorded setting is present"
            else:
                status, detail = "modified", "setting differs from receipt"
        else:
            values = settings.get(entry["kind"])
            if values is None:
                status, detail = "absent", "recorded setting is absent"
            elif not isinstance(values, list):
                status, detail = "foreign", "settings field is not a list"
            elif entry["value"] in values:
                status, detail = "owned", "exact recorded setting is present"
            else:
                status, detail = "absent", "recorded setting is absent"
    return {"kind": "setting", "status": status, "target": str(target), "detail": detail}


def _mcp_action(entry: dict, agent_dir: Path | None) -> dict:
    target = agent_dir / "mcp.json" if agent_dir is not None else Path("mcp.json")
    if agent_dir is None:
        status, detail = "foreign", "MCP location is not recorded"
    elif not _path_exists(target):
        status, detail = "absent", "MCP configuration is absent"
    elif target.is_symlink() or not target.is_file():
        status, detail = "foreign", "MCP path is not a regular file"
    else:
        mcp = _read_json_object_if_present(target, "Pi MCP override")
        servers = mcp.get("mcpServers")
        if servers is None:
            status, detail = "absent", "recorded MCP server is absent"
        elif not isinstance(servers, dict):
            status, detail = "foreign", "MCP servers field is not an object"
        elif entry["name"] not in servers:
            status, detail = "absent", "recorded MCP server is absent"
        elif servers[entry["name"]] == entry["definition"]:
            status, detail = "owned", "exact recorded MCP definition is present"
        else:
            status, detail = "modified", "MCP definition differs from receipt"
    return {"kind": "mcp", "status": status, "target": str(target), "detail": detail}


def _models_action(entry: dict, agent_dir: Path | None) -> dict:
    target = agent_dir / "models.json" if agent_dir is not None else Path("models.json")
    if agent_dir is None:
        status, detail = "foreign", "models location is not recorded"
    elif not _path_exists(target):
        status, detail = "absent", "models file is absent"
    elif target.is_symlink() or not target.is_file():
        status, detail = "foreign", "models path is not a regular file"
    else:
        models = _read_json_object_if_present(target, "Pi models")
        providers = models.get("providers")
        if not isinstance(providers, dict):
            status, detail = "foreign", "models providers field is not an object"
        else:
            provider = providers.get(entry["provider"])
            overrides = (
                provider.get("modelOverrides") if isinstance(provider, dict) else None
            )
            installed = overrides.get(entry["model"]) if isinstance(overrides, dict) else None
            if installed is None:
                status, detail = "absent", "recorded model override is absent"
            elif installed == entry["value"]:
                status, detail = "owned", "exact recorded model override is present"
            else:
                status, detail = "modified", "model override differs from receipt"
    return {"kind": "model-override", "status": status, "target": str(target), "detail": detail}


def _identity(collection: str, entry: object) -> object:
    if collection in _FILESYSTEM_COLLECTIONS:
        return entry["target"]
    if collection == "settings":
        return (entry["kind"], _setting_identity(entry["value"]))
    if collection == "mcp":
        return entry["name"]
    if collection == "models":
        return (entry["provider"], entry["model"])
    return entry


def _stale_entries(previous: dict, desired: dict):
    for collection in _COLLECTIONS:
        desired_ids = {
            _identity(collection, entry) for entry in desired.get(collection, [])
        }
        for entry in previous.get(collection, []):
            if _identity(collection, entry) not in desired_ids:
                yield collection, entry


def _classify_entry(
    collection: str, entry: object, agent_dir: Path | None
) -> dict:
    if collection in _FILESYSTEM_COLLECTIONS:
        return _filesystem_action(collection, entry)
    if collection == "settings":
        return _setting_action(entry, agent_dir)
    if collection == "mcp":
        return _mcp_action(entry, agent_dir)
    if collection == "models":
        return _models_action(entry, agent_dir)
    return {
        "kind": "package",
        "status": "report-only",
        "target": entry,
        "detail": "removed package pins require manual package management",
    }


def classify_stale(previous: dict, desired: dict) -> list[dict]:
    agent_dir = _agent_from_state(previous, desired)
    return [
        _classify_entry(collection, entry, agent_dir)
        for collection, entry in _stale_entries(previous, desired)
    ]


def _describe(action: dict, dry_run: bool = False) -> str:
    prefix = "DRY-RUN: " if dry_run else ""
    kind = action["kind"]
    status = action["status"]
    if kind == "package":
        return f"{prefix}REPORT: stale package pin requires manual package management"
    if status in ("modified", "foreign"):
        return f"{prefix}WARNING: leaving {status} {kind} state at {action['target']}"
    if status == "report-only":
        return f"{prefix}REPORT: leaving {kind} configuration unchanged"
    if status == "absent":
        return f"{prefix}No action: {kind} state is already absent at {action['target']}"
    return f"{prefix}Owned {kind} state at {action['target']}"


def _backup_destination(target: Path, agent_dir: Path, backup_dir: Path) -> Path:
    installed = _installed_path(target)
    root = _require_safe_agent_dir(agent_dir)
    try:
        relative = installed.relative_to(root)
    except ValueError as error:
        raise ValueError(f"refusing to back up target outside Pi agent directory: {target}") from error
    return _absolute_path(backup_dir) / relative


def _mode_allows_directory_mutation(path: Path) -> bool:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return False
    return bool(mode & 0o222) and bool(mode & 0o111) and os.access(
        path, os.W_OK | os.X_OK
    )


def _validate_backup_destination(destination: Path, backup_dir: Path) -> None:
    root = _absolute_path(backup_dir)
    destination = _absolute_path(destination)
    relative = _path_relative_to(destination, root)
    if relative is None or not relative.parts:
        raise ValueError("backup destination is not physically contained beneath backup root")

    if root.is_symlink():
        raise ValueError("backup root must not be a symlink")
    if _path_exists(root) and not root.is_dir():
        raise ValueError("backup root is not a directory")

    current = root
    # Ancestry is checked whether or not the root already exists. A root
    # created beneath a symlinked parent still satisfies the physical
    # containment check below, because the destination and the root moved
    # together: containment cannot detect that the whole tree was relocated.
    # The walk stops at the first existing ancestor, so it never climbs into
    # platform symlinks such as macOS /var -> /private/var.
    ancestor = root.parent
    while not ancestor.exists():
        if ancestor.is_symlink():
            raise ValueError("backup ancestry must not contain symlinks")
        ancestor = ancestor.parent
    if ancestor.is_symlink():
        raise ValueError("backup ancestry must not contain symlinks")
    if not ancestor.is_dir():
        raise ValueError("backup ancestry contains a path that is not a directory")
    existing_parent = root if root.exists() else ancestor

    for component in relative.parts[:-1]:
        current /= component
        if current.is_symlink():
            raise ValueError("backup ancestry must not contain symlinks")
        if _path_exists(current):
            if not current.is_dir():
                raise ValueError("backup ancestry contains a path that is not a directory")
            existing_parent = current

    if destination.is_symlink():
        raise ValueError(f"backup target already exists as a symlink: {destination}")
    if _path_exists(destination):
        raise ValueError(f"backup target already exists: {destination}")

    physical_root = root.resolve(strict=False)
    physical_destination = destination.parent.resolve(strict=False) / destination.name
    if _path_relative_to(physical_destination, physical_root) is None:
        raise ValueError("backup destination is not physically contained beneath backup root")
    if existing_parent is None or not _mode_allows_directory_mutation(existing_parent):
        raise ValueError(f"backup destination parent is not writable: {destination.parent}")


def _validate_config_mutation_path(path: Path, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} path must be a regular file, not a symlink")
    parent = path.parent
    if parent.is_symlink() or not parent.is_dir():
        raise ValueError(f"{label} parent must be a non-symlink directory")
    if not _mode_allows_directory_mutation(parent):
        raise ValueError(f"{label} parent is not writable")


def _validate_owned_move_source(path: Path) -> None:
    if not _path_exists(path):
        raise ValueError(f"owned managed-state source disappeared before mutation: {path}")
    parent = path.parent
    if parent.is_symlink() or not parent.is_dir():
        raise ValueError(f"managed-state source parent is not a directory: {parent}")
    if not _mode_allows_directory_mutation(parent):
        raise ValueError(f"managed-state source parent is not writable: {parent}")


def _move_owned_path(target: Path, agent_dir: Path, backup_dir: Path) -> None:
    destination = _backup_destination(target, agent_dir, backup_dir)
    if _path_exists(destination):
        raise ValueError(f"backup target already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(destination))


def _write_config_with_backup(
    path: Path, payload: dict, agent_dir: Path, backup_dir: Path
) -> None:
    destination = _backup_destination(path, agent_dir, backup_dir)
    if _path_exists(destination):
        raise ValueError(f"backup target already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, destination)
    mode = stat.S_IMODE(path.stat().st_mode)
    atomic_json_write(path, payload, mode=mode)


def _validate_backup_requirements(
    stale: list[tuple[str, object, dict]],
    agent_dir: Path,
    backup_dir: Path,
    keep_mcp: bool = False,
    receipt_path: Path | None = None,
) -> None:
    destinations = []
    for collection, _entry, action in stale:
        if collection in _FILESYSTEM_COLLECTIONS and action["status"] == "owned":
            destinations.append(
                _backup_destination(Path(action["target"]), agent_dir, backup_dir)
            )
    if any(
        collection == "settings" and action["status"] == "owned"
        for collection, _entry, action in stale
    ):
        destinations.append(backup_dir / "settings.json")
    if any(
        collection == "models" and action["status"] == "owned"
        for collection, _entry, action in stale
    ):
        destinations.append(backup_dir / "models.json")
    if not keep_mcp and any(
        collection == "mcp" and action["status"] == "owned"
        for collection, _entry, action in stale
    ):
        destinations.append(backup_dir / "mcp.json")
    if receipt_path is not None and _path_exists(receipt_path):
        destinations.append(_backup_destination(receipt_path, agent_dir, backup_dir))
    if len(destinations) != len(set(destinations)):
        raise ValueError("managed-state operations contain duplicate backup targets")
    for destination in destinations:
        _validate_backup_destination(destination, backup_dir)
    for collection, _entry, action in stale:
        if collection in _FILESYSTEM_COLLECTIONS and action["status"] == "owned":
            _validate_owned_move_source(Path(action["target"]))
    if receipt_path is not None and _path_exists(receipt_path):
        _validate_owned_move_source(receipt_path)

    if any(
        collection == "settings" and action["status"] == "owned"
        for collection, _entry, action in stale
    ):
        _validate_config_mutation_path(agent_dir / "settings.json", "Pi settings")
    if any(
        collection == "models" and action["status"] == "owned"
        for collection, _entry, action in stale
    ):
        _validate_config_mutation_path(agent_dir / "models.json", "Pi models")
    if not keep_mcp and any(
        collection == "mcp" and action["status"] == "owned"
        for collection, _entry, action in stale
    ):
        _validate_config_mutation_path(agent_dir / "mcp.json", "Pi MCP override")


def _apply_config_reconciliation(
    stale: list[tuple[str, object, dict]],
    agent_dir: Path,
    backup_dir: Path,
    dry_run: bool,
    keep_mcp: bool = False,
) -> None:
    setting_entries = [
        entry for collection, entry, action in stale
        if collection == "settings" and action["status"] == "owned"
    ]
    if setting_entries and not dry_run:
        path = agent_dir / "settings.json"
        settings = _read_json_object_if_present(path, "Pi settings")
        for entry in setting_entries:
            value = entry["value"]
            if isinstance(value, dict):
                if settings.get(entry["kind"]) == value:
                    settings.pop(entry["kind"])
                continue
            values = settings.get(entry["kind"])
            if isinstance(values, list) and entry["value"] in values:
                settings[entry["kind"]] = [
                    item for item in values if item != entry["value"]
                ]
                if not settings[entry["kind"]]:
                    settings.pop(entry["kind"])
        _write_config_with_backup(path, settings, agent_dir, backup_dir)

    mcp_entries = [
        entry for collection, entry, action in stale
        if collection == "mcp" and action["status"] == "owned"
    ]
    if mcp_entries and not dry_run and not keep_mcp:
        path = agent_dir / "mcp.json"
        mcp = _read_json_object_if_present(path, "Pi MCP override")
        servers = mcp.get("mcpServers")
        if isinstance(servers, dict):
            for entry in mcp_entries:
                if servers.get(entry["name"]) == entry["definition"]:
                    servers.pop(entry["name"])
            if not servers:
                mcp.pop("mcpServers", None)
        _write_config_with_backup(path, mcp, agent_dir, backup_dir)

    model_entries = [
        entry for collection, entry, action in stale
        if collection == "models" and action["status"] == "owned"
    ]
    if model_entries and not dry_run:
        path = agent_dir / "models.json"
        models = _read_json_object_if_present(path, "Pi models")
        providers = models.get("providers")
        if isinstance(providers, dict):
            for entry in model_entries:
                provider = providers.get(entry["provider"])
                overrides = (
                    provider.get("modelOverrides")
                    if isinstance(provider, dict)
                    else None
                )
                if (
                    isinstance(overrides, dict)
                    and overrides.get(entry["model"]) == entry["value"]
                ):
                    overrides.pop(entry["model"])
                    if not overrides and isinstance(provider, dict):
                        provider.pop("modelOverrides", None)
                    if isinstance(provider, dict) and not provider:
                        providers.pop(entry["provider"], None)
            if not providers:
                models.pop("providers", None)
        _write_config_with_backup(path, models, agent_dir, backup_dir)


def _settings_need_install_update(
    settings: dict, desired: dict, harness_root: Path, agent_dir: Path
) -> bool:
    for kind in _MANAGED_SETTING_KINDS:
        values = settings.get(kind) or []
        legacy = {
            str(harness_root.resolve(strict=False) / kind),
            str(_absolute_path(agent_dir) / "harness" / kind),
        }
        if any(value in legacy for value in values):
            return True
    for entry in desired["settings"]:
        value = entry["value"]
        if isinstance(value, dict):
            if settings.get(entry["kind"]) != value:
                return True
        elif entry["value"] not in (settings.get(entry["kind"]) or []):
            return True
    return False


def _models_need_install_update(models: dict, desired: dict) -> bool:
    for entry in desired["models"]:
        providers = models.get("providers")
        if not isinstance(providers, dict):
            return True
        provider = providers.get(entry["provider"])
        overrides = (
            provider.get("modelOverrides") if isinstance(provider, dict) else None
        )
        if not isinstance(overrides, dict) or overrides.get(entry["model"]) != entry["value"]:
            return True
    return False


def _install_displacement_targets(
    harness_root: Path,
    agent_dir: Path,
    lexical_agent_dir: Path,
    desired: dict,
    *,
    manage_mcp: bool,
) -> tuple[list[Path], list[Path]]:
    agent = _require_safe_agent_dir(agent_dir)
    filesystem_targets: list[Path] = []
    config_targets: list[Path] = []
    displaced_containers: set[Path] = set()

    for kind in _MANAGED_SETTING_KINDS:
        if not any(entry["kind"] == kind for entry in desired["resources"]):
            continue
        container = agent / "harness" / kind
        if _path_exists(container) and (container.is_symlink() or not container.is_dir()):
            filesystem_targets.append(container)
            displaced_containers.add(container)

    for collection in _FILESYSTEM_COLLECTIONS:
        for entry in desired[collection]:
            target = Path(entry["target"])
            if any(_path_relative_to(target, container) is not None for container in displaced_containers):
                continue
            if not _path_exists(target):
                continue
            action = _filesystem_action(collection, entry)
            if action["status"] != "owned":
                filesystem_targets.append(target)

    pair_target = agent / "extensions" / "pair.ts"
    pair_source = harness_root.resolve(strict=False) / "extensions" / "pair.ts"
    if (
        _path_exists(pair_target)
        and pair_target.is_symlink()
        and pair_target.resolve(strict=False) == pair_source.resolve(strict=False)
        and pair_target not in filesystem_targets
    ):
        filesystem_targets.append(pair_target)

    settings_path = agent / "settings.json"
    if _path_exists(settings_path):
        settings = _read_json_object_if_present(settings_path, "Pi settings")
        if _settings_need_install_update(
            settings, desired, harness_root, lexical_agent_dir
        ):
            config_targets.append(settings_path)

    models_path = agent / "models.json"
    if _path_exists(models_path):
        models = _read_json_object_if_present(models_path, "Pi models")
        if _models_need_install_update(models, desired):
            config_targets.append(models_path)

    mcp_path = agent / "mcp.json"
    if manage_mcp and _path_exists(mcp_path):
        mcp = _read_json_object_if_present(mcp_path, "Pi MCP override")
        servers = mcp.get("mcpServers") or {}
        if any(
            not isinstance(servers.get(entry["name"]), dict)
            or any(
                servers[entry["name"]].get(key) != value
                for key, value in entry["definition"].items()
            )
            for entry in desired["mcp"]
        ):
            config_targets.append(mcp_path)
    return filesystem_targets, config_targets


def _validate_install_displacements(
    harness_root: Path,
    agent_dir: Path,
    lexical_agent_dir: Path,
    backup_dir: Path,
    desired: dict,
    *,
    manage_mcp: bool,
) -> None:
    filesystem_targets, config_targets = _install_displacement_targets(
        harness_root,
        agent_dir,
        lexical_agent_dir,
        desired,
        manage_mcp=manage_mcp,
    )
    destinations = [
        _backup_destination(target, agent_dir, backup_dir)
        for target in filesystem_targets + config_targets
    ]
    if len(destinations) != len(set(destinations)):
        raise ValueError("install displacement plan contains duplicate backup targets")
    for destination in destinations:
        _validate_backup_destination(destination, backup_dir)
    for target in filesystem_targets:
        _validate_owned_move_source(target)
    for target in config_targets:
        _validate_config_mutation_path(target, target.name)


def preflight_reconcile_install(
    harness_root: Path,
    agent_dir: Path,
    backup_dir: Path,
    *,
    manage_mcp: bool = True,
) -> None:
    previous, desired, _actions = _install_preflight(
        harness_root, agent_dir, manage_mcp=manage_mcp
    )
    lexical_agent = _absolute_path(agent_dir)
    agent = _require_safe_agent_dir(agent_dir)
    _validate_install_displacements(
        harness_root,
        agent,
        lexical_agent,
        backup_dir,
        desired,
        manage_mcp=manage_mcp,
    )
    if previous is None:
        return

    stale = [
        (collection, entry, _classify_entry(collection, entry, agent))
        for collection, entry in _stale_entries(previous, desired)
    ]
    _validate_backup_requirements(stale, agent, backup_dir)


def reconcile_install(
    previous: dict,
    desired: dict,
    agent_dir: Path,
    backup_dir: Path,
    dry_run: bool,
) -> list[str]:
    _validate_state(previous, agent_dir)
    _validate_state(desired, agent_dir, desired_state=True)
    stale = []
    for collection, entry in _stale_entries(previous, desired):
        stale.append((collection, entry, _classify_entry(collection, entry, agent_dir)))

    messages = [_describe(action, dry_run) for _, _, action in stale]
    if dry_run:
        return messages

    _validate_backup_requirements(stale, agent_dir, backup_dir)
    for collection, _entry, action in stale:
        if collection in _FILESYSTEM_COLLECTIONS and action["status"] == "owned":
            _move_owned_path(Path(action["target"]), agent_dir, backup_dir)
    _apply_config_reconciliation(stale, agent_dir, backup_dir, dry_run=False)
    return messages


def write_receipt(path: Path, state: dict) -> None:
    if not isinstance(state, dict):
        raise ValueError("managed-state receipt must be a JSON object")
    raw_agent = state.get("agentDir")
    if isinstance(raw_agent, str) and raw_agent:
        agent_dir = _absolute_path(Path(raw_agent))
    elif path.name == RECEIPT_RELATIVE.name and path.parent.name == "harness":
        agent_dir = _absolute_path(path.parent.parent)
    else:
        raise ValueError("managed-state receipt target is outside Pi agent directory")
    agent = _require_safe_agent_dir(agent_dir)
    _validate_state(state, agent, require_complete=True)
    lexical_path = _absolute_path(path)
    expected = agent / RECEIPT_RELATIVE
    physical_candidate = lexical_path.parent.resolve(strict=False) / lexical_path.name
    if physical_candidate != expected:
        raise ValueError("managed-state receipt target is outside Pi agent directory")
    _reject_symlink_components(
        lexical_path, _absolute_path(agent_dir), "managed-state receipt"
    )
    if lexical_path.is_symlink():
        raise ValueError("managed-state receipt must not be a symlink")
    physical_path = lexical_path.parent.resolve(strict=False) / lexical_path.name
    if _path_relative_to(physical_path, agent) is None:
        raise ValueError("managed-state receipt target is outside Pi agent directory")
    atomic_json_write(lexical_path, state, mode=0o600)


def _validate_active_configuration(agent_dir: Path) -> None:
    settings = _read_json_object_if_present(agent_dir / "settings.json", "Pi settings")
    for kind in ("skills", "prompts"):
        if kind in settings and not isinstance(settings[kind], list):
            raise ValueError(f"invalid Pi settings: {kind} must be a list")
    for kind in _OBJECT_SETTING_KINDS:
        if kind in settings and not isinstance(settings[kind], dict):
            raise ValueError(f"invalid Pi settings: {kind} must be an object")
    mcp = _read_json_object_if_present(agent_dir / "mcp.json", "Pi MCP override")
    if "mcpServers" in mcp and not isinstance(mcp["mcpServers"], dict):
        raise ValueError("invalid Pi MCP override: mcpServers must be an object")
    models = _read_json_object_if_present(agent_dir / "models.json", "Pi models")
    if "providers" in models and not isinstance(models["providers"], dict):
        raise ValueError("invalid Pi models: providers must be an object")


def _validate_legacy_uninstall_backups(
    harness_root: Path,
    agent_dir: Path,
    backup_dir: Path,
    *,
    keep_mcp: bool,
) -> None:
    config_targets: list[Path] = []
    settings_path = agent_dir / "settings.json"
    if _path_exists(settings_path):
        config_targets.append(settings_path)

    mcp_path = agent_dir / "mcp.json"
    if not keep_mcp and _path_exists(mcp_path):
        mcp = _read_json_object_if_present(mcp_path, "Pi MCP override")
        servers = mcp.get("mcpServers") or {}
        required = _manifest_object(
            harness_root / "config" / "required-mcp.json", "required MCP manifest"
        ).get("mcpServers") or {}
        if any(servers.get(name) == definition for name, definition in required.items()):
            config_targets.append(mcp_path)

    for target in config_targets:
        _validate_backup_destination(
            _backup_destination(target, agent_dir, backup_dir), backup_dir
        )
        _validate_config_mutation_path(target, target.name)


def preflight_uninstall(
    harness_root: Path,
    agent_dir: Path,
    keep_mcp: bool = False,
    backup_dir: Path | None = None,
) -> dict:
    agent = _require_safe_agent_dir(agent_dir)
    build_desired_state(harness_root, agent_dir)
    _validate_active_configuration(agent)
    receipt_path = agent / RECEIPT_RELATIVE
    receipt = load_receipt(receipt_path, agent)
    if receipt is None:
        if backup_dir is not None:
            _validate_legacy_uninstall_backups(
                harness_root,
                agent,
                backup_dir,
                keep_mcp=keep_mcp,
            )
        return {
            "agentDir": str(agent),
            "receiptPath": str(receipt_path),
            "receipt": None,
            "actions": [],
            "keepMcp": keep_mcp,
        }
    empty = {"schemaVersion": SCHEMA_VERSION, "agentDir": str(agent)}
    actions = classify_stale(receipt, empty)
    if keep_mcp:
        for action in actions:
            if action["kind"] == "mcp":
                action["status"] = "report-only"
                action["detail"] = "MCP cleanup disabled by request"
    if backup_dir is not None:
        stale = [
            (collection, entry, _classify_entry(collection, entry, agent))
            for collection, entry in _stale_entries(receipt, empty)
        ]
        _validate_backup_requirements(
            stale,
            agent,
            backup_dir,
            keep_mcp=keep_mcp,
            receipt_path=receipt_path,
        )
    return {
        "agentDir": str(agent),
        "receiptPath": str(receipt_path),
        "receipt": receipt,
        "actions": actions,
        "keepMcp": keep_mcp,
    }


def _reduced_receipt(receipt: dict, preserved: list[tuple[str, object]]) -> dict:
    reduced = {
        "schemaVersion": receipt["schemaVersion"],
        "harnessRoot": receipt["harnessRoot"],
        "harnessVersion": receipt["harnessVersion"],
        "agentDir": receipt["agentDir"],
        **{collection: [] for collection in _COLLECTIONS},
    }
    for collection, entry in preserved:
        reduced[collection].append(entry)
    return reduced


def apply_uninstall(plan: dict, dry_run: bool) -> list[str]:
    receipt = plan.get("receipt")
    if receipt is None:
        return ["No managed-state receipt found; legacy cleanup remains required."]
    agent_dir = Path(plan["agentDir"])
    _validate_state(receipt, agent_dir, require_complete=True)
    backup_raw = plan.get("backupDir")
    if not isinstance(backup_raw, str) or not backup_raw:
        raise ValueError("uninstall plan requires a backup directory")
    backup_dir = Path(backup_raw)
    keep_mcp = bool(plan.get("keepMcp", False))

    empty = {"schemaVersion": SCHEMA_VERSION, "agentDir": str(agent_dir)}
    stale = []
    preserved: list[tuple[str, object]] = []
    for collection, entry in _stale_entries(receipt, empty):
        base_action = _classify_entry(collection, entry, agent_dir)
        action = base_action
        if (
            base_action["status"] in ("modified", "foreign")
            and not (keep_mcp and collection == "mcp")
        ):
            preserved.append((collection, entry))
        if keep_mcp and collection == "mcp":
            if base_action["status"] != "absent":
                preserved.append((collection, entry))
            action = {
                "kind": "mcp",
                "status": "report-only",
                "target": str(agent_dir / "mcp.json"),
                "detail": "MCP cleanup disabled by request",
            }
        stale.append((collection, entry, action))

    messages = [_describe(action, dry_run) for _, _, action in stale]
    if keep_mcp and any(collection == "mcp" for collection, _, _ in stale):
        messages.append(
            ("DRY-RUN: " if dry_run else "")
            + "REPORT: keeping MCP configuration by request"
        )
    if dry_run:
        messages.append(f"DRY-RUN: would back up managed-state receipt at {plan['receiptPath']}")
        if preserved:
            messages.append("DRY-RUN: would retain reduced managed-state receipt")
        return messages

    receipt_path = _validate_receipt_path(Path(plan["receiptPath"]), agent_dir)
    if receipt_path != _absolute_path(agent_dir / RECEIPT_RELATIVE):
        raise ValueError("managed-state receipt target is outside Pi agent directory")
    _validate_backup_requirements(
        stale,
        agent_dir,
        backup_dir,
        keep_mcp=keep_mcp,
        receipt_path=receipt_path,
    )
    for collection, _entry, action in stale:
        if collection in _FILESYSTEM_COLLECTIONS and action["status"] == "owned":
            _move_owned_path(Path(action["target"]), agent_dir, backup_dir)
    _apply_config_reconciliation(
        stale, agent_dir, backup_dir, dry_run=False, keep_mcp=keep_mcp
    )

    if receipt_path.exists():
        _move_owned_path(receipt_path, agent_dir, backup_dir)
        messages.append(f"Backed up managed-state receipt at {receipt_path}")
    if preserved:
        reduced = _reduced_receipt(receipt, preserved)
        write_receipt(receipt_path, reduced)
        messages.append(f"Retained reduced managed-state receipt at {receipt_path}")
    return messages


def _install_preflight(
    harness_root: Path,
    agent_dir: Path,
    *,
    manage_mcp: bool = True,
) -> tuple[dict | None, dict, list[dict]]:
    agent = _require_safe_agent_dir(agent_dir)
    desired = build_desired_state(
        harness_root, agent_dir, manage_mcp=manage_mcp
    )
    _validate_active_configuration(agent)
    previous = load_receipt(agent / RECEIPT_RELATIVE, agent)
    if not manage_mcp and previous is not None:
        desired["mcp"] = list(previous["mcp"])
    actions = classify_stale(previous, desired) if previous is not None else []
    return previous, desired, actions


def _add_shared_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--harness-root", required=True, type=Path)
    parser.add_argument("--agent-dir", required=True, type=Path)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("preflight-install", "write-receipt"):
        command = subparsers.add_parser(name)
        _add_shared_arguments(command)
        command.add_argument("--skip-mcp", action="store_true")

    preflight_reconcile = subparsers.add_parser("preflight-reconcile-install")
    _add_shared_arguments(preflight_reconcile)
    preflight_reconcile.add_argument("--backup-dir", required=True, type=Path)
    preflight_reconcile.add_argument("--skip-mcp", action="store_true")

    reconcile = subparsers.add_parser("reconcile-install")
    _add_shared_arguments(reconcile)
    reconcile.add_argument("--backup-dir", required=True, type=Path)
    reconcile.add_argument("--dry-run", action="store_true")
    reconcile.add_argument("--skip-mcp", action="store_true")

    preflight_uninstall_parser = subparsers.add_parser("preflight-uninstall")
    _add_shared_arguments(preflight_uninstall_parser)
    preflight_uninstall_parser.add_argument("--backup-dir", required=True, type=Path)
    preflight_uninstall_parser.add_argument("--keep-mcp", action="store_true")

    apply = subparsers.add_parser("apply-uninstall")
    _add_shared_arguments(apply)
    apply.add_argument("--backup-dir", required=True, type=Path)
    apply.add_argument("--dry-run", action="store_true")
    apply.add_argument("--keep-mcp", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "preflight-install":
            previous, _desired, actions = _install_preflight(
                args.harness_root,
                args.agent_dir,
                manage_mcp=not args.skip_mcp,
            )
            if previous is None:
                print("No existing managed-state receipt found.")
            else:
                for action in actions:
                    print(_describe(action))
                if not actions:
                    print("Managed-state receipt already matches desired state.")
        elif args.command == "preflight-reconcile-install":
            preflight_reconcile_install(
                args.harness_root,
                args.agent_dir,
                args.backup_dir,
                manage_mcp=not args.skip_mcp,
            )
            print("Managed-state reconciliation preflight passed.")
        elif args.command == "reconcile-install":
            previous, desired, _actions = _install_preflight(
                args.harness_root,
                args.agent_dir,
                manage_mcp=not args.skip_mcp,
            )
            if previous is None:
                print("No existing managed-state receipt to reconcile.")
            else:
                messages = reconcile_install(
                    previous,
                    desired,
                    _require_safe_agent_dir(args.agent_dir),
                    args.backup_dir,
                    args.dry_run,
                )
                for message in messages or ["No stale managed state to reconcile."]:
                    print(message)
        elif args.command == "write-receipt":
            agent = _require_safe_agent_dir(args.agent_dir)
            previous, state, _actions = _install_preflight(
                args.harness_root,
                args.agent_dir,
                manage_mcp=not args.skip_mcp,
            )
            receipt_path = agent / RECEIPT_RELATIVE
            write_receipt(receipt_path, state)
            print(f"Wrote managed-state receipt at {receipt_path}")
        elif args.command == "preflight-uninstall":
            plan = preflight_uninstall(
                args.harness_root,
                args.agent_dir,
                keep_mcp=args.keep_mcp,
                backup_dir=args.backup_dir,
            )
            if plan["receipt"] is None:
                print("No managed-state receipt found; legacy cleanup remains required.")
            else:
                for action in plan["actions"]:
                    print(_describe(action))
                if not plan["actions"]:
                    print("Managed-state receipt contains no installed state.")
        elif args.command == "apply-uninstall":
            plan = preflight_uninstall(
                args.harness_root,
                args.agent_dir,
                keep_mcp=args.keep_mcp,
                backup_dir=args.backup_dir,
            )
            plan["backupDir"] = str(args.backup_dir)
            for message in apply_uninstall(plan, args.dry_run):
                print(message)
        return 0
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
