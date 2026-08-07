#!/usr/bin/env python3
"""Conservatively scaffold and audit progressive repository context files."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

EXCLUDED = {
    ".git", "node_modules", "vendor", "dist", "build", "target", ".venv",
    "venv", "__pycache__", ".next", ".cache", "coverage", ".terraform",
    ".idea", ".vscode", ".tox", ".mypy_cache", ".pytest_cache"
}
BOUNDARY_NAMES = {
    "apps", "services", "packages", "modules", "components", "cmd", "internal",
    "backend", "frontend", "api", "worker", "workers", "infra", "infrastructure",
    "pipelines", "plugins"
}
MANIFESTS = {
    "pyproject.toml", "package.json", "Cargo.toml", "go.mod", "pom.xml",
    "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "mix.exs"
}

ROOT_TEMPLATE = """# Repository Guide

## Purpose

TODO(confirm): Describe what this repository does in 1–3 sentences.

## Repository map

{module_map}

## Start here by task

{task_map}

## Commands

- Setup: `TODO(confirm)`
- Narrow tests: `TODO(confirm)`
- Full validation: `TODO(confirm)`

## Global invariants

- TODO(confirm)

## Do not

- Do not edit generated files manually.
- Do not claim tests pass unless they were run successfully.
- Do not duplicate detailed documentation in CLI-specific adapter files.

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Testing](docs/testing.md)
- [Workflows](docs/workflows/)
- [Decisions](docs/decisions/)
"""

MODULE_TEMPLATE = """# Module Guide: {name}

## Responsibility

TODO(confirm)

## Not responsible for

- TODO(confirm)

## Entry points and important files

- `TODO(confirm)`

## Local flow

TODO(confirm)

## Dependencies and interfaces

- TODO(confirm)

## Invariants

- TODO(confirm)

## Verification

- Narrow tests: `TODO(confirm)`

## Generated files and migrations

- TODO(confirm)

## Common mistakes

- TODO(confirm)

## Related documentation

- [Repository guide]({root_link})
"""

DOC_TEMPLATES = {
    "docs/architecture.md": "# Architecture\n\nTODO(confirm): Describe system components, interfaces, and data/control flow.\n",
    "docs/development.md": "# Development\n\nTODO(confirm): Document verified environment setup and development workflow.\n",
    "docs/testing.md": "# Testing\n\nTODO(confirm): Document test levels, dependencies, fixtures, and verified commands.\n",
    "docs/workflows/README.md": "# Workflows\n\nAdd one repeatable procedure per Markdown file.\n",
    "docs/decisions/README.md": "# Architecture decisions\n\nAdd one decision record per file.\n",
}

ADAPTERS = {
    "CLAUDE.md": """# Claude Code repository guidance

Read `AGENTS.md` first. When working below a subsystem directory, also read the nearest applicable nested `AGENTS.md` before editing.

Use `docs/` only as routed by those guides or when the task requires deeper architecture, workflow, testing, or decision context.

`AGENTS.md` is the canonical cross-CLI source. Do not duplicate or contradict it here. Add only Claude-specific behaviour to this file.
""",
    "GEMINI.md": """# Gemini CLI repository guidance

Read `AGENTS.md` first. When working in a subsystem, read the nearest nested `AGENTS.md` before editing.

Use linked documents under `docs/` on demand. `AGENTS.md` is the canonical cross-CLI source; do not duplicate it here.
""",
    ".github/copilot-instructions.md": """# Repository instructions

Use `/AGENTS.md` as the canonical repository guide. Before changing files in a subsystem, locate and follow the nearest nested `AGENTS.md`.

Read detailed files under `/docs` only when routed there or required by the task. Do not duplicate canonical guidance in this adapter.
""",
}

@dataclass(frozen=True)
class Change:
    path: Path
    action: str


def find_root(value: str) -> Path:
    start = Path(value).expanduser().resolve()
    current = start
    while current != current.parent:
        if (current / ".git").exists():
            return current
        current = current.parent
    return start


def visible_dirs(path: Path) -> Iterable[Path]:
    try:
        for child in sorted(path.iterdir()):
            if child.is_dir() and child.name not in EXCLUDED and not child.name.startswith("."):
                yield child
    except PermissionError:
        return


def looks_like_module(path: Path) -> bool:
    if any((path / manifest).exists() for manifest in MANIFESTS):
        return True
    signals = {"src", "tests", "test", "lib", "app", "main.py", "Dockerfile"}
    names = {p.name for p in path.iterdir()} if path.exists() else set()
    return len(signals & names) >= 2 or "Dockerfile" in names


def detect_modules(root: Path) -> list[Path]:
    modules: list[Path] = []
    for top in visible_dirs(root):
        if top.name.lower() in BOUNDARY_NAMES:
            children = [p for p in visible_dirs(top) if looks_like_module(p)]
            modules.extend(children or ([top] if looks_like_module(top) else []))
        elif looks_like_module(top):
            modules.append(top)
    # Avoid excessive scaffolding.
    return modules[:24]


def rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def write_missing(path: Path, content: str, dry_run: bool, force: bool = False) -> Change | None:
    if path.exists() and not force:
        return None
    action = "update" if path.exists() else "create"
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and force:
            backup = path.with_suffix(path.suffix + ".bak")
            shutil.copy2(path, backup)
        path.write_text(content, encoding="utf-8")
    return Change(path, action)


def root_link(module: Path, root: Path) -> str:
    depth = len(module.relative_to(root).parts)
    return "../" * depth + "AGENTS.md"


def make_yaml(root: Path, modules: list[Path]) -> str:
    lines = [
        "version: 1",
        "canonical_instruction_file: AGENTS.md",
        "documentation_root: docs",
        "adapters:",
        "  - CLAUDE.md",
        "  - GEMINI.md",
        "  - .github/copilot-instructions.md",
        "modules:",
    ]
    if not modules:
        lines.append("  []")
    for module in modules:
        lines.extend([
            f"  - path: {rel(module, root)}",
            f"    guide: {rel(module / 'AGENTS.md', root)}",
            "    responsibility: TODO(confirm)",
            "    verification: TODO(confirm)",
        ])
    lines.extend([
        "maintenance:",
        "  root_agents_target_lines: 250",
        "  adapter_target_lines: 40",
        "  module_agents_target_lines: 180",
        "  uncertain_marker: TODO(confirm)",
    ])
    return "\n".join(lines) + "\n"


def scaffold(root: Path, explicit_modules: list[str], dry_run: bool, force_adapters: bool) -> list[Change]:
    modules = [root / m for m in explicit_modules] if explicit_modules else detect_modules(root)
    modules = [m.resolve() for m in modules if m.exists() and m.is_dir() and root in m.resolve().parents]

    module_map = "\n".join(f"- `{rel(m, root)}/` — TODO(confirm)" for m in modules) or "- `TODO(confirm)` — No module boundaries were detected automatically."
    task_map = "\n".join(f"- For work in `{rel(m, root)}/`, read `{rel(m / 'AGENTS.md', root)}`." for m in modules) or "- TODO(confirm): Add task-to-document routes."

    changes: list[Change] = []
    candidates = [
        write_missing(root / "AGENTS.md", ROOT_TEMPLATE.format(module_map=module_map, task_map=task_map), dry_run),
        write_missing(root / ".repo-context.yaml", make_yaml(root, modules), dry_run),
    ]
    for item in candidates:
        if item:
            changes.append(item)

    for relative, content in DOC_TEMPLATES.items():
        item = write_missing(root / relative, content, dry_run)
        if item:
            changes.append(item)

    for relative, content in ADAPTERS.items():
        item = write_missing(root / relative, content, dry_run, force=force_adapters)
        if item:
            changes.append(item)

    for module in modules:
        item = write_missing(
            module / "AGENTS.md",
            MODULE_TEMPLATE.format(name=rel(module, root), root_link=root_link(module, root)),
            dry_run,
        )
        if item:
            changes.append(item)

    return changes


def audit(root: Path) -> int:
    issues: list[str] = []
    required = ["AGENTS.md", "docs/architecture.md", "docs/development.md", "docs/testing.md"]
    for relative in required:
        if not (root / relative).exists():
            issues.append(f"missing: {relative}")

    for relative, limit in [("AGENTS.md", 250), ("CLAUDE.md", 40), ("GEMINI.md", 40), (".github/copilot-instructions.md", 40)]:
        path = root / relative
        if path.exists():
            count = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
            if count > limit:
                issues.append(f"oversized: {relative} has {count} lines (target {limit})")

    markdown_files = [p for p in root.rglob("*.md") if not any(part in EXCLUDED for part in p.parts)]
    link_pattern = re.compile(r"\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)")
    for path in markdown_files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for target in link_pattern.findall(text):
            if "://" in target or target.startswith("mailto:"):
                continue
            resolved = (path.parent / target).resolve()
            if root not in resolved.parents and resolved != root:
                continue
            if not resolved.exists():
                issues.append(f"broken link: {rel(path, root)} -> {target}")

    adapters = [root / p for p in ADAPTERS if (root / p).exists()]
    for adapter in adapters:
        if "AGENTS.md" not in adapter.read_text(encoding="utf-8", errors="replace"):
            issues.append(f"adapter does not route to AGENTS.md: {rel(adapter, root)}")

    report = {"repo": str(root), "status": "ok" if not issues else "issues", "issues": issues}
    print(json.dumps(report, indent=2))
    return 0 if not issues else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Repository path")
    parser.add_argument("--module", action="append", default=[], help="Explicit module path relative to repo; repeatable")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    parser.add_argument("--force-adapters", action="store_true", help="Replace CLI adapter files and save .bak backups")
    parser.add_argument("--audit", action="store_true", help="Audit existing context files")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = find_root(args.repo)
    if args.audit:
        return audit(root)
    changes = scaffold(root, args.module, args.dry_run, args.force_adapters)
    mode = "would change" if args.dry_run else "changed"
    if not changes:
        print("No files changed. Existing substantive files were preserved.")
        return 0
    print(f"Repository: {root}")
    for change in changes:
        print(f"{mode}: {change.action} {rel(change.path, root)}")
    print("Review all TODO(confirm) markers against repository evidence.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
