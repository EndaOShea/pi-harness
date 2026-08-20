/**
 * Redacted audit log: the observer half of the shared audit trail.
 *
 * `permissions/lib/audit.ts` writes one `request` record per permission
 * gate raised. This extension adds the other two record kinds to the SAME
 * daily file under $PI_AGENT_DIR/harness/audit/audit-YYYY-MM-DD.jsonl (via
 * appendDaily(dir, "audit", ts, record) from ./lib/harness-log.ts), so the
 * three kinds interleave chronologically by process and by adjacency:
 *
 * - `session` (on session_start): provider, model, UI presence, and the
 *   installed harness's version and permission-file hashes, read
 *   best-effort from $PI_AGENT_DIR/harness/.managed-state.json.
 * - `outcome` (on tool_execution_end): tool name, tool-call id, whether the
 *   call ran or was blocked, and the block reason CLASS (never the reason
 *   text) -- see classifyOutcome below.
 *
 * REDACTION IS THE CONTRACT. This module logs identifiers only: no tool
 * output, no command text, no file paths, no prompts. `tool_execution_end`
 * reads a tool result only to classify it (does it start with "Blocked ",
 * and against which of three exact prefixes); the classified STRING is
 * what is logged, never the underlying text.
 *
 * WHY "no-ui" IS ITS OWN CLASS: in a headless run ctx.hasUI is false and
 * pi-permissions turns EVERY approval request into a block. Without a
 * distinct class, an automated or CI transcript reads as a wall of user
 * rejections that never happened, when in fact no human ever saw a prompt.
 *
 * THREE STATED LIMITS (see docs/DEPLOYMENT.md "Redacted audit log"):
 *   1. Correlation between a `request` record and the `outcome` record for
 *      the same tool call is by process and adjacency, not tool-call
 *      identity -- pi-permissions' PermissionInput carries no tool-call id.
 *   2. A headless run's `outcome` records contain no human decisions: every
 *      approval became an automatic `no-ui` block.
 *   3. Approval visibility exists only for policies that already write
 *      `request` records; a policy that never calls logPermissionRequest
 *      leaves no trace here beyond the resulting `outcome`.
 *
 * Environment: PI_AUDIT=0 disables all writing (read at call time, same
 * knob as permissions/lib/audit.ts). PI_AUDIT_KEEP_DAYS (default 30)
 * controls pruning, run once per session on session_start.
 *
 * Fail-open and exception-wrapped throughout: this extension only
 * observes. It must never throw into Pi's event pipeline, never block,
 * never mutate a tool result, never delay anything.
 *
 * Deliberately no dependency on the Pi package types, so this file stays
 * parseable by the repository's validation without an installed runtime
 * (same convention as tpm-telemetry.ts and context-budget.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, appendDaily, pruneOldFiles } from "./lib/harness-log.ts";

function readEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function auditDir(): string {
  return join(agentDir(), "harness", "audit");
}

function auditDisabled(): boolean {
  return process.env.PI_AUDIT === "0";
}

/**
 * Classify a (possibly error) tool result text against the EXACT
 * agent-facing formats emitted by @thurstonsand/pi-permissions@0.9.0
 * (verified in its src/presentation.ts):
 *
 *   hard policy block:  "Blocked by permission hook ${hookName}\n\n${reason}"
 *   user rejection:     "Blocked by user via permission hook ${hookName}" (+ text)
 *   headless auto-block: "Blocked ${toolName} (${hookName}): user confirmation
 *                         required but no UI available."
 *
 * ORDER MATTERS: "Blocked by user via permission hook " and "Blocked by
 * permission hook " share a prefix up to "Blocked by ", so the more
 * specific user-rejection string must be tested first, or every user
 * rejection misclassifies as a policy block.
 *
 * An unrecognised "Blocked " prefix degrades to "other" -- never guess a
 * class. A result that is an error but does NOT start with "Blocked " is
 * an ordinary command failure, not a block: it classifies "ran". Getting
 * this backwards would make every failing shell command look like a
 * permission denial.
 */
export function classifyOutcome(
  text: string,
  isError: boolean,
): "ran" | "policy-block" | "user-rejected" | "no-ui" | "other" {
  if (!isError) {
    return "ran";
  }
  if (text.startsWith("Blocked by user via permission hook ")) {
    return "user-rejected";
  }
  if (text.startsWith("Blocked by permission hook ")) {
    return "policy-block";
  }
  if (/^Blocked \S+ \(.+\): user confirmation required but no UI available\./.test(text)) {
    return "no-ui";
  }
  if (text.startsWith("Blocked ")) {
    return "other"; // unrecognized block format -- degrade, never misclassify
  }
  return "ran"; // ordinary tool error, not a block
}

interface ManagedStateReceipt {
  harnessVersion?: unknown;
  permissions?: unknown;
}

interface HarnessProvenance {
  version: string | null;
  permissionsSha256: string[];
}

/**
 * Best-effort read of the installed harness's version and permission-file
 * hashes from $PI_AGENT_DIR/harness/.managed-state.json. Never throws:
 * a missing or unparseable receipt yields null, never a guess.
 */
function readHarnessProvenance(): HarnessProvenance | null {
  try {
    const path = join(agentDir(), "harness", ".managed-state.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ManagedStateReceipt;
    const version =
      typeof parsed.harnessVersion === "string" && parsed.harnessVersion.trim()
        ? parsed.harnessVersion.trim()
        : null;
    const shas: string[] = [];
    if (Array.isArray(parsed.permissions)) {
      for (const entry of parsed.permissions) {
        const sha = (entry as { sha256?: unknown } | null)?.sha256;
        if (typeof sha === "string" && sha.trim()) {
          shas.push(sha.trim());
        }
      }
    }
    shas.sort();
    return { version, permissionsSha256: shas };
  } catch {
    return null;
  }
}

/** The active provider/model id, read defensively; null when absent. */
function readModel(ctx: unknown): { provider: string | null; model: string | null } {
  const value = (ctx as { model?: unknown } | undefined)?.model;
  if (!value || typeof value !== "object") {
    return { provider: null, model: null };
  }
  const fields = value as Record<string, unknown>;
  const provider = typeof fields.provider === "string" ? fields.provider : null;
  const model = typeof fields.id === "string" ? fields.id : null;
  return { provider, model };
}

/** First text block's text from a tool result's content array, or "". */
function firstResultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return "";
}

interface MinimalExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

let pruned = false;

export default function auditLog(pi: MinimalExtensionApi): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      if (auditDisabled()) {
        return undefined;
      }
      const dir = auditDir();
      if (!pruned) {
        pruned = true;
        pruneOldFiles(dir, readEnvInt("PI_AUDIT_KEEP_DAYS", 30), Date.now());
      }
      const { provider, model } = readModel(ctx);
      const hasUI = (ctx as { hasUI?: unknown } | undefined)?.hasUI === true;
      const record = {
        ts: Date.now(),
        pid: process.pid,
        kind: "session" as const,
        provider,
        model,
        hasUI,
        harness: readHarnessProvenance(),
      };
      appendDaily(dir, "audit", record.ts, record);
    } catch {
      // Auditing must never take down a session.
    }
    return undefined;
  });

  pi.on("tool_execution_end", (rawEvent) => {
    try {
      if (auditDisabled()) {
        return undefined;
      }
      const event = rawEvent as {
        toolCallId?: unknown;
        toolName?: unknown;
        isError?: unknown;
        result?: unknown;
      };
      const toolCallId = event.toolCallId;
      const toolName = event.toolName;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") {
        return undefined;
      }
      const isError = event.isError === true;
      const text = firstResultText(event.result);
      const reason = classifyOutcome(text, isError);
      // "other" reached via an error result without a "Blocked " prefix is
      // impossible (classifyOutcome only returns "other" for a recognised
      // "Blocked " prefix it can't further classify); an ordinary failing
      // command already classified "ran" above. result mirrors reason 1:1
      // except reason "ran" maps to result "ran" and everything else maps
      // to result "blocked".
      const result = reason === "ran" ? "ran" : "blocked";
      const record = {
        ts: Date.now(),
        pid: process.pid,
        kind: "outcome" as const,
        toolCallId,
        toolName,
        result,
        reason,
      };
      appendDaily(auditDir(), "audit", record.ts, record);
    } catch {
      // Auditing must never take down a session or alter a tool result.
    }
    return undefined;
  });
}
