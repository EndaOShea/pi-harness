# Changelog

All notable harness changes are recorded here. The project does not create a
release tag automatically; tagging remains an explicit maintainer action.

## 0.1.0-rc.8 - 2026-08-17

- added `test_documentation_does_not_restate_stale_skill_provenance`, which
  holds the prose to `config/third-party-skills.json`. Both this repository and
  the harness it is ported from had the same defect: the manifest is
  machine-checked and never drifted, while the documents restating its contents
  named `4.0.4` after the tree moved to `4.1.1`. The test rejects any
  `skill-vX.Y.Z` tag or declared version in a root or `docs/` Markdown file
  that the manifest no longer records, and requires `THIRD_PARTY_NOTICES.md` to
  carry the current version, tag, and upstream commit. `CHANGELOG.md` is out of
  scope as a historical record. Verified by reintroducing each stale state and
  confirming the test fails on each;
- narrowed the CI triggers to `pull_request`, pushes to `main`, and the weekly
  Impeccable check, and made in-flight runs cancel on branches but never on
  `main`. An unfiltered `push` alongside `pull_request` ran the whole matrix
  twice for every push to a branch with an open PR — two ubuntu jobs and two
  macOS jobs where one of each was needed. Pushing a branch with no PR now
  runs nothing, which is the intent: validate locally while the work is being
  shaped, in CI when it is proposed. Actions minutes are free on this public
  repository, but the duplication is wasted queue time either way, and a fork
  kept private pays for it at a 10x macOS multiplier. Documented in `README.md`
  (When CI runs);
- refreshed the Impeccable provenance the `skill-v4.1.1` adoption left behind.
  `THIRD_PARTY_NOTICES.md` and `docs/CAPABILITIES.md` still named `4.0.4` and
  the 4.0.4 commit, and the staged-comparison example in `README.md` still
  passed `--release skill-v4.0.4` — an argument an operator copies and types,
  so a stale tag there re-downloads the superseded release. Both documents now
  also record the skill's one outbound call to `impeccable.style/api/roll`,
  the `IMPECCABLE_API_URL` control point, and the fact that
  `confirm-egress.ts` does not match it: it gates shell transfer programs
  rather than node scripts, so the call is recorded rather than enforced;
- corrected the local-model discovery description in `docs/CAPABILITIES.md`,
  which still called registered metadata "conservative (32k context
  assumption)" after `extensions/local-models.ts` began probing the real
  window — Ollama's `/api/ps` for what the server is actually honoring, LM
  Studio's `/api/v0/models`. 32k is now only the fallback for a model the
  probe cannot cover.

## 0.1.0-rc.7 - 2026-08-17

- adopted Impeccable `skill-v4.1.1` (from `skill-v4.0.4`): 57 changed files,
  2 added, 2 removed, verified byte-identical to the upstream release archive
  through the staged checker. Reviewed for new capability before adoption.
  `concept-seed.mjs` now makes one outbound GET to
  `https://impeccable.style/api/roll`, sending only scope, mode, grain,
  platform, a `crypto.randomBytes(4)` seed and a re-roll counter — no project
  files, prompts, or conversation — and failing closed to a degraded local
  roll; override or disable it with `IMPECCABLE_API_URL`. That fetch is not
  matched by `confirm-egress.ts`, which gates shell transfer programs rather
  than node scripts, so it is recorded in provenance rather than enforced.
  `lib/open-system-browser.mjs` is new and spawns `open`/`xdg-open` through
  argv with no shell, on an internally built `http://127.0.0.1:<port>/` URL,
  with a `--no-open` opt-out. Forks that do not want the roll service should
  set `IMPECCABLE_API_URL` to an unroutable value;
- derived the Impeccable checker test's release tag and content hash from
  `config/third-party-skills.json` instead of repeating them. Hard-coded
  constants meant every skill update failed that test for the wrong reason;
- added a schema-versioned managed-state receipt
  (`$PI_AGENT_DIR/harness/.managed-state.json`, mode `0600`) and
  `scripts/lib/managed_state.py`. Install and uninstall now act only on
  state this checkout can prove it owns — exact link targets, permission
  hashes, setting values, MCP definitions — so a harness default can be
  retuned across existing installations while anything the operator changed
  is preserved with a warning. A removed package pin is reported rather
  than silently uninstalled;
- added TypeScript type checking (`tsconfig.json`, `scripts/typecheck.sh`),
  wired into `validate.sh` and mandatory in CI. `node --check` only parses;
  it cannot see that a handler's parameter no longer matches the shape
  `@thurstonsand/pi-permissions` declares. Module resolution is generated
  rather than committed, because pi-permissions is installed into
  `$PI_AGENT_DIR/npm/node_modules`, ships raw `.ts` as its types, and needs
  its `@earendil-works/pi-coding-agent` peer resolved too. An absent
  toolchain exits 127: a skip locally, an error under
  `HARNESS_REQUIRE_POLICY_INTEGRATION=1`;
- added rate-limit telemetry and a TPM governor
  (`extensions/tpm-telemetry.ts`) behind a `/tpm` command, plus a context
  budget guard (`extensions/context-budget.ts`). Breaches come from request
  rate rather than request size, so the governor holds an outbound request
  when the provider's own reported budget cannot cover it, claiming its
  estimated cost before sending so concurrent Pi processes see each other.
  Fail-open throughout: absent evidence reads as a full bucket, holds are
  bounded, aborts cut them short, and any internal error passes the request
  through unmodified;
- added `config/settings-defaults.json` (retry policy, with provider-level
  SDK retries declared at zero) and `config/models-defaults.json` (per-model
  `contextWindow`), merged at install time. Both are payload — retune them
  for the models and provider tier your fork uses;
- taught `extensions/local-models.ts` to probe each discovered Ollama and
  LM Studio model's real context length instead of registering every model
  at a fixed placeholder;
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
