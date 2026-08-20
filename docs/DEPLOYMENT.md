# Deploying the Pi Harness

This guide covers a current-user installation of the harness after Pi is
already installed. The harness does not install Pi itself, publish an npm
package, create a release tag, or deploy to a remote service.

## Deployment model

“Global” means global to the current Pi user profile, normally
`~/.pi/agent`. It does not mean an operating-system-wide npm installation.

The repository remains the source of truth after installation. The operating
contract and curated resources are linked from the Pi agent directory back to
the checkout, so keep the checkout at a stable path. Permission modules are
copied as regular files because the permission loader discovers regular
directory entries rather than symlinks. Package references, resource paths,
required MCP servers, and third-party provenance are defined by
version-controlled manifests.

| Concern | Source | Installed destination |
| --- | --- | --- |
| Operating contract | `AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| Pi packages | `packages/pi-packages.txt` | Installed by `pi install` for the current Pi profile |
| Curated resources | `config/resources.json` | `~/.pi/agent/harness/{skills,prompts}/` and `settings.json` |
| Permission hooks | `permissions/` | Regular-file copies in `~/.pi/agent/permissions/` |
| Pi extensions | `extensions/` | Symlinks in `~/.pi/agent/extensions/` |
| Required MCP servers | `config/required-mcp.json` | `~/.pi/agent/mcp.json` |
| Approved npm install scripts | `config/npm-allow-scripts.json` | `allowScripts` in `~/.pi/agent/npm/package.json` |
| Optional Playwright app | `mcp/playwright.optional.example.json` | Manually merged into an MCP configuration only when requested |

Set `PI_AGENT_DIR` to change where the harness installs. Every destination in
this guide then moves below that directory. `PI_AGENT_DIR` is the harness's
own variable, not one Pi itself reads: actually running Pi against the
installed profile additionally requires `PI_CODING_AGENT_DIR` set to the same
path. See [Installer modes](#installer-modes) below.

## Prerequisites

- Pi installed and available as `pi` on `PATH`;
- Bash;
- Python 3.10 or newer;
- Node.js 18 or newer for repository validation;
- Git and network access when installing the pinned packages.

Confirm the local tools before setup:

```bash
pi --version
python3 --version
node --version
git --version
```

## First installation

Clone your fork of the repository into a stable, current-user-owned location
and enter it (replace the URL with your fork):

```bash
git clone git@github.com:<your-user>/<your-harness>.git pi-harness
cd pi-harness
```

Validate the checkout:

```bash
./scripts/validate.sh
```

Preview the exact target paths and operations:

```bash
./scripts/install.sh --dry-run
```

Then run the installer only after approving the current-user Pi package and
configuration changes:

```bash
./scripts/install.sh
```

The installer is intentionally non-interactive. It does not display a second
confirmation prompt. When an agent is running the command, `AGENTS.md`
requires the agent to obtain approval first; when an operator runs it directly,
the reviewed command invocation is the approval boundary.

Restart Pi after installation so packages, skills, instructions, permissions,
and MCP configuration are loaded in a fresh session.

The normal installer does not configure Playwright or download a browser.
Follow the optional application procedure in `mcp/README.md` only when a task
requires rendered-page interaction or browser-based UI verification.

## Installer modes

| Command | Package changes | File changes | Context7 merge |
| --- | ---: | ---: | ---: |
| `./scripts/install.sh --dry-run` | No | No | No; preview only |
| `./scripts/install.sh` | Yes | Yes | Yes |
| `./scripts/install.sh --skip-packages` | No | Yes | Yes |
| `./scripts/install.sh --skip-mcp` | Yes | Yes | No |
| `./scripts/install.sh --skip-packages --skip-mcp` | No | Yes | No |

Use `PI_AGENT_DIR=/absolute/path` with any mode to make the installer target
an isolated or non-default directory. A dry run never creates that
directory. `PI_AGENT_DIR` only controls where the harness installs: Pi
itself reads a different variable, `PI_CODING_AGENT_DIR`, to choose its own
config directory. To actually run Pi against the profile you just installed
into, export both variables set to the same path:

```bash
export PI_AGENT_DIR=/absolute/path
export PI_CODING_AGENT_DIR=/absolute/path
./scripts/install.sh
pi   # now reads the profile just installed, not the default one
```

Setting only `PI_AGENT_DIR` installs correctly into the isolated directory,
but Pi keeps reading its default profile (normally `~/.pi/agent`) until
`PI_CODING_AGENT_DIR` is also set — so a policy set installed for isolated
testing silently never loads, and Pi runs against your existing default
profile and its existing policies instead.

`--skip-mcp` is an escape hatch for a profile that deliberately manages all
MCP configuration elsewhere. Such a profile does not satisfy the harness's
default required-capability set until Context7 is configured by another
reviewed mechanism.

## What installation changes

Before mutation, the installer validates its manifests and any existing
`settings.json` and Pi MCP override. It then:

1. calls `pi install` once for each exact package reference unless package
   installation is skipped;
2. links the global operating contract, curated resource directories, and any
   harness extensions, and copies permission modules as regular files;
3. registers each curated resource path in `settings.json`;
4. adds Pi-only exact exclusions for duplicate native optimizer copies without
   removing their parent Codex or Claude skill paths;
5. merges the required lazy Context7 server into `mcp.json` unless skipped;
6. applies the declared retry policy from `config/settings-defaults.json` to
   `settings.json`, and the declared per-model input limits from
   `config/models-defaults.json` to `models.json`. A missing key is merged
   verbatim; an existing key with a different value fails preflight before
   any mutation rather than overwriting your configuration;
7. validates the installed links, JSON, resource registrations, and required
   MCP entries;
8. writes `$PI_AGENT_DIR/harness/.managed-state.json` atomically with mode
   `0600` after successful validation.

### Runtime state the harness writes

Beyond the installed files, extensions write local state below
`$PI_AGENT_DIR/harness/`. None of it is created at install time; each
directory appears on first use and is safe to delete.

`harness/spill/` holds the full pre-trim output of results the context budget
shortened. Trimming keeps a result's head and tail, so the middle would
otherwise be lost; instead it is written to a content-addressed, owner-only
file (`0600` in a `0700` directory) and the trim notice names the path, byte
count, and SHA-256, which an ordinary bounded `read` recovers. Identical
output is stored once. Storage is pruned once per session to
`PI_SPILL_KEEP_DAYS` (default 7) days and then oldest-first down to
`PI_SPILL_MAX_BYTES` (default 64MB); `PI_SPILL_MAX_BYTES=0` disables spilling
and restores discard-only trimming. Spilled bytes can be as sensitive as
whatever the tool call was approved to read, which is why the files are
owner-only — but they entered model context already when the tool ran, so the
spill adds local persistence rather than new exposure.

`harness/audit/` holds a redacted, append-only record of what the permission
layer did: one `session` record per session (provider, model, UI presence,
and the installed receipt's version and permission hashes), one `request`
record per gate raised (policy, tool, matched rule name, decision), and one
`outcome` record per tool execution (`ran` or `blocked`, with the block
reason classed as `policy-block`, `user-rejected`, `no-ui`, or `other`). It
holds identifiers, never content: no paths from user commands, no command
text, no tool output, no prompts. Three properties are worth understanding
before relying on it. Correlation between a `request` and its `outcome` is
by process and adjacency, not tool-call identity, because the permission
input carries no call id. Approval visibility exists only for policies that
write `request` records, so a policy you add to a fork contributes nothing
until it calls the appender. And when a session runs without a UI,
`pi-permissions` converts every approval request into a block, so `no-ui`
outcomes record the absence of a human decision rather than a refusal —
headless transcripts must not be read as walls of user rejections. Files
rotate daily and are pruned after `PI_AUDIT_KEEP_DAYS` (default 30) days;
`PI_AUDIT=0` disables writing from both sources.

`/approvals` reads that log back as approval-gate load: gates raised this
session and today, a breakdown by policy and matched rule, how they
resolved, and the approval rate. Above twenty gates at a ninety per cent
or higher approval rate it warns, and names the policy raising most of
them. The rate is the number worth watching — a gate approved essentially
every time has stopped carrying information regardless of how often it
fires, and that is this layer's real failure mode, since it is approval
assistance rather than isolation. Two limits are stated in the output
because they bound what the numbers mean: it counts gates *raised* rather
than prompts a human saw, as policies are evaluated independently and one
tool call can raise several; and the approved figure is derived by
subtracting rejections, policy blocks and headless auto-blocks from gates
raised, never by pairing a `request` record to an `outcome` record, since
that correlation is by adjacency. `PI_AUDIT=0` silences the report along
with the writing.

### The managed-state receipt

The schema-versioned receipt is what makes updates and uninstalls safe. It
records the harness root and version, the Pi agent directory, owned link
sources and targets, permission-copy SHA-256 hashes, managed setting values,
public required MCP definitions, and package pins. It never records secrets,
private MCP headers or environment values, or unrelated user-owned settings.

On update, a managed value that still matches the receipt is recognized as
harness-owned and may be replaced, so a retuned default reaches existing
installations; anything else was tuned by the operator and is preserved.
Owned stale files and edited configuration move to the timestamped backup,
while modified or foreign state stays in place with a warning. A removed
package pin is reported but requires manual `pi` package management.

Unrelated settings and MCP servers are preserved. Existing private fields on
the compatible Context7 definition, such as authentication headers, are also
preserved. An incompatible server already named `context7` causes preflight to
fail before mutation.

When a managed destination or configuration file must change, the installer
copies the displaced state to a unique directory below:

```text
~/.pi/agent/backups/harness-<timestamp>-<process-id>/
```

Backups are never pruned automatically.

## Verify the installed harness

Start a new Pi session and inspect:

```text
pi config
/permissions
/mcp
```

Expected results:

- the global `AGENTS.md` resolves to this checkout;
- the curated resource paths are present in Pi settings;
- Superpowers skills are supplied by the pinned Pi package;
- Impeccable and the harness-owned skills are available without duplicate
  names;
- `context7` appears as a lazy MCP server.

For filesystem-level verification, rerun the installer. A healthy unchanged
installation is idempotent and reports that managed state is already current.

## Update an installation

Review the repository changes and release notes before updating:

```bash
git fetch --tags
git diff HEAD..origin/main -- AGENTS.md README.md docs config packages permissions scripts skills mcp
```

Choose the exact revision through the normal Git workflow, then run:

```bash
./scripts/validate.sh
./scripts/install.sh --dry-run
./scripts/install.sh
```

The final command can change current-user Pi packages and global harness
configuration, so it has the same approval requirement as first installation.
Do not let a third-party skill update the active checkout directly. Impeccable
updates must use the staged comparison process documented in the root
`README.md`.

## Uninstalling

Preview and run the uninstaller from the installed checkout:

```bash
./scripts/uninstall.sh --dry-run
./scripts/uninstall.sh
```

It removes only state it can prove the checkout owns — links resolving into
the repository, byte-identical permission copies, registered resource paths
and exclusions, and required MCP servers whose installed definition exactly
matches `config/required-mcp.json`. User-modified or extended state is left
in place with a warning, edited configuration files are backed up first, and
pinned Pi packages and existing backups are never touched.

## Moving or rolling back

Moving the checkout makes installed symlink targets stale. Run the installer
from the new stable path after reviewing its dry run; the installer preserves
the displaced managed targets in a backup.

Rollback is a manual, reviewable operation because it replaces current global
configuration and may change packages. Select the intended harness revision,
validate it, preview the installer, and rerun it with explicit approval. If a
backup must be restored instead, inspect the exact backup and destination
paths first and obtain approval for the replacement operation. The harness
never deletes newer state or old backups automatically.

## Release readiness

Version `0.1.0-rc.8` is a deployment candidate. The repository validation,
isolated installer and uninstaller tests, and CI workflow are in place. A
public release still requires an explicit maintainer decision to create a tag
and publish release notes. A real current-user installation and any production
deployment remain separate, approval-gated operations.
