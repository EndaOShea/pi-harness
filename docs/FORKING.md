# Forking This Harness

This repository is a template: the machinery is generic, and the payload is
an example. Fork it, replace the payload with your own choices, and keep the
machinery.

## What is machinery and what is payload

Machinery — keep it, and pull upstream fixes when useful:

- `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/validate.sh` — the
  validated, ownership-checked install/uninstall flow;
- `scripts/check-impeccable.py` — the staged third-party update checker;
- `permissions/` — deletion-approval and protected-path hooks enforcing
  the contract (edit `PROTECTED_DIRECTORIES` in `protected-paths.ts` to
  match your own protected locations);
- `extensions/local-models.ts` — local model server discovery (edit the
  reasoning-id pattern if your local model names differ);
- `tests/` — isolated installer, uninstaller, and repository checks;
- `.github/workflows/validate.yml` — continuous validation.

Payload — this is what you are expected to change:

| File | What it declares |
| --- | --- |
| `AGENTS.md` | The operating contract your agent follows |
| `packages/pi-packages.txt` | Which Pi packages install, at exact pins |
| `config/resources.json` | Which skill directories Pi loads globally |
| `config/required-mcp.json` | MCP servers every installation must have |
| `config/third-party-skills.json` | Provenance for vendored third-party skills |
| `skills/` | Your curated skills |
| `.pi/skills/impeccable/` | Example of a vendored third-party skill |
| `mcp/` | Optional MCP examples and guidance |

## Checklist

1. **Identity.** Update the copyright holder in `LICENSE` (keep the upstream
   notice if you retain upstream code), the project naming in `README.md`,
   and the clone URL in `docs/DEPLOYMENT.md`.
2. **Contract.** Read `AGENTS.md` end to end and make it yours. At minimum,
   replace the protected-paths list with your own irreplaceable locations.
   Validation asserts the contract's core safety sections still exist.
3. **Packages.** Edit `packages/pi-packages.txt`. Every entry must be an
   exact npm version or an immutable git commit — validation rejects mutable
   git tags.
4. **Skills.** Add or remove skill directories, then update
   `config/resources.json`. For third-party skills, follow the provenance
   process in `README.md`: review everything, pin an immutable source,
   record the content hash in `config/third-party-skills.json`.
5. **MCP servers.** Keep, replace, or extend `config/required-mcp.json` and
   the examples under `mcp/`. Read-only, lazy, secrets outside Git.
6. **Private references guard.** `tests/test_harness.py` rejects a list of
   known private infrastructure markers. Extend
   `PRIVATE_REFERENCE_MARKERS` with your own hostnames, IP addresses, and
   internal names so they can never be committed to a public fork.
7. **Validate and preview.**

   ```bash
   ./scripts/validate.sh
   ./scripts/install.sh --dry-run
   ```

8. **Version.** Set `VERSION`, and add a `CHANGELOG.md` entry; validation
   requires the version string in `README.md`, `docs/DEPLOYMENT.md`, and
   `CHANGELOG.md`.

## Keeping private things private

Skills that describe your real infrastructure — hostnames, IP addresses,
network topology, deploy targets, internal service names — do not belong in
a public repository, and removing a file later does not remove it from git
history. Keep such skills in a private fork or a separate private overlay,
and let the public fork carry only what you would show a stranger. If a
private detail ever lands in a public branch, treat the history as
compromised: rotate what it exposed and rebuild the public repository from a
clean tree.

## Staying close to upstream

Machinery fixes land in the template. If you keep your fork's history
connected (a real GitHub fork or a git remote), you can review and merge
upstream changes to `scripts/`, `permissions/`, `tests/`, and the workflow
while keeping your payload untouched, since payload and machinery live in
separate files by design.
