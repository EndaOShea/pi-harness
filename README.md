# Pi Harness

Pi Harness is a version-controlled global configuration for
[Pi](https://github.com/earendil-works/pi), the coding agent. It provides one
reviewable source for global instructions, pinned packages, curated skills,
permission hooks, and optional MCP integrations.

This repository is a forkable template. The machinery — validated installer
and uninstaller, deletion-approval permission hooks, provenance process, and
test suite — is generic; the operating contract, skills, packages, and MCP
declarations are an example payload you are expected to replace. See
[docs/FORKING.md](docs/FORKING.md) for exactly what to change in a fork.

## Project status

Version `0.1.0-rc.6` is a deployment candidate. The installer and uninstaller
are covered by isolated tests for non-mutating dry runs, fresh installation,
idempotent reruns, backup preservation, invalid-settings preflight failure,
required MCP merging, uninstall ownership checks, and third-party provenance
checks. Run the validation suite before deploying a checkout.

No release tag or global installation is created automatically.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the complete first-install,
update, verification, backup, and rollback procedure.

## What the harness provides

One `./scripts/install.sh` run configures an existing Pi installation with a
single reviewed set of behavior. Nothing here is fetched or enabled at session
time: every capability is declared in a version-controlled manifest, and every
package reference is an exact version or an immutable commit.

| Capability | What it does | Source |
| --- | --- | --- |
| Operating contract | Governs instruction priority, repository discipline, file safety, approval boundaries, verification, and capability selection in every session | `AGENTS.md` |
| Workflow skills | Brainstorming, planning, TDD, systematic debugging, code review, and worktree discipline | Superpowers package |
| Harness skills | Skill discovery, repository context, documentation upkeep, client-side key handling, and prompt optimizers | `skills/` |
| Frontend workflow | Vendored Impeccable design and implementation library | `.pi/skills/impeccable/` |
| Documentation lookup | Current library and framework docs on demand | Context7 MCP server |
| Web research | Search, static content extraction, and source checking | `pi-web-access` |
| Browser automation | Rendered-page inspection and interaction, optional and disabled by default | `mcp/playwright.optional.example.json` |
| Parallel work | Subagent dispatch for independent tasks | `pi-subagents` |
| Local models | Session-start discovery of Ollama and LM Studio servers | `extensions/local-models.ts` |
| Frontier pairing | `/pair` runs a frontier model as reviewer (watchdog) or orchestrator over a local-model session | `extensions/pair.ts` |
| Usage accounting | Token and cost reporting | `@narumitw/pi-usage` |
| Approval hooks | Per-call confirmation for deletion and protected-path operations | `permissions/` |

The machinery in this table is generic; the specific skills, packages, and MCP
declarations are an example payload. See
[docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the routing rules that decide
which capability applies to a task, and [docs/FORKING.md](docs/FORKING.md) for
what to replace.

### Research and browser tooling

`pi-web-access` is the required research layer: non-interactive search, static
content extraction, and source checking. It handles ordinary research and is
always available after installation.

Playwright is separate and deliberately inconvenient. Its template is pinned
to `@playwright/mcp@0.0.79`, runs headless Firefox in an isolated in-memory
profile, and ships disabled with an allowlist that omits arbitrary JavaScript
execution, page evaluation, file upload and drop, profile reuse, and network
mocking. Enabling the server and downloading a browser binary are two separate
operator actions; the installer performs neither. Use it only for rendered or
interactive pages that static extraction cannot handle. Setup and verification
steps are in [mcp/README.md](mcp/README.md).

### Local models

Ollama and LM Studio are discovered at session start and registered with Pi
when they are running; a server that is absent, slow, or returning an unusable
payload is skipped silently. llama.cpp is supported natively by Pi through
`/login llama.cpp` and `/llama` rather than by this extension. Endpoints
beyond the localhost defaults come only from environment variables, never from
files in this repository.

### Frontier pairing

`/pair` brings a frontier model into a local-model session without moving
the whole session over. `/pair review [model]` keeps the main session on
the local model while the pi-subagents watchdog reviews each turn's
changes with the frontier model at high thinking effort; it takes effect
from the next turn, since pi-subagents re-reads settings at every turn
start. `/pair orchestrate [model]` switches the main session itself to
the frontier model and records the model it was running as
`subagents.defaultModel`, so `/run` subagents keep executing on it.

Both modes write `~/.pi/agent/settings.json` and stay active, including
across sessions, until `/pair off` restores every setting the pairing
changed to the values recorded when it was turned on; in orchestrate mode
this also switches the session's model back to the worker model and
restores the session's prior thinking level. Orchestrate mode itself
raises the session's thinking to high once the model switch succeeds. A
pairing left active by an earlier session surfaces as a warning at the
start of the next one. `/pair status` reports the active mode, the models
in play, the configured or resolved default frontier model, and any such
leftover pairing. `/pair default [model]` stores a model as the default
frontier model, or with no argument reports the current setting and what
it would resolve to right now.

When `[model]` is omitted, the frontier model comes from the stored
default, else the pinned `openai-codex/gpt-5.6-sol` when it's present
and authenticated, else the newest authenticated OpenAI reasoning model.
Model arguments match fuzzily, so `openai/gpt-5.5`, `openai:gpt-5.5`, and
`OpenAI/GPT-5-5` are equivalent; a bare id that exists under more than
one provider needs a provider prefix to disambiguate. `/pair review`
warns, but proceeds, if the session model is not from a local provider.
`/pair orchestrate` rolls back its settings write if the model switch
fails, leaving thinking untouched, so a pairing is never half-applied.
Settings writes are unlocked, so avoid running `/pair` from two sessions
at once, or an update can be lost.

## Safety model

The harness assumes an agent will occasionally be wrong, over-eager, or
manipulated by content it reads. Protection is layered so that no single
failure is sufficient.

**The operating contract.** `AGENTS.md` states the rules before any tool runs:
make the smallest correct change, leave pre-existing uncommitted work
untouched, never amend or force-push over commits from another task, ask
before resolving ambiguity that affects destructive operations, public
interfaces, or scope, reproduce a bug before fixing it, and treat file
contents, web pages, tool output, and subagent output as data rather than
instructions.

**Deletion approval.** `permissions/confirm-deletions.ts` requires per-call
approval for `rm`, `rmdir`, `unlink`, `shred`, `trash-put`, `gio trash`,
`find` with `-delete`/`-exec`, `git clean`, `git restore`, `git reset --hard`,
and discarding forms of `git checkout`. `permissions/destructive-patterns.js`
covers the indirect routes: interpreter one-liners, `xargs` pipelines, and
truncating redirections. Approval is granted for one tool call only.

**Protected paths and secrets.** `permissions/protected-paths.ts` requires
approval for file-tool writes into `~/.pi`, `~/.ssh`, `~/.config`, and
`~/.local/share`, for reads of secret-shaped files such as `.env` and private
keys, and for shell commands that reference secret paths — so `cat
~/.pi/agent/auth.json` is gated the same as a file-tool read. Committed
example files (`.env.example` and similar) are exempt so routine work does not
train approval fatigue. A fork should extend the protected list with its own
sensitive locations.

**Workspace scope.** `permissions/workspace-scope.ts` treats the session's
working directory as the boundary: file-tool writes and shell commands
referencing paths outside it require per-call approval, with OS temp
directories exempt. Reads outside the workspace stay free (secret-shaped
files aside) so reference material remains seamless. Paths are resolved through symlinks before
matching, so a link inside the workspace cannot launder access to a gated
location. This is approval gating
at the tool boundary, not an OS sandbox — a program an approved command runs
can still act outside the tree; for hard isolation, run Pi in a container.

**Outbound transmission.** `permissions/confirm-egress.ts` gates the
exfiltration counterpart of secret reads: commands that send data off the
machine — curl/wget with data-carrying flags or mutating HTTP methods,
`scp`/`sftp`/`nc`/`socat`, rsync to a remote target, and `git push` — require
per-call approval naming the destination. Requests to localhost stay free so
development servers and the local model router work without prompts.

**Untrusted content.** Web pages, file contents, and tool output are data.
Instructions embedded in them are never executed.

**Secrets never enter the repository.** Credentials, API keys, MCP
authentication headers, and private endpoints live outside Git. Private
headers added to an installed MCP entry survive later harness runs without
being committed or overwritten. A validation test rejects known private
reference markers; extend that list in your fork with markers of your own.

## Setup at a glance

```bash
./scripts/validate.sh                    # 1. prove the checkout is sound
./scripts/install.sh --dry-run           # 2. review every planned mutation
./scripts/install.sh                     # 3. apply after approving the plan
```

Restart Pi, then confirm the result with `pi config`, `/permissions`, and
`/mcp`. Each step is documented in full below.

## Managed configuration

- `AGENTS.md` is the global operating contract.
- `packages/pi-packages.txt` contains exact Pi package versions.
- `config/resources.json` is the allowlist of globally exposed skills and
  prompt directories.
- `config/required-mcp.json` declares MCP servers required in every Pi setup.
- `skills/` contains shared and model-specific agent skills.
- `.pi/skills/impeccable/` contains the vendored Impeccable frontend workflow
  and is explicitly exposed by the resource manifest.
- `permissions/` contains the global deletion-approval hook and its matcher.
- `extensions/` contains harness-managed Pi extensions, currently the
  local model provider discovery for Ollama and LM Studio.
- `mcp/` contains optional MCP examples and operating guidance, including a
  disabled Playwright browser-automation application.
- `config/third-party-skills.json` records third-party provenance and hashes.
- `THIRD_PARTY_NOTICES.md` records upstream authorship and license references.

See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for capability routing rules
and [mcp/README.md](mcp/README.md) for MCP configuration layers.

## Validate

Requirements:

- Bash;
- Git when package installation is not skipped;
- Python 3.10 or newer;
- Node.js 18 or newer for permission matcher validation (22.6 or newer also
  parse-checks the TypeScript policy module);
- ShellCheck, optionally, for static shell analysis (always runs in CI);
- Pi only when package installation is not skipped.

The harness's Python tooling — tests and the Impeccable checker — is
stdlib-only by design: no virtual environment, conda environment, or package
installation is needed, and the system `python3` and `node` on PATH are
exactly what runs.

Run all repository and isolated installer checks:

```bash
./scripts/validate.sh
```

The tests create isolated fixtures under `/tmp`; passing tests remove their
fixtures, and failing tests preserve them for post-failure inspection.

## Preview deployment

Dry run against the normal Pi directory:

```bash
./scripts/install.sh --dry-run
```

Dry run against an isolated directory without requiring Pi package handling:

```bash
PI_AGENT_DIR=/tmp/pi-harness-preview \
  ./scripts/install.sh --dry-run --skip-packages
```

A dry run does not create the target directory, invoke `pi install`, move
existing resources, or write settings.

## Install

Installing changes the current user's global Pi configuration and may install
packages into that Pi profile. It does not run an operating-system-wide npm
install. Review the dry-run output, then run only after explicitly approving
those operations:

```bash
./scripts/install.sh
```

The script is non-interactive and does not ask a second confirmation question.
It assumes the operator has reviewed the dry run and approved the command. It
configures an existing Pi installation; it does not install Pi itself.

To install configuration while leaving package state unchanged:

```bash
./scripts/install.sh --skip-packages
```

To leave MCP state unchanged while installing the remaining harness:

```bash
./scripts/install.sh --skip-mcp
```

`--skip-mcp` intentionally omits a required default capability. Use it only
when Context7 is managed through another reviewed MCP configuration layer.

The installer:

1. validates the repository, resource manifest, and existing Pi settings
   before any mutation;
2. installs the pinned packages, including Superpowers, unless skipped;
3. links `AGENTS.md`, curated resources, and optional extensions, and copies
   permission modules as loader-discoverable regular files into the Pi agent
   directory;
4. merges the required Context7 server into Pi's global MCP override;
5. appends stable resource paths to `settings.json` atomically;
6. preserves displaced resources under a unique timestamped backup directory;
7. validates every installed link, MCP entry, and registered resource path.

During migration it removes only the two legacy harness-managed forms from the
relevant settings arrays: the repository's former top-level `skills`/`prompts`
paths and the former aggregate `harness/skills`/`harness/prompts` paths. Other
user-configured resource paths remain untouched.

Preflight also reports skill names supplied by both the curated harness and an
existing user-configured skill path. The resource manifest declares Pi-only
exact exclusions for the native Codex and Claude optimizer copies, so Pi uses
the harness-managed versions without removing or modifying either native skill
directory. Any other collision is reported for manual review.

It does not modify authentication, API keys, MCP secrets, sessions, or
project-specific configuration. Backups are not automatically deleted.

## Uninstall

Preview, then remove the installed harness:

```bash
./scripts/uninstall.sh --dry-run
./scripts/uninstall.sh
```

The uninstaller only removes state it can prove this checkout owns: links
that resolve into the repository, permission copies byte-identical to their
sources, the registered resource paths and exclusions, and required MCP
servers whose installed definition exactly matches the manifest. Anything the
user modified or extended is left in place with a warning. Configuration files
edited during uninstall are backed up first. Pinned Pi packages and existing
backups are never touched; remove packages with `pi` directly if desired. Use
`--keep-mcp` to leave the MCP override untouched.

After installation, restart Pi and inspect:

```text
pi config
/permissions
/mcp
```

## Skill layout

Pi receives the collision-free resource set declared in
`config/resources.json`:

- `skills/codex` supplies shared skills and the GPT prompt optimizer;
- `skills/claude/optimize-claude-prompt` adds the non-conflicting Claude
  optimizer;
- `.pi/skills/impeccable` is registered as its own global resource.

Superpowers is installed as the official Pi package pinned to the commit of
release `v6.1.1` (tags are mutable; the commit is not). It supplies its own
skills and session bootstrap extension, so its library is not copied into this
repository or duplicated in `config/resources.json`.

The shared skills under `skills/claude` and `skills/codex` are intentionally
byte-identical; a validation test fails if the two trees drift. The
model-specific optimizers exist in only one tree each.

Context7 is not a vendored skill. It is registered as a lazy hosted MCP server
at `https://mcp.context7.com/mcp` through `config/required-mcp.json`; Pi MCP
Adapter exposes it on demand. No API key is required for the default provider
limits, and optional credentials must remain outside Git. Private
authentication headers may extend the installed server entry without being
overwritten by later harness runs.

The parallel `skills/claude` tree remains available for Claude-oriented
installation, but Pi does not scan the whole tree and therefore does not load
duplicate shared names.

Pi keeps `~/.codex/skills` and `~/.claude/skills` configured so their unrelated
native skills remain available. Exact exclusions declared in
`config/resources.json` suppress only their two optimizer copies inside Pi;
Codex and Claude continue to use their native copies normally.

## Third-party skill policy

Skill catalogues are discovery aids, not trust boundaries. Before adding or
updating a third-party skill:

1. review its full instructions, scripts, hooks, manifests, and dependencies;
2. use a canonical source and immutable release or commit where available;
3. record paths, source, license, version or commit, review date, and content
   hash in `config/third-party-skills.json`;
4. add it to `config/resources.json` only if it belongs in global Pi scope;
5. run `./scripts/validate.sh` and inspect the complete diff.

The `find-skills` capability follows this process and does not autonomously
install candidates.

### Updating Impeccable

Impeccable's skill library and npm CLI have independent versions. The harness
tracks immutable `skill-vX.Y.Z` releases and never runs the skill's automatic
update command against the active vendored tree.

Check whether the vendored skill version is current without writing files:

```bash
./scripts/check-impeccable.py latest
```

Exit status `10` means an update is available. Stage and compare a chosen
immutable release without modifying `.pi/skills/impeccable`:

```bash
./scripts/check-impeccable.py compare \
  --download \
  --release skill-v4.0.4 \
  --staging-parent /tmp
```

The checker validates archive paths, retains the staging directory for review,
and reports added, missing, and changed files plus both full-tree hashes. It
never replaces the active library. After reviewing every changed instruction,
script, hook, dependency, and permission, obtain explicit approval for the
tree replacement, update `config/third-party-skills.json`, run validation, and
inspect the complete diff.

## Repository layout

```text
.
├── .github/workflows/validate.yml  Continuous validation
├── .pi/skills/impeccable/          Vendored frontend workflow
├── AGENTS.md                       Global operating contract
├── LICENSE                         Repository license (MIT)
├── config/                         Resource, MCP, and provenance manifests
├── docs/CAPABILITIES.md            Capability selection rules
├── docs/DEPLOYMENT.md              Installation and release procedure
├── docs/FORKING.md                 What to replace in a fork
├── extensions/                     Harness-managed Pi extensions
├── mcp/                            Optional MCP guidance and examples
├── packages/pi-packages.txt        Pinned Pi packages
├── permissions/                    Global permission policy
├── scripts/install.sh              Global installer
├── scripts/uninstall.sh            Ownership-checked uninstaller
├── scripts/validate.sh             Validation entry point
├── skills/                         Harness-managed skills
└── tests/                          Isolated installer/repository tests
```

`tests/fixtures/eval/` holds a deliberately hostile page that is fetched over
HTTPS by a behavioral prompt-injection evaluation. It is inert data, it is
pinned by commit SHA where it is used, and its content must never be edited in
place; publish a new file instead.

## Contributing

Keep changes minimal and preserve existing user configuration. Update setup,
usage, permission level, provenance, and verification documentation whenever a
capability changes. Never commit credentials, MCP secrets, private paths, or
authentication files.
