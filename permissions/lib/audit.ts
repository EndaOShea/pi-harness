/**
 * Minimal audit appender for permission policies.
 *
 * Each policy calls logPermissionRequest at the moment it returns a
 * decision, recording ONLY identifiers it already computed: policy name,
 * tool name, matched rule name, and decision kind. Never paths, command
 * text, file contents, or prompts — the audit log is replayable policy
 * evidence, not a transcript.
 *
 * This file deliberately duplicates a few lines of extensions/lib/
 * harness-log.ts rather than importing it: permission modules are COPIED
 * into $PI_AGENT_DIR/permissions at install time (extensions are
 * symlinked), so a cross-tree import would break in the installed product.
 * Pruning lives in extensions/audit-log.ts; this module only appends.
 *
 * Environment: PI_AUDIT=0 disables (read at call time). Fail-open: any
 * filesystem error is swallowed — auditing must never block a decision.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PermissionAuditEntry {
  policy: string;
  toolName: string;
  rule: string;
  decision: "block" | "request";
}

// Defensive cap: no legitimate rule identifier approaches this length: it
// exists only to bound an unanticipated future caller that passes a blob
// instead of an identifier. Truncates rather than drops the record so the
// decision is still evidenced.
const MAX_RULE_LENGTH = 200;

/**
 * Redact a rule identifier before it is logged, without touching what the
 * identical string shows the human in the approval prompt (callers pass
 * the same string to `guidance`; this function runs only on the copy
 * destined for the log).
 *
 * Most rule identifiers look like a bounded category label, optionally
 * followed by a parenthesised RELATIVE constant the policy itself defined,
 * e.g. "credential store (.ssh)" or "credential file (.aws/credentials)".
 * A few permissions/lib/path-matchers.js branches of isSecretFile()
 * (system credential file, system credential store, Windows
 * credential/system hive) instead interpolate the full RESOLVED path,
 * because they match "is this path under a configured root" rather than
 * "does this path equal a configured constant". Those payloads must never
 * reach the log.
 *
 * This is an ALLOWLIST, and that is the whole point. Four previous
 * implementations were DENYLISTS — find the bad payload and strip it — and
 * every one of them was defeated by an ordinary filename, because a POSIX
 * filename may contain any byte except "/" and NUL:
 *
 *   1. assumed a recognisable absolute prefix at a fixed position;
 *   2. assumed the payload contained no parentheses (/\s*\(([^()]*)\)/g),
 *      defeated by "notes(1).pem", the OS default collision-rename shape;
 *   3. split the rule on the segment separator ", " before scanning,
 *      defeated by "notes, secret.pem" — the split cut the path in half
 *      and rejoining rebuilt it byte-for-byte;
 *   4. a parenthesis-DEPTH scan, which assumes every ")" is balanced by an
 *      earlier "(", defeated by "a)b.pem" — depth returned to 0 mid-path
 *      and the path's remainder was emitted verbatim.
 *
 * There is always another character. So nothing is stripped: a payload is
 * EMITTED only when it provably matches BOUNDED_PAYLOAD, the grammar of
 * the policy constants in this codebase (".ssh", ".aws/credentials",
 * ".npmrc", "Login Data"). Those never begin with a separator and never
 * contain parentheses, commas, backslashes or colons. Anything else — any
 * absolute path, any hostile filename, any unterminated span — fails the
 * test and only the category label is logged. There is no span-finding to
 * get wrong.
 *
 * ACCEPTED TRADE-OFF: for a multi-identifier rule such as
 * "credential store (.ssh), system credential store (/etc/ssl/private/k.pem)",
 * `inner` spans from the first "(" to the end of the string, fails the
 * allowlist, and the output is just "credential store" — the second
 * identifier's label is lost. That is deliberate. Provable non-leakage is
 * worth more than complete signal, and the record still evidences that a
 * credential store was involved. Do NOT reintroduce splitting on ", " to
 * recover it: that was round 3's bug.
 *
 * If redacting leaves nothing, the literal "redacted" is logged — an empty
 * rule is a useless audit record.
 */
const MAX_PAYLOAD_LENGTH = 64;
const BOUNDED_PAYLOAD = /^\.?[A-Za-z0-9][A-Za-z0-9 ._-]*(?:\/[A-Za-z0-9 ._-]+)*$/;

function cap(value: string): string {
  return value.length > MAX_RULE_LENGTH ? value.slice(0, MAX_RULE_LENGTH) : value;
}

function sanitizeRule(rule: string): string {
  const s = String(rule ?? "").trim();
  const open = s.indexOf("(");
  if (open === -1) {
    return cap(s) || "redacted";
  }
  const label = s.slice(0, open).trim();
  let inner = s.slice(open + 1);
  if (inner.endsWith(")")) {
    inner = inner.slice(0, -1);
  }
  inner = inner.trim();
  const keep =
    inner.length > 0 &&
    inner.length <= MAX_PAYLOAD_LENGTH &&
    BOUNDED_PAYLOAD.test(inner);
  const result = keep ? `${label} (${inner})` : label;
  return cap(result.trim()) || "redacted";
}

export function logPermissionRequest(entry: PermissionAuditEntry): void {
  try {
    if (process.env.PI_AUDIT === "0") {
      return;
    }
    const agent = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
    const dir = join(agent, "harness", "audit");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ts = Date.now();
    const day = new Date(ts).toISOString().slice(0, 10);
    const record = {
      ts,
      pid: process.pid,
      kind: "request",
      policy: entry.policy,
      toolName: entry.toolName,
      rule: sanitizeRule(entry.rule),
      decision: entry.decision,
    };
    appendFileSync(join(dir, `audit-${day}.jsonl`), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Auditing must never block or fail a permission decision.
  }
}
