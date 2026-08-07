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

Version `0.1.0-rc.5` is a deployment candidate. The installer and uninstaller
are covered by isolated tests for non-mutating dry runs, fresh installation,
idempotent reruns, backup preservation, invalid-settings preflight failure,
required MCP merging, uninstall ownership checks, and third-party provenance
checks. Run the validation suite before deploying a checkout.

No release tag or global installation is created automatically.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the complete first-install,
update, verification, backup, and rollback procedure.

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
- `mcp/` contains optional MCP examples and operating guidance.
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

## Contributing

Keep changes minimal and preserve existing user configuration. Update setup,
usage, permission level, provenance, and verification documentation whenever a
capability changes. Never commit credentials, MCP secrets, private paths, or
authentication files.
