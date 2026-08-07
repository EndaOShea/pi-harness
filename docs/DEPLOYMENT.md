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
| Required MCP servers | `config/required-mcp.json` | `~/.pi/agent/mcp.json` |

Set `PI_AGENT_DIR` to use a different Pi agent directory. Every destination in
this guide then moves below that directory.

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

## Installer modes

| Command | Package changes | File changes | Context7 merge |
| --- | ---: | ---: | ---: |
| `./scripts/install.sh --dry-run` | No | No | No; preview only |
| `./scripts/install.sh` | Yes | Yes | Yes |
| `./scripts/install.sh --skip-packages` | No | Yes | Yes |
| `./scripts/install.sh --skip-mcp` | Yes | Yes | No |
| `./scripts/install.sh --skip-packages --skip-mcp` | No | Yes | No |

Use `PI_AGENT_DIR=/absolute/path` with any mode to target an isolated or
non-default Pi profile. A dry run never creates that directory.

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
6. validates the installed links, JSON, resource registrations, and required
   MCP entries.

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

Version `0.1.0-rc.4` is a deployment candidate. The repository validation,
isolated installer and uninstaller tests, and CI workflow are in place. A
public release still requires an explicit maintainer decision to create a tag
and publish release notes. A real current-user installation and any production
deployment remain separate, approval-gated operations.
