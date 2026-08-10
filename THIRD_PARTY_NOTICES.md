# Third-party notices

## Superpowers

- Project: Superpowers
- Upstream: https://github.com/obra/superpowers
- Installed source:
  `git:github.com/obra/superpowers@d884ae04edebef577e82ff7c4e143debd0bbec99`
- Release: `v6.1.1` (the tag's commit is pinned because git tags are mutable)
- License: MIT

Superpowers is installed by Pi from its immutable upstream commit and is not
vendored in this repository.

Upstream license text:
https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/LICENSE

## Context7

- Project: Context7
- Upstream: https://github.com/upstash/context7
- Service endpoint: `https://mcp.context7.com/mcp`
- License: MIT

The harness stores only the public MCP endpoint. Authentication material is
optional and must remain outside this repository. The upstream source license
does not replace any separate terms that may apply to the hosted service.

Upstream license text:
https://github.com/upstash/context7/blob/master/LICENSE

## Impeccable

- Project: Impeccable
- Upstream: https://github.com/pbakaus/impeccable
- Author: Paul Bakaus and contributors
- License: Apache License 2.0
- Vendored path: `.pi/skills/impeccable`

The local tree declares skill version `4.0.4`. Upstream release tag
`skill-v4.0.4` and commit
`9a949fb543d44cfb406f61bcab99d95d7f12cf1d` are recorded in
`config/third-party-skills.json`; the local tree remains pinned by its content
hash. The staged checker has verified the vendored tree byte-identical to the
upstream release archive.

Upstream release:
https://github.com/pbakaus/impeccable/releases/tag/skill-v4.0.4

Apache License 2.0 text:
https://www.apache.org/licenses/LICENSE-2.0.txt

## Vercel Skills find-skills workflow

- Project: Vercel Skills
- Upstream: https://github.com/vercel-labs/skills
- License: MIT
- Adapted paths: `skills/codex/find-skills` and
  `skills/claude/find-skills`

The local workflow is an independently reviewed adaptation. It replaces
automatic/global installation guidance with read-only discovery, provenance
review, explicit approval, and repository staging requirements. Its optional
fallback command pins `skills@1.5.20`; the CLI is not installed as a harness
package.

Upstream license text:
https://github.com/vercel-labs/skills/blob/main/LICENSE

## Other pinned Pi packages

The following packages are installed from exact npm versions declared in
`packages/pi-packages.txt`:

| Package | Version | Upstream |
| --- | --- | --- |
| `@narumitw/pi-usage` | `0.40.1` | https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-usage |
| `pi-mcp-adapter` | `2.16.0` | https://github.com/nicobailon/pi-mcp-adapter |
| `pi-web-access` | `0.19.0` | https://github.com/nicobailon/pi-web-access |
| `pi-subagents` | `0.38.0` | https://github.com/nicobailon/pi-subagents |
| `@thurstonsand/pi-permissions` | `0.9.0` | https://www.npmjs.com/package/@thurstonsand/pi-permissions |

These packages are not vendored in the harness. Their package archives and
license texts are supplied by their respective publishers when Pi installs
the exact manifest references.

## Optional Playwright MCP application

The disabled template at `mcp/playwright.optional.example.json` references
`@playwright/mcp@0.0.79` from Microsoft under the Apache-2.0 license:
https://github.com/microsoft/playwright-mcp

It is not installed by the harness package manifest. Enabling the MCP server
and downloading its selected browser binary are separate operator actions.
