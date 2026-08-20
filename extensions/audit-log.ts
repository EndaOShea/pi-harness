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
  /**
   * Optional so a caller that only wires events -- the test harness does
   * exactly that -- stays valid. A Pi runtime always supplies it.
   */
  registerCommand?(
    name: string,
    spec: {
      description: string;
      handler: (args: unknown, ctx: unknown) => string;
    },
  ): void;
}

let pruned = false;
let sessionStartedAt: number | null = null;

/**
 * Cap on how much of today's audit file `/approvals` parses.
 *
 * Records are tiny, so a normal day is far under this. The cap exists for
 * the pathological case -- a runaway loop gating thousands of calls -- so
 * a reporting command can never stall a session by reading an unbounded
 * file. The tail is kept, because recency is what the report is about,
 * and the first (probably partial) line of a truncated read is dropped.
 */
const MAX_AUDIT_READ_BYTES = 4_000_000;

interface AuditRecord {
  ts?: number;
  pid?: number;
  kind?: string;
  policy?: string;
  rule?: string;
  reason?: string;
}

function readTodayRecords(now: number): AuditRecord[] {
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    let raw = readFileSync(join(auditDir(), `audit-${day}.jsonl`), "utf8");
    if (raw.length > MAX_AUDIT_READ_BYTES) {
      raw = raw.slice(raw.length - MAX_AUDIT_READ_BYTES);
      const firstBreak = raw.indexOf("\n");
      raw = firstBreak === -1 ? "" : raw.slice(firstBreak + 1);
    }
    const records: AuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        // A torn final line from a concurrent append is not an error.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** Count occurrences, most frequent first. */
function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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
      sessionStartedAt = Date.now();
      const record = {
        ts: sessionStartedAt,
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

  /**
   * `/approvals` -- approval-gate load, from the records this extension and
   * the permission policies already write.
   *
   * The harness's permission layer is approval ASSISTANCE, not isolation:
   * its real failure mode is not a matcher that can be evaded but an
   * operator who has approved two hundred prompts and stopped reading. That
   * risk was documented and unmeasured, which is the wrong pair -- the
   * audit log already holds every number needed to see it happening.
   *
   * The headline is the approval RATE, not the count. A gate approved
   * essentially every time has stopped carrying information, whether it
   * fired five times or five hundred, and the by-policy breakdown names
   * which one to narrow.
   *
   * Two honesty constraints on what this may claim:
   *
   *   1. It counts GATES RAISED, not prompts a human saw. Policies are
   *      evaluated independently, so one tool call can raise more than one
   *      gate, and a headless run raises gates nobody ever saw.
   *   2. The approved figure is DERIVED by subtraction, never by pairing a
   *      request record to an outcome record -- that correlation is by
   *      adjacency and is documented as unreliable. Every rejection,
   *      headless auto-block and policy block produces its own outcome
   *      record, so subtracting their counts bounds the approvals without
   *      pairing anything. It is reported as approximate because it is.
   */
  pi.registerCommand?.("approvals", {
    description:
      "Show approval-gate load: how often policies gate, and how often you approve.",
    handler(_args, ctx) {
      const lines: string[] = [];
      try {
        if (auditDisabled()) {
          lines.push("Approval load: audit logging is off (PI_AUDIT=0).");
        } else {
          const now = Date.now();
          const records = readTodayRecords(now);
          const ownRequests = records.filter(
            (record) => record.pid === process.pid && record.kind === "request",
          );
          const todayRequests = records.filter(
            (record) => record.kind === "request",
          );
          const ownOutcomes = records.filter(
            (record) => record.pid === process.pid && record.kind === "outcome",
          );
          const processes = new Set(todayRequests.map((record) => record.pid));

          const countReason = (reason: string) =>
            ownOutcomes.filter((record) => record.reason === reason).length;
          const rejected = countReason("user-rejected");
          const noUi = countReason("no-ui");
          const policyBlocked = countReason("policy-block");

          const raised = ownRequests.length;
          const notApproved = rejected + noUi + policyBlocked;
          const approved = Math.max(0, raised - notApproved);
          const startedAt =
            sessionStartedAt ??
            records
              .filter((record) => record.pid === process.pid)
              .map((record) => record.ts)
              .find((ts): ts is number => typeof ts === "number") ??
            null;
          const elapsed = startedAt === null ? null : now - startedAt;

          lines.push(
            `Approval load (pid ${process.pid}` +
              `${elapsed === null ? "" : `, session ${formatDuration(elapsed)}`})`,
          );
          lines.push(
            `  gates raised: ${raised} this session, ${todayRequests.length} ` +
              `today across ${processes.size} process(es)`,
          );

          if (raised > 0) {
            const byPolicy = tally(
              ownRequests.map((record) => record.policy ?? "unknown"),
            );
            lines.push(
              `  by policy: ${byPolicy
                .slice(0, 4)
                .map(([name, count]) => `${name} ${count}`)
                .join(", ")}`,
            );
            const byRule = tally(ownRequests.map((record) => record.rule ?? "unknown"));
            lines.push(
              `  top rules: ${byRule
                .slice(0, 3)
                .map(([name, count]) => `${name} ${count}`)
                .join(", ")}`,
            );
            lines.push(
              `  resolved: ~${approved} approved, ${rejected} rejected, ` +
                `${policyBlocked} policy-blocked, ${noUi} no-ui`,
            );

            const rate = approved / raised;
            lines.push(
              `  approval rate: ~${Math.round(rate * 100)}% ` +
                "(derived by subtraction, not by pairing)",
            );
            if (raised >= 20 && rate >= 0.9) {
              lines.push(
                "  WARNING: a gate approved this reliably has stopped carrying",
                "  information. Narrow the rule below, or move the work so it",
                "  stops firing — approving on reflex is the failure this",
                "  layer cannot catch.",
                `  most frequent: ${byPolicy[0]?.[0] ?? "unknown"}`,
              );
            }
          }

          lines.push(
            "  note: counts gates raised, not prompts seen — policies are",
            "  evaluated independently, so one call can raise more than one.",
          );
        }
      } catch {
        lines.length = 0;
        lines.push("Approval load: unavailable (audit log could not be read).");
      }

      for (const line of lines) {
        try {
          (ctx as { ui?: { notify?: (text: string) => void } } | undefined)
            ?.ui?.notify?.(line);
        } catch {
          // Non-TUI modes skip notifications.
        }
      }
      return lines.join("\n");
    },
  });
}
