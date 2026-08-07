---
name: scaffold-docs-updater
description: Use when the user wants the current project to keep its README.md / CLAUDE.md / AGENTS.md automatically in sync with code changes, or asks to set up a "docs-updater" / "docs-sync" subagent, or an auto-commit / pre-commit hook that updates docs. Scaffolds a project-tailored subagent plus a pre-commit hook into the repo you are in.
---

# scaffold-docs-updater

## Overview

Generates, **inside whatever project the invoking session is in**, a `docs-updater` subagent tailored to that project plus a `PreToolUse` hook that runs it automatically before every `git commit`. The subagent keeps the repo's docs (`README.md`, and `CLAUDE.md` and/or `AGENTS.md`) in agreement with the code being committed.

**Core principle: tailor, don't template.** The whole point is that the generated subagent names *this* project's real doc files, stack, directories, and invariants — not a generic stub. A generic docs-updater is worse than none, because it documents guesses. Probe the project first, then write.

## When to Use

- User says "set up the docs-updater here", "add doc auto-sync to this project", "create a tailored docs subagent", or invokes this skill by name.
- A new repo needs the same auto-doc-maintenance workflow another project already has.

Do **not** use for a one-off doc edit (just edit the file), or to install a *global* hook (this skill is deliberately per-project — a global docs hook spawns a paid agent on every commit in every repo).

## Procedure

Work in the current working directory (the target repo). Create a todo per step.

### 1. Probe the project — never assume

Gather the facts the tailored subagent must reference. Run these and read results:

- **Doc files that exist:** check for `README.md`, `CLAUDE.md`, `AGENTS.md` (root and `.claude/`). Record which exist. If none of the engineering-doc files exist, tell the user and ask whether to still proceed (README-only sync) or create a `CLAUDE.md`/`AGENTS.md` first.
- **Stack & package manager:** `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `Gemfile`, lockfiles, framework hints.
- **Shape:** top-level dirs, where source vs tests vs migrations vs infra live, any monorepo layout.
- **Existing conventions:** skim the existing `CLAUDE.md`/`AGENTS.md` for its voice, section structure, and any invariant/anchor style to match.
- **Git:** confirm it's a git repo (`git rev-parse --git-dir`); if not, tell the user and stop (no commit hook without git).

### 2. Write `.claude/agents/docs-updater.md` (tailored)

Use the template in `references/agent-template.md`, then **replace every `{{…}}` placeholder** with facts from step 1 — the actual doc filenames this repo uses, its stack, its real directories, and (if the repo has a `CLAUDE.md`/`AGENTS.md` with invariants) a line telling the agent to preserve them. Keep frontmatter `model: sonnet`, `effort: high`, and the read-only-plus-edit tool set. Match the existing docs' voice.

If `.claude/agents/docs-updater.md` already exists, show the user the current one and ask before overwriting.

### 3. Wire the pre-commit hook into `.claude/settings.local.json`

**REQUIRED BACKGROUND:** follow the update-config skill's rules for editing settings files (read-before-write, merge arrays never replace, validate JSON after).

- Read the existing `.claude/settings.local.json` (create `{}` if missing).
- Merge the hook object from `references/hook.json` into `.hooks.PreToolUse` (append to the existing `Bash` matcher's `hooks` array if one exists; do not clobber other hooks or `permissions`).
- The hook's `if: "Bash(git commit*)"` and `type: "agent"` pointing at `.claude/agents/docs-updater.md` are load-bearing — keep them.
- Ensure `.claude/settings.local.json` is gitignored (add it to `.gitignore` if absent) — it's the personal-scope file and this hook is a personal workflow choice.

### 4. Validate & report

- `jq empty .claude/settings.local.json` must pass.
- `jq -e '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[] | select(.type=="agent")' .claude/settings.local.json` must print the hook.
- Report: which doc files the subagent targets, that the hook is wired, and the two caveats below.

## Caveats to always tell the user

1. **Activation:** if this created/updated `.claude/settings.local.json`, the settings watcher may need a nudge — open `/hooks` once or restart if the next commit doesn't trigger it.
2. **`effort: high` is a subagent-file field, not a hook field** — the auto pre-commit run uses Sonnet at default reasoning; the `high` effort applies when the subagent is invoked manually via the Agent tool.
3. **Commit as a standalone `git commit`** — the `if` filter matches commands *starting with* `git commit`, so `git add … && git commit …` compound commands won't trigger it.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Writing a generic subagent with no project specifics | Probe first (step 1); name real files, dirs, stack. |
| Replacing `settings.local.json` instead of merging | Read first, merge into arrays. |
| Pointing the hook at a global `~/.claude/agents/…` path | Keep it project-relative `.claude/agents/docs-updater.md`. |
| Installing the hook globally | This skill is per-project by design; refuse global installs. |
| Overwriting an existing `docs-updater.md` silently | Show it, ask first. |
