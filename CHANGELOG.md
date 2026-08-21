# Changelog

All notable harness changes are recorded here. The project does not create a
release tag automatically; tagging remains an explicit maintainer action.

## Unreleased

- moved agent run artifacts out of the repositories they were being written
  into. The Playwright template now passes `--output-dir /tmp/pi-playwright`
  with a 64MB `--output-max-size`; without it the server creates
  `.playwright-mcp/` inside whatever repository the session started in.
  Observed rather than theorised: one real project accumulated 13 capture
  files and 92 subagent transcripts as untracked droppings, and the agent
  then swept all 105 into a commit — the `git add -A` the contract forbids,
  producing a 109-file commit of which 4 files were the actual work. The temp
  directory is already exempt from workspace-scope approval, so relocation
  gates nothing, and the size cap means the store evicts instead of waiting
  for someone to notice and delete it;
- documented `subagents.artifactDir: "session"` as the equivalent fix for
  subagent artifacts, which `pi-subagents` writes to
  `<cwd>/.pi-subagents/artifacts/` by default. The `"session"` value stores
  them under Pi's session directory and hands them to the age-based cleanup
  that already runs there, so placement and retention are solved by one
  setting rather than by a deletion routine the harness would have to own.
  It is deliberately NOT added to `config/settings-defaults.json`: that
  manifest owns a whole top-level key, and `subagents` is a key the user's
  own tooling writes — `/subagents`, `/subagents-load-profile`, and every
  `agentOverrides` edit — so declaring it would make the next such edit fail
  installation preflight as a conflict. A one-key manual setting is the
  smaller cost;
- recorded the rule that produced both of the above: the harness never adds
  a `.gitignore` entry to a user's project for its own artifacts. A
  repository should not have to carry a rule about the agent that visited
  it, and writing into a project's tracked files to tidy up after ourselves
  is the same overreach as replacing its vendored dependencies. The
  artifacts move; the repository is left alone;

- bounded the cost of choosing a skill. The contract already overrode skill bootstrap text for *invoking* a
  Superpowers workflow, and that rule works — but it says nothing about the
  deliberation spent deciding. Observed on an installed harness answering
  "create a README file": the agent reached the correct conclusion, reopened
  it four times, and spent several hundred words arguing with a skill's own
  red-flag table ("this is overkill" listed as rationalisation to overcome)
  before doing the obvious thing. `### Skills` now states that a trigger is
  a claim about relevance and not a deliberation budget, that a check
  returning "not applicable" is not reopened, and that a trivial task takes
  a skill's judgement without its ceremony. Ending in the right answer does
  not make the argument free;

- stopped heredoc bodies being read as shell syntax by the indirect-deletion
  matcher. Nothing in `permissions/lib/` parsed heredocs, so every `>` inside
  one matched the truncating-redirection pattern: `cat >> spec.js <<'EOF'`
  gated on the arrow functions in the body, and a markdown report gated on
  its blockquotes. Both are appends. Nothing was being truncated, and writing
  a file this way is among the most common things an agent does — `=>`
  appears in virtually all modern JavaScript and `>` opens every markdown
  blockquote. Found in a real session rather than by review: two headless
  subagents in one project hit it, where a gate is not a prompt but a silent
  failure, so the work simply did not happen. Bodies are now blanked before
  the lexical view is built, which has to happen first because that view
  rewrites the quoted delimiter (`<<'EOF'`) marking where a body begins.
  Two exemptions are deliberately not widened into hiding places: the marker
  line itself is kept, so `cat > important.txt <<'EOF'` still gates on its
  truncating redirect, and the interpreter, perl, xargs and nested-shell
  patterns still read the RAW command, so a heredoc carrying
  `shutil.rmtree` is still caught. Secret matching is untouched, living in
  `path-matchers.js`. An unterminated heredoc blanks the remainder, which is
  what the shell would do with it and executes nothing. Eight cases added,
  two of them the must-still-gate shapes;

- added a `Recommendations` rule to the contract's reporting section: a
  report that presents options must name the one to take, give one or two
  sentences of reasoning, and state the condition that would change it. The
  contract already required options to be *labelled* once there were three
  or more, but nothing anywhere required a position, and in practice that
  produced menus — the investigation done, the conclusion withheld. That
  hands the analytical work back to the user, who holds less context on the
  code than the agent that just read it, and it hides the assessment behind
  a list: a recommendation can be argued with and corrected, where "here are
  three approaches" cannot. Deferring stays available where the decision
  genuinely turns on information the agent lacks — preference, risk
  appetite, business context — but "it depends" alone is not an answer:
  name the fact that decides it and make the recommendation conditional on
  that fact. The rule applies to two options as readily as to ten, since the
  reference-code threshold governs labelling rather than whether a position
  is owed;

- stopped the test suite writing into the operator's real audit log.
  `permissions/lib/audit.ts` and `extensions/lib/harness-log.ts` resolve
  their destination as `PI_AGENT_DIR || ~/.pi/agent`, and the
  policy-integration helper launched its subprocesses without setting that
  variable, so every policy executed under test appended a genuine-looking
  `request` record to the real log. On the machine where this was found
  that was 1578 records in one day and 1724 the day before — 100% of the
  log, against zero records from any real session. The cost is not disk: a
  synthetic decision indistinguishable from a live one destroys the log's
  premise as replayable policy evidence, and makes `/approvals` report
  volume that never happened, which defeats the instrument added for
  exactly that question one commit earlier. The suite now allocates one
  isolated agent directory at import and exports `PI_AGENT_DIR` to it,
  covering every subprocess that inherits the environment including ones
  added later, where patching the existing call sites would not. Tests
  needing a specific directory still pass their own `env` and win. A guard
  asserts the variable is set, is not the real profile, that a policy's
  record lands in the isolated log, and that the real log's files do not
  change size across the call. Note the three similarly named variables
  kept distinct: `PI_AGENT_DIR` is the harness's own and is what is
  isolated here; `PI_CODING_AGENT_DIR` is what Pi reads for its profile
  and nothing in `permissions/` or `extensions/` consults it; and
  `PI_AGENT_NPM_DIR` stays derived from the real home on purpose, because
  the fixture builder needs the genuinely installed `pi-permissions`;

- added `/approvals`, which reads the audit log back as approval-gate
  load. Every gate in this harness is approval *assistance* rather than
  isolation, so the way the layer actually fails is not an evaded matcher
  but an operator who has approved two hundred prompts and stopped
  reading — and that risk was documented while being entirely unmeasured,
  which is the wrong pair. The audit log already held every number needed
  to see it happening. The command reports gates raised this session and
  today across processes, a breakdown by policy and by matched rule, how
  they resolved, and the approval rate, warning above twenty gates at a
  ninety per cent or higher rate and naming the policy raising most of
  them. The rate is the headline rather than the count, because a gate
  approved essentially every time has stopped carrying information whether
  it fired five times or five hundred, and the by-policy breakdown is what
  says which rule to narrow. It lives in `extensions/audit-log.ts` rather
  than in `/tpm`: that command is the rate-limit dashboard, and this is the
  audit extension's own data. Two limits are printed in the output because
  they bound what the numbers may claim — it counts gates *raised* rather
  than prompts a human saw, since policies are evaluated independently and
  one tool call can raise several, and the approved figure is derived by
  subtracting rejections, policy blocks and headless auto-blocks from
  gates raised rather than by pairing a `request` record to an `outcome`
  record, that correlation being by adjacency and already documented as
  unreliable. `registerCommand` is declared optional on the extension's
  minimal API so a caller that only wires events stays valid, the read of
  today's file is byte-capped so a runaway session cannot stall the
  report, and `PI_AUDIT=0` silences the report along with the writing;

- gated the authenticated-CLI upload channels in `findEgressCommands`.
  `gh`, `aws`, `gcloud`/`gsutil`, `az` and `rclone` ship on developer
  machines already holding credentials, which makes them a shorter route
  off the machine than curl, and none of them was matched: `gh gist create
  dump.sql` and `aws s3 cp dump.sql s3://bucket/` both ran unprompted.
  This is the one gap the secret-read policy could not backstop, because
  that layer gates secret-*shaped* paths and a file the agent assembled
  itself is not one — transmission is the last point at which such a file
  is still gateable. Only upload subcommands are listed, and where the
  subcommand does not itself fix the direction the last operand must name
  a remote, so `aws s3 cp s3://bucket/f .`, `aws s3 ls` and `gh pr list`
  stay free: gating every invocation of these tools would spend approval
  attention on status checks, which is how a gate stops being read.
  Options are dropped rather than positionally parsed and the subcommand
  is sought as a contiguous run in what remains, so a global option
  carrying a value (`aws --profile prod s3 cp …`) does not shift the
  subcommand out of view. Sixteen cases were added, six of them the
  download and read shapes that must not match;
- closed the pipe-into-shell route past the indirect-deletion matcher.
  `bash -c 'rm -rf x'` was gated as "nested shell deletion", but its
  sibling `echo 'rm -rf /' | sh` was not: the pattern required a `-c`
  flag, and a pipeline hands the shell its script on stdin instead. The
  new "pipeline into shell" pattern matches a visible deletion word
  followed by a pipe into a bare `sh`/`bash`/`zsh`/`dash`/`ksh`, through
  an optional `sudo` and any number of `command`/`env`/`exec` wrappers.
  A lookbehind keeps the deletion word from matching inside `--rm` or
  `confirm`, either of which would otherwise turn `docker run --rm x | sh`
  into a prompt and spend approval attention on nothing. Only deletion
  text visible in the command matches: `curl … | sh` is opaque to any
  lexical matcher, and the fetch it depends on is already the egress
  policy's to gate, so this does not pretend to cover it. Six cases were
  added, three of them the false-positive shapes;

- closed the audit log's blind spot on indirect deletion. Four of the five
  installed permission policies recorded a `request` row as they returned a
  decision; `permissions/destructive-patterns.js` did not, so interpreter,
  `xargs`, `dd`, `tee` and truncating-redirection approvals raised a prompt
  and left no cause behind — only the downstream `outcome` row, readable as
  an effect with nothing explaining it. That was the worst of the five to
  omit, since those are the indirect routes a direct-command matcher is
  specifically there to backstop. The policy now appends the same redacted
  record the others do, with the matched pattern name as the rule
  (`xargs deletion`); the names are constants defined in
  `permissions/lib/destructive-patterns.js` and never derived from the
  command text, which is the same argument `confirm-deletions.ts` already
  makes for its own rule strings. Two guards keep it that way: a structural
  one asserting every top-level policy module imports and calls the
  appender, pinned to the exact five-module set so adding a sixth is a
  deliberate act, and a runtime one loading the policy through the same
  jiti fixture the other policy-integration tests use, asserting the record
  names the pattern and that a canary token from the command never reaches
  the log;
- corrected rsync remote-target detection in `findEgressCommands`. The
  matcher required `user@host:`, so the equally valid `host:/dest` — no
  user given — transferred off the machine with no approval prompt, and the
  test suite only ever exercised the `user@host:` form, so nothing caught
  it. The rule is now rsync's own: a colon before any slash makes the
  operand remote. Excluding `-`, `=` and `/` before that colon keeps
  options (`--out-format=%f:%l`), absolute destinations, and local paths
  that merely contain a colon (`src/a:b`) unflagged, and `host::module`
  daemon syntax matches on its first colon. Seven cases were added around
  the two that existed. This narrows a gap the secret-path policy does not
  backstop: that layer gates secret-*shaped* paths, so an agent-assembled
  file — a dump, a scratch export — was passing both layers;

- brought `README.md` back in line with the three changes that landed after it
  was last touched: `AGENTS.override.md` as the per-directory way to scope a
  deviation, the restored private-reference guard named by its list and file
  and described as reading `git ls-files` rather than the working tree, and
  the `PI_AGENT_DIR`/`PI_CODING_AGENT_DIR` distinction beside the preview
  command that uses the first of them;
- restored `test_no_private_reference_markers_in_tracked_files` and the
  `PRIVATE_REFERENCE_MARKERS` list, which `README.md` and `docs/FORKING.md`
  had both been promising since it disappeared. The guard shipped in
  `0.1.0-rc.4` and was dropped in the rc.8 cycle by the commit that replaced
  this suite wholesale with the upstream one; that commit lists what it
  deliberately removed — the eval instrument, undeclared protected
  directories — and never mentions this, so it went as collateral rather
  than by decision. The gap mattered more than an ordinary missing test:
  both documents told a forker that committing their own hostnames and IP
  addresses was mechanically prevented, and for two releases it was not.
  The guard reads `git ls-files` rather than the working tree, so it checks
  exactly what a push would publish, and it skips itself, since the file
  defining the markers necessarily contains them. Verified by planting the
  placeholder marker in a tracked file and confirming the failure;
- corrected the `PI_AGENT_DIR` guidance in both scripts' help output and in
  `docs/DEPLOYMENT.md`. It is the harness's own variable and Pi does not read
  it; running Pi against an isolated profile also needs `PI_CODING_AGENT_DIR`
  set to the same path. Setting only `PI_AGENT_DIR` installs correctly into
  the isolated directory while Pi keeps loading its default profile — so a
  policy set installed for isolated testing silently never loads, and the
  test appears to pass against the wrong policies;
- added a "Rate limits and throughput" section to `AGENTS.md`. The repository
  already shipped the TPM governor, `/tpm`, and both configuration defaults,
  but the contract never said how an agent should behave under a contended
  budget: size a fanout against the provider's TPM rather than against the
  task, keep subagent briefs bounded because a roaming child re-sends
  everything it gathers, split roles across models since budgets are
  per-model, and narrow a trimmed query rather than re-running it. Provider
  caching does not relieve TPM — cached input still counts at full rate;
- added a reference-code convention to the contract's reporting rules: a
  report carrying three or more findings, decisions, options, risks,
  questions or actions labels each one (`F1`, `D1`, `O1`, `R1`, `Q1`, `A1`)
  so a later message can act on one by name instead of re-quoting it. The
  threshold is the whole design — coding a two-item answer is overhead
  without a payoff. Subagents label behind a prefix the *parent* assigns in
  the brief (`S1-F1`), because self-chosen prefixes collide the moment two
  agents run in parallel, and the parent preserves the prefix when merging
  rather than renumbering, keeping every claim traceable to the agent that
  produced it. Codes are conversation-scoped and barred from commit
  messages, changelog entries, documentation and code comments: a durable
  artifact that says "fixes `R2`" has lost the finding it was pointing at;
- sharpened the contract's verification rule to scale the check to what
  changed. Prose gets the targeted guard covering that prose and nothing
  more; the full suite is for structural change — executable code, installer
  or CI behaviour, manifests, or a refactor crossing module boundaries;
- documented `AGENTS.override.md` (Pi 0.84+) as the supported way to scope a
  deviation to one directory instead of forking the global contract;
- added an `installed-entry` CI job that runs the real
  `scripts/install.sh` into an isolated agent directory and then drives Pi
  headlessly through it. Every other test exercises the installer against
  fixtures; nothing proved that what the installer deploys actually loads and
  gates inside a Pi process. The job asserts the receipt (links resolve,
  permission-copy hashes match the repo), then loads
  `tests/fixtures/ci/probe-discovery.ts` to dump `systemPromptOptions` and
  assert that the permissions, harness extensions, required MCP tools, and
  skills were all discovered, and finally replays a fixed three-call
  transcript through `tests/fixtures/ci/fake-provider.ts`, an in-process
  provider registered via `pi.registerProvider()`: a destructive command is
  blocked, a secret-shaped read is gated, and a harmless command runs. No CI
  run reaches a real model provider. Linux-only, because the entry path is
  not OS-specific. Both `PI_AGENT_DIR` and `PI_CODING_AGENT_DIR` are exported
  to the same path — the first is the harness's own variable, the second is
  the one Pi reads, and setting only the first would install into the
  isolated directory while Pi kept loading its default profile, silently
  testing nothing. Known coupling: `registerProvider` is documented but
  pre-1.0, so a Pi version bump can turn this job red for integration drift
  rather than a harness bug;
- added `config/npm-allow-scripts.json` and the installer step that seeds it
  into `~/.pi/agent/npm/package.json` before `pi install` runs. npm 11.6+
  leaves a dependency's install script unrun until the project approves it by
  exact version, and the harness now decides that in a reviewed manifest
  rather than by whoever runs `npm approve-scripts` on a machine. The
  manifest is validated like the other pinned sources: an approval that is
  not `package@x.y.z`, or whose value is not `true`, fails the run before
  anything is written, so a later release of an approved dependency arrives
  unapproved and has to be reviewed. Existing dependencies and any approvals
  an operator added themselves survive the merge, and an empty manifest
  leaves the npm project alone entirely. It ships empty: approve a script
  only after reading what it builds and confirming your fork loads the
  result;
- added a redacted audit log under `$PI_AGENT_DIR/harness/audit/`, written
  from two correlated sources: the `extensions/audit-log.ts` observer records
  `session` and `outcome` rows, and each permission module calls
  `permissions/lib/audit.ts` to record a `request` row at the moment it
  returns a decision. Pi's session log records messages and tool executions,
  but not which policy fired, what rule matched, or how the request resolved,
  so an incident could not be replayed as policy. The log holds identifiers
  only — policy, tool, matched rule name, decision — never paths, command
  text, tool output, or prompts. Rule identifiers are sanitised through an
  *allowlist* of the bounded parenthesised constants the policies define;
  four earlier denylist attempts were each defeated by an ordinary filename,
  since a POSIX name may contain any byte but `/` and NUL, and `notes(1).pem`
  is the OS's own collision-rename shape. Three limits are documented rather
  than papered over: `request`→`outcome` correlation is adjacency within a
  process, not identity, because the permission input carries no tool-call
  id; headless runs record `no-ui` rather than human decisions, so CI
  transcripts do not read as walls of user rejections; and a policy added to
  a fork logs nothing unless it also calls the appender. Daily files, pruned
  after `PI_AUDIT_KEEP_DAYS` (default 30); `PI_AUDIT=0` disables both
  sources;
- extracted `build_policy_node_modules` from `run_policy_cases` in the test
  suite. The audit tests need the jiti-resolvable fixture without the
  synthetic-tool-input driver wrapped around it, and the two responsibilities
  were already distinct inside one function;
- added content-addressed spill for trimmed tool output, over a new shared
  append-only log helper `extensions/lib/harness-log.ts`.
  `extensions/context-budget.ts` kept the head and tail of an oversized tool
  result and destroyed the middle permanently, so a trim that ate the one
  stack frame that mattered was unrecoverable. The full text is now written
  to `$PI_AGENT_DIR/harness/spill/<sha256-prefix>.txt` (0600 in a 0700
  directory, written through a temporary file and renamed, so an interrupted
  write can never leave a partial file at a content-addressed path that a
  later call would trust unread) and the trim notice carries the path and
  hash, which the ordinary `read` tool retrieves — no new tool, no new
  permission. `trimToolContent` stays pure: the writer is an injected
  callback, so a spill failure degrades to exactly the previous notice and is
  never fatal. Identical output writes once. Pruned once per session by
  `PI_SPILL_KEEP_DAYS` (default 7) and then oldest-first to
  `PI_SPILL_MAX_BYTES` (default 64MB); `PI_SPILL_MAX_BYTES=0` disables
  spilling and restores the previous behaviour. Spilled bytes may themselves
  be secret-shaped, which the secret-read gate would have caught at the
  original path; accepted, because those same bytes already entered model
  context un-gated when the tool first ran, so the spill adds local
  persistence, not new exposure;
- set `allowImportingTsExtensions` in `tsconfig.json`, which the new
  `./lib/harness-log.ts` import requires: Pi's loader and the test suite both
  resolve local imports by their literal `.ts` extension, and there is no
  build step to rewrite them.

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
