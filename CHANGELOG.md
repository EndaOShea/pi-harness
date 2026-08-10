# Changelog

All notable harness changes are recorded here. The project does not create a
release tag automatically; tagging remains an explicit maintainer action.

## Unreleased

- upgraded the required web research extension to `pi-web-access@0.19.0`,
  retaining exact package pinning while gaining its stricter remote-fetch
  routing, grounded answer mode, raw fetch mode, and bounded content search;
- added a disabled, optional Playwright MCP application template pinned to
  `@playwright/mcp@0.0.79`; it uses headless isolated Firefox by default and
  exposes an explicit tool allowlist that omits file transfer and arbitrary
  JavaScript execution;
- gated outbound transmission: uploads, raw network transfers, rsync to
  remote targets, and `git push` require per-call approval
  (`confirm-egress.ts`), with localhost destinations exempt;
- resolved file-tool paths through symlinks before permission matching, so
  a symlink inside the workspace cannot launder access to protected
  directories, secret files, or locations outside the workspace;
- scoped the agent to its workspace: a new `workspace-scope` permission
  policy requires per-call approval for file-tool writes and shell path
  references outside the session's working tree (OS temp directories
  exempt), with a matching workspace-scope rule in the operating contract;
- made Superpowers an explicit escalation layer in the operating contract:
  workflows are invoked only for work that warrants a plan, never for
  conversation, questions, or single-file minor edits, overriding
  skill-internal always-invoke bootstrap instructions;
- hardened credential protection: `~/.pi` (Pi's authentication store, MCP
  override, and settings) is now a protected directory for file-tool writes,
  and shell commands referencing secret paths (`cat ~/.pi/agent/auth.json`,
  dotenv files, private keys) require the same per-call approval as
  file-tool reads;
- added `extensions/pair.ts` and its `/pair` command, pairing a local-model
  session with a frontier model as reviewer or orchestrator: `/pair review
  [model]` keeps the session on its local model and has the pi-subagents
  watchdog review each turn's changes with the frontier model at thinking
  high, while `/pair orchestrate [model]` switches the main session to the
  frontier model and sets `subagents.defaultModel` to the local model so
  `/run` subagents keep executing locally; `/pair off` restores every
  setting the pairing changed from recorded prior values, `/pair status`
  reports current state, and `/pair default [model]` sets or reports the
  default frontier model, which otherwise falls back to the newest
  authenticated OpenAI reasoning model (or the newest authenticated
  OpenAI model, if none is reasoning-capable); both modes persist in
  `~/.pi/agent/settings.json` until turned off, and a session-start warning
  surfaces a pairing left active by an earlier session.

## 0.1.0-rc.6 - 2026-08-08

- fixed a critical promise short-circuit in `confirm-deletions.ts` that
  left five of its six matchers unreachable, and worked around an
  upstream `hasFlag("--")` sentinel bug for `git checkout --`;
- ported file-tool enforcement from the upstream harness: per-call
  approval for Write/Edit into protected directories and Read/Grep of
  secret-shaped files, with a generic protected-directory list that
  forks extend;
- added handler-level integration tests for the permission policies
  (skipped where the pi-permissions library is absent) and CI-safe pure
  matcher tests.

## 0.1.0-rc.5 - 2026-08-07

- ported local model provider support from the upstream harness: a
  harness-managed Pi extension discovers running Ollama and LM Studio
  servers at session start and registers their models; llama.cpp is
  documented as Pi-native;
- extended installer validation to verify installed extension links.

## 0.1.0-rc.4 - 2026-08-07

- extracted this repository as the public, forkable template of the harness,
  rebuilt on a clean history;
- removed personal skills and personal MCP servers; the remaining skills,
  packages, contract, and MCP declarations are a generic example payload;
- generalized the operating contract's protected-paths list into a
  fork-customizable set of examples;
- added `docs/FORKING.md` describing the machinery/payload split and exactly
  what to replace in a fork;
- added a private-reference guard test (`PRIVATE_REFERENCE_MARKERS`) that
  forks extend with their own hostnames, IP addresses, and internal names;
- genericized the MCP examples to Context7 plus a disabled local-launcher
  placeholder, with guidance for documenting fork-specific servers.

## 0.1.0-rc.3 - 2026-08-07

- added a repository `LICENSE` (MIT) alongside the third-party notices;
- pinned Superpowers by the immutable commit of release `v6.1.1` instead of
  the mutable tag, and added a test rejecting tag-pinned git sources;
- closed permission-hook gaps the operating contract already promised:
  nested-shell deletion (`bash -c 'rm …'`), `rsync --delete`, `dd`
  overwrites, `git stash drop`/`clear`, forced branch deletion, and forced
  pushes; fixed the dead Perl branch in the interpreter pattern and gated
  `git checkout -f`;
- restored five files missing from the legacy Impeccable import and verified
  the vendored tree byte-identical to the upstream `skill-v4.0.4` release
  archive, updating the recorded provenance hash;
- added an ownership-checked uninstaller (`scripts/uninstall.sh`) with dry
  run, settings and MCP cleanup, backups, and isolated tests;
- added a drift test keeping the shared `skills/claude` and `skills/codex`
  trees byte-identical;
- added ShellCheck to validation and CI, and a TypeScript parse check for the
  permission policy on Node.js 22.6 or newer;
- changed the scheduled Impeccable update check to open or update a tracking
  issue instead of failing the workflow;
- made passing tests remove their `/tmp` fixtures while failing tests retain
  them, and hardened a dry-run process substitution in the installer to fail
  loudly.

## 0.1.0-rc.2 - 2026-08-07

- added the official Superpowers Pi package pinned to immutable release
  `v6.1.1`;
- made Impeccable an explicitly documented required curated skill;
- recorded Impeccable's immutable skill release and commit, and added a
  non-mutating staged release checker;
- added Context7 as a required lazy MCP server with non-destructive global
  configuration merging;
- documented first installation, update, verification, backup, rollback, and
  release readiness, and consolidated the legacy MCP guides;
- changed permission deployment from symlinks to verified regular-file copies
  so `pi-permissions` discovers the harness policy, and separated direct and
  indirect deletion checks into two loader-valid modules;
- added Pi-only exact exclusions for native optimizer duplicates so the
  harness copies load without skill-collision warnings.

## 0.1.0-rc.1 - 2026-08-07

- replaced the concatenated installer with one validated, dry-run-safe flow;
- added isolated installer and repository validation tests;
- consolidated the global operating contract;
- introduced a curated, collision-free Pi resource manifest;
- added preflight reporting for collisions with existing user skill paths;
- made Impeccable part of the intended global Pi resource set;
- pinned Pi package versions;
- hardened deletion permission matching;
- added a reviewed skill-discovery workflow and third-party provenance data;
- made MCP placeholder files valid JSON;
- added continuous validation with GitHub Actions.
