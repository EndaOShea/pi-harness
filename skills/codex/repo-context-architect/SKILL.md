---
name: repo-context-architect
description: Analyze a new or existing software repository and create or repair a progressive-disclosure documentation system for AI coding CLIs. Use when starting a project, onboarding an agent to an existing repository, replacing oversized README/AGENTS.md/CLAUDE.md files, documenting modules, or making repository guidance work across Codex, Claude Code, Gemini CLI, GitHub Copilot, Cursor, and other coding agents. Do not use for ordinary code changes that do not involve repository structure or agent guidance.
---

# Repository Context Architect

Create a small, durable repository map that routes humans and AI coding agents to focused documentation without loading the whole codebase or a monolithic instruction file into context.

## Core design

Use one canonical documentation hierarchy:

1. Root `AGENTS.md`: concise cross-tool repository map and global rules.
2. `docs/`: detailed architecture, development, testing, workflows, and decisions.
3. Module-level `AGENTS.md`: local responsibility, entry points, invariants, dependencies, tests, and common mistakes.
4. Thin CLI adapters: `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, and optional Cursor rules point to the canonical guidance rather than duplicating it.
5. `.repo-context.yaml`: machine-readable module map and maintenance policy.

Treat source code and executable configuration as authoritative. Never invent commands, architecture, dependencies, or invariants.

## Mandatory behaviour

- Inspect before writing.
- Preserve useful existing documentation.
- Never replace a large file blindly.
- Prefer links and routing over duplicated prose.
- Create module documentation only at meaningful architectural boundaries.
- Keep root guidance small enough to load every session.
- Put detailed or rarely needed material in linked documents.
- Mark uncertain findings as `TODO(confirm)` rather than guessing.
- Do not describe tests as passing unless they were run successfully.
- Do not modify product code while setting up repository context unless explicitly asked.

## Workflow

### 1. Establish repository root

Use Git when available:

```bash
git rev-parse --show-toplevel
```

Otherwise use the current working directory.

Check repository status before edits:

```bash
git status --short
```

Do not overwrite unrelated uncommitted work.

### 2. Inventory the repository

Read, where present:

- existing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
- `.github/copilot-instructions.md`
- `.cursor/rules/` and `.cursorrules`
- root `README*`, `CONTRIBUTING*`, `Makefile`, `Taskfile*`, `justfile`
- package/build manifests
- CI workflows
- container and deployment files
- test configuration
- top-level and second-level directory names

Use targeted discovery. Exclude generated/vendor/cache directories such as:

```text
.git node_modules vendor dist build target .venv venv __pycache__
.next .cache coverage .terraform
```

Do not begin by reading every source file.

### 3. Identify meaningful module boundaries

A module normally deserves local guidance when it is one of:

- independently deployable service
- package/library with its own public interface
- frontend, backend, worker, CLI, or infrastructure subsystem
- data ingestion, retrieval, model, or evaluation pipeline
- generated-code area with special handling
- legacy subsystem with unusual constraints
- test suite requiring non-obvious setup

Do not create `AGENTS.md` files for generic folders such as `utils`, `constants`, or tiny directories unless they have distinct rules.

### 4. Run the scaffold helper

Preview first:

```bash
python3 scripts/setup_repo_context.py --repo . --dry-run
```

Apply after reviewing the proposed boundaries:

```bash
python3 scripts/setup_repo_context.py --repo .
```

Useful options:

```bash
python3 scripts/setup_repo_context.py --repo . --module services/api --module packages/core
python3 scripts/setup_repo_context.py --repo . --force-adapters
python3 scripts/setup_repo_context.py --repo . --audit
```

The script is deliberately conservative. It creates missing files and adapters, but it does not rewrite substantive existing documentation without explicit force options.

### 5. Complete the generated documents from evidence

Replace `TODO(confirm)` entries only after verifying them from source, manifests, CI, or working commands.

Root `AGENTS.md` must contain:

- repository purpose in 1–3 sentences
- compact repository map
- “start here by task” routing
- verified setup/build/test/lint commands
- global invariants and prohibited actions
- links to detailed docs

Each module `AGENTS.md` must contain:

- responsibility and non-responsibilities
- public entry points and important files
- local data/control flow
- dependencies and dependants when known
- invariants
- narrow verification commands
- generated files or migration rules
- common mistakes
- links to relevant ADRs/workflows

### 6. Configure all CLI adapters

Keep adapters thin. Their job is to direct the tool to canonical `AGENTS.md` and scoped docs.

- Codex: canonical `AGENTS.md` hierarchy.
- Claude Code: `CLAUDE.md` tells Claude to read root and nearest module `AGENTS.md`; install this skill under `.claude/skills/repo-context-architect/` when project-local discovery is needed.
- Gemini CLI: `GEMINI.md` points to `AGENTS.md`; Gemini can discover this skill through `.agents/skills`.
- GitHub Copilot: `.github/copilot-instructions.md` points to root and path-local guidance; optionally generate path-specific instruction files only when needed.
- Cursor: root `AGENTS.md` is the default shared guidance; use `.cursor/rules` only for Cursor-specific behaviour that cannot remain cross-tool.
- Unknown/new CLIs: they can be instructed to read `AGENTS.md`; avoid making the canonical source tool-specific.

Do not copy the full root guidance into every adapter.

### 7. Audit quality

Run:

```bash
python3 scripts/setup_repo_context.py --repo . --audit
```

Then verify:

- documented paths exist
- documented commands exist and, where safe, run
- no contradictory instructions exist across adapters
- root files remain concise
- module files are at real boundaries
- generated files are labelled
- stale or speculative text is removed

### 8. Report changes

Provide:

1. files created or updated
2. module boundaries selected and why
3. uncertain items left as `TODO(confirm)`
4. commands verified and their results
5. any oversized legacy documents that should be split later

## Size guidance

These are soft limits:

- root `AGENTS.md`: target 100–250 lines
- adapter files: target under 40 lines
- module `AGENTS.md`: target 60–180 lines
- one ADR per decision
- one workflow per repeatable procedure

When a root instruction file grows beyond its target, move explanations into `docs/` and retain only routing, commands, and invariants.

## Migration rules for existing repositories

When an existing root document is large:

1. classify each section as orientation, command, invariant, architecture, workflow, decision history, reference, or troubleshooting;
2. keep orientation, verified commands, routing, and global invariants in root guidance;
3. move architecture to `docs/architecture.md`;
4. move recurring procedures to `docs/workflows/`;
5. move decision rationale to `docs/decisions/`;
6. move subsystem details to the nearest module `AGENTS.md`;
7. replace moved content with links;
8. preserve Git history by moving content rather than deleting it where practical.

Never perform a wholesale rewrite merely to satisfy a line target.

## Reference material

Read `references/cli-compatibility.md` when creating adapters or deciding installation paths.
Read `references/content-model.md` when deciding what belongs in each document.
Use templates in `assets/` when the helper script is insufficient.
