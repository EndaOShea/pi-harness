# CI fixtures

`fake-provider.ts` is a deterministic, in-process Pi provider
(`harness-ci-fake`, model `fake-1`) that replays a fixed three-call
script with zero network access, so CI can drive the *fully installed*
harness end to end without a real model: a destructive command and a
secret read, both gated by the permission layer and both resolving
headlessly to a no-UI block (verified: no policy under `permissions/`
calls `block()`, so every gate is a `request()` that auto-blocks
without a UI attached), and a benign command that must run. Nothing
between `pi` and the permission hooks is stubbed — only the model is
replaced.

## Scope

Repo tooling, not payload: not installed by `scripts/install.sh`
(which globs `extensions/`, not `tests/`), not listed in
`config/resources.json`, and not added to `packages/pi-packages.txt`.
A fork that adds permission policies of its own should extend the
script below rather than assume this one still covers it.

## Verify locally

```bash
export PI_AGENT_DIR=$(mktemp -d)/agent
export PI_CODING_AGENT_DIR=$PI_AGENT_DIR
./scripts/install.sh
timeout 300 pi -e tests/fixtures/ci/fake-provider.ts \
  --provider harness-ci-fake --model fake-1 \
  -p --no-session --mode json "run the script" \
  </dev/null > /tmp/ci-events.jsonl
```

Expect exactly three `tool_execution_end` events, in order: `bash`
`isError` true with text starting `Blocked `, `read` `isError` true
with text containing `no UI available`, and `bash` `isError` false with
text `ok`. Redirecting stdin from `/dev/null` is required — `pi -p`
blocks on an open stdin and the run will otherwise hang with no output.
