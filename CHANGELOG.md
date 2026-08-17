# Changelog

All notable harness changes are recorded here. The project does not create a
release tag automatically; tagging remains an explicit maintainer action.

## Unreleased

- gated installation on a minimum Pi version (`MINIMUM_PI_VERSION` in
  `scripts/install.sh`, currently `0.84.1`). Three pinned packages import
  `@earendil-works/pi-ai/compat`, a subpath that first appears in
  pi-ai@0.81.0; without the gate an older Pi installed successfully and
  then failed to start. The check runs before any package is fetched or
  any file is written, and reports the upgrade command;
- extended the secret and destructive matchers: recursive searches rooted
  at credential or browser-profile directories, sensitive Windows Registry
  strings, environment-exposure commands, and secret paths named as shell
  operands now require approval, and the destructive fallbacks cover
  `tee` overwrites plus a fail-closed case for commands whose wrapper
  nesting exceeds the normalizer's budget. Ordinary files such as
  `/etc/hosts`, `~/.aws/config`, browser history, and committed `.env`
  examples stay free to avoid approval fatigue;
- fixed a type error in `permissions/confirm-deletions.ts`, which
  annotated a match's `commands` as a mutable `SimpleCommand[]` where the
  permissions API declares it `readonly`;
- added continuous-validation assertions for the workflow itself, so
  dropping the macOS matrix, the strict-mode environment, the exact
  runtime installs, or the validation command fails the suite rather than
  silently weakening CI;
- fixed the workspace boundary in `permissions/workspace-scope.ts`, which
  read `input.permissionRoot ?? input.cwd`. `permissionRoot` is the
  directory the policy module was loaded from — the evaluator injects it
  per hook alongside `cwd` — so the workspace was anchored to
  `~/.pi/agent/permissions` rather than the session's working tree: real
  project work read as outside the workspace, while writes into the
  permissions directory read as inside it. The policy now reads `cwd`, and
  the test supplies both keys with different values so reading the wrong
  one fails;
- exempted `/private/tmp` in `permissions/workspace-scope.ts`. macOS
  resolves `/tmp` through the `/private` symlink, so the existing `/tmp`
  prefix missed and every temp-file write prompted. This shipped
  undetected because continuous validation ran only on Linux;
- extended continuous validation to macOS as well as Linux, and made it
  strict: `HARNESS_REQUIRE_POLICY_INTEGRATION=1` now turns a skipped
  permission-policy integration test into a failure, and requires
  ShellCheck rather than skipping static analysis. CI installs the exact
  Pi runtime and pinned permissions package so the policies are exercised
  against the real library instead of being silently skipped;
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
  file-tool reads.

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
