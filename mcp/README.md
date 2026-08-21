# MCP Servers

This directory contains configuration examples and operating guidance for MCP
servers used by the Pi harness. Server source repositories, runtime
environments, model data, and secrets are maintained outside this repository.

## Directory contents

| File | Purpose |
| --- | --- |
| [`mcp.global.example.json`](mcp.global.example.json) | Portable shared MCP template. It enables Context7 and includes a disabled local stdio launcher placeholder. |
| [`playwright.optional.example.json`](playwright.optional.example.json) | Disabled, pinned Playwright MCP application using isolated headless Firefox and an explicit tool allowlist. |
| [`mcp.local.example.json`](mcp.local.example.json) | Reserved project-local configuration placeholder; it is currently empty. |
| [`servers.example.json`](servers.example.json) | Reserved server configuration placeholder; it is currently empty. |

The empty placeholder files do not configure any MCP servers.

## Configuration layers

Pi MCP Adapter loads several configuration layers. This harness uses two of
them deliberately:

- `~/.pi/agent/mcp.json` is Pi's global override. The harness installer merges
  the required Context7 definition here.
- `~/.config/mcp/mcp.json` is the user-global shared MCP file. It can expose
  optional safe servers to Pi and other compatible clients, but the harness
  never copies the example into it automatically.

Use a project's `.mcp.json` for project-specific, write-capable, or
infrastructure-sensitive servers. Global servers should use lazy startup and
should be read-only whenever possible.

Playwright is intentionally absent from the required and shared global
templates. Its dedicated optional template must be merged explicitly when
browser automation is needed; normal harness installation never downloads a
browser or exposes browser tools.

Later project-specific Pi layers may override global definitions. Consult the
pinned Pi MCP Adapter documentation before relying on precedence beyond these
harness-managed layers.

## Quick start

From the harness repository root, first validate the example:

```bash
python3 -m json.tool mcp/mcp.global.example.json
```

Normal harness installation merges the required Context7 declaration into
Pi's global override at `~/.pi/agent/mcp.json`. It preserves unrelated servers
and refuses to overwrite an incompatible server named `context7`. Additional
fields on a compatible definition, such as private authentication headers, are
preserved. Use `PI_AGENT_DIR` when Pi's agent directory is elsewhere.

To share all servers in the example with other MCP-capable applications,
create the shared configuration directory and copy the template:

```bash
mkdir -p ~/.config/mcp
cp mcp/mcp.global.example.json ~/.config/mcp/mcp.json
```

If `~/.config/mcp/mcp.json` already exists, merge the template's `mcpServers`
entries into it instead of overwriting the file.

## Required server

### Context7

Provides current library and framework documentation through a read-only MCP
integration. The required server is installed into Pi's global MCP override
with lazy lifecycle and is also included in the shared example template.

- Endpoint: `https://mcp.context7.com/mcp`
- Required secrets: none for provider-default rate limits
- Optional higher limits: set `CONTEXT7_API_KEY` outside Git and add a private
  `headers` entry to the installed MCP definition
- Template name: `context7`

For higher limits, extend only the installed private configuration:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "lifecycle": "lazy",
      "headers": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      }
    }
  }
}
```

Do not commit the environment variable's value.

## Optional server

### Playwright browser automation

The optional Playwright application provides rendered-page inspection and
interaction through the official Microsoft MCP server. It complements
`pi-web-access`; it does not replace web search or static content extraction.
Prefer the static tools when they suffice, but an explicit user request for
the browser overrides that preference.

The reviewed template:

- pins `@playwright/mcp@0.0.79` and uses lazy stdio startup;
- selects Firefox, not Chromium;
- runs headless with an isolated in-memory browser profile;
- blocks service workers and uses the default stdio transport;
- writes page snapshots and screenshots to `/tmp/pi-playwright` rather than
  the working directory, capped at 64MB by `--output-max-size` so the store
  evicts rather than accumulates. Without `--output-dir` the server creates
  `.playwright-mcp/` inside whatever repository the session started in, where
  captures become untracked files an agent later sweeps into a commit — 13 of
  them reached a real project's history that way. The temp directory is
  already exempt from workspace-scope approval, so nothing gates on it;
- allowlists the browser tools required for navigation and UI testing;
- does not expose `browser_run_code_unsafe`, `browser_evaluate`, file
  upload/drop, cookie/storage controls, network mocking, or other newly added
  tools unless the template is reviewed and updated deliberately.

It is disabled in the example. To install it, first validate and review the
exact definition:

```bash
python3 -m json.tool mcp/playwright.optional.example.json
```

Merge its `playwright` entry into either a project's `.mcp.json` (preferred)
or the user-global `~/.config/mcp/mcp.json`; never overwrite unrelated MCP
servers. Remove `"disabled": true` only after approving the pinned `npx`
package execution.

The MCP package and the browser binary are separate. Downloading Firefox is a
large, networked operation and is never performed by the harness installer.
After reviewing the exact version and destination, the operator may run:

```bash
npx -y playwright@1.63.0-alpha-2026-08-05 install firefox
```

Restart Pi after enabling the server. Playwright MCP is not a security
boundary: use it only on sites appropriate for an isolated unauthenticated
browser, treat page content as untrusted, and obtain approval before form
submission or any externally visible action. Do not attach a personal browser
profile or add unrestricted file access.

## Adding your own servers

Fork-specific servers belong in your fork of this file set, following the
same discipline the harness applies everywhere else:

1. Prefer hosted read-only endpoints with `"lifecycle": "lazy"`; use the
   disabled `example-local-server` stdio pattern for local launchers, and
   enable an entry only after its launcher is installed and verified.
2. Never commit endpoints, hostnames, IP addresses, or paths that reveal
   private infrastructure; a validation test rejects known private markers,
   and your fork should extend that list for its own.
3. Keep credentials in environment variables referenced from the installed
   (uncommitted) configuration, never in this repository.
4. Document each server here: purpose, access level (read-only or writing),
   transport, and required secrets.
5. Add a server to `config/required-mcp.json` only if every installation of
   your harness must have it; everything else stays an optional example.
6. Test each server independently before enabling it in normal sessions.

### Walkthrough: adding a personal server to the shared layer

The installer only merges the required servers from `config/required-mcp.json`
into `~/.pi/agent/mcp.json`. Personal, optional servers live in the shared
user-global layer `~/.config/mcp/mcp.json`, which the harness never populates
automatically — so a fresh machine has none of them until you add them. This
is per-machine setup, not something a reinstall reproduces; keep the canonical
list of your servers in a fork-owned doc so a new machine is a known checklist.

1. **Declare the server in your fork's example**, e.g. `mcp/mcp.global.example.json`,
   so it is version-controlled and reviewable. Prefer a hosted read-only URL:

   ```json
   {
     "mcpServers": {
       "my-server": {
         "url": "https://mcp.example.com/mcp",
         "lifecycle": "lazy"
       }
     }
   }
   ```

   A local stdio launcher is the offline alternative; reference a machine-set
   environment variable rather than a hard-coded path, and ship it
   `"disabled": true` until its launcher is installed:

   ```json
   {
     "mcpServers": {
       "my-server-local": {
         "command": "bash",
         "args": ["-lc", "exec \"$MY_SERVER_HOME/scripts/run-mcp.sh\""],
         "lifecycle": "lazy",
         "disabled": true
       }
     }
   }
   ```

2. **Verify the endpoint answers a real MCP handshake** before wiring it in —
   a plain `GET` returns 400 from a streamable-HTTP server, which is expected;
   POST an `initialize` instead:

   ```bash
   curl -s -X POST https://mcp.example.com/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
   ```

   A `result` with `serverInfo` means it will connect in Pi.

3. **Merge (do not overwrite) the entry into the live shared layer.** If the
   file already holds other servers, add yours to `mcpServers` rather than
   replacing the file:

   ```bash
   mkdir -p ~/.config/mcp
   # first server only — copy the template
   cp mcp/mcp.global.example.json ~/.config/mcp/mcp.json
   # additional servers — merge, preserving existing entries
   python3 - <<'PY'
   import json, pathlib
   live = pathlib.Path.home() / ".config/mcp/mcp.json"
   cfg = json.loads(live.read_text()) if live.exists() else {"mcpServers": {}}
   tmpl = json.loads(pathlib.Path("mcp/mcp.global.example.json").read_text())
   cfg["mcpServers"]["my-server"] = tmpl["mcpServers"]["my-server"]
   live.write_text(json.dumps(cfg, indent=2))
   print("shared layer now:", list(cfg["mcpServers"]))
   PY
   ```

4. **Restart Pi and check `/mcp`.** A lazy server shows `(not cached)` until
   first use — that is normal, not a failure. Highlight it and press `ctrl+r`
   to reconnect (fetches and caches its tool schemas), then `↵` to expand and
   confirm the tool count matches what you documented. Or just call one of its
   tools; the connection fires on first use.

## Verification

Validate the required Pi override after a normal harness installation:

```bash
python3 -m json.tool ~/.pi/agent/mcp.json
```

If the optional shared template was installed manually, validate it
separately:

```bash
python3 -m json.tool ~/.config/mcp/mcp.json
```

Restart Pi, then inspect the MCP connections:

```text
/mcp
```

Every normal harness installation should list `context7`. A profile installed
with `--skip-mcp` will list it only if another configuration layer provides
it. Personal servers added to the shared layer appear here too; a lazy one
shows `(not cached)` until first use. The shared template's disabled
`example-local-server` entry remains unavailable until a real launcher is
configured and the entry is enabled. Reconnect a configured server when needed
(this also caches a lazy server's tools without waiting for first use):

```text
/mcp reconnect context7
```

An explicitly enabled Playwright application can be checked separately:

```text
/mcp reconnect playwright
```

Use a read-only navigation and snapshot first. Confirm that `/mcp tools`
does not list arbitrary-code or file-transfer tools for the server.

Use read-only test prompts when checking a server.

## Security

Never commit API keys, OAuth tokens, authentication headers, `.env` files,
private document paths, database credentials, or production-only endpoints.
Any MCP server capable of deleting files, modifying repositories, changing
infrastructure, or writing external data must have explicit permission rules
and should not be enabled globally by default.
