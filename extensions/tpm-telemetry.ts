/**
 * Harness rate-limit telemetry and TPM governor.
 *
 * This extension delays provider requests that would exceed the remaining
 * token budget. It never rewrites a payload and never retries: the agent's
 * request goes out exactly as composed, only later. What it does:
 *
 * - holds an outbound request when the estimated budget cannot cover it
 *   (before_provider_request, whose handler Pi awaits in the request path);
 * - captures each provider response's HTTP status, retry-after interval,
 *   and any exposed x-ratelimit-* headers (after_provider_response);
 * - samples current context usage per turn (ctx.getContextUsage);
 * - appends one JSON record per provider response to a shared, append-only
 *   daily log so concurrent Pi processes (for example subagents) become
 *   visible to each other, and so the governor can account for their spend;
 * - registers `/tpm`: session request/429 counts, the last-60s picture
 *   across processes, recent rate-limit headers, budget remaining, holds
 *   taken, and current context usage.
 *
 * The governor is fail-open by construction. It never blocks on absent
 * evidence (no reported budget reads as a full bucket), never holds longer
 * than PI_TPM_MAX_WAIT_MS, honors the abort signal, and lets the request
 * through on any internal error. Disable entirely with PI_TPM_GOVERNOR=0.
 * Design: docs/superpowers/specs/2026-08-17-tpm-governor-design.md.
 *
 * All filesystem access is best-effort and exception-wrapped: telemetry
 * must never take down a session. Records live under
 * $PI_AGENT_DIR/harness/telemetry/ (default ~/.pi/agent/harness/telemetry/),
 * rotate daily, and older files are pruned after 14 days.
 *
 * Deliberately no dependency on the Pi package types, so this file stays
 * parseable by the repository's validation without an installed runtime
 * (same convention as local-models.ts).
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
const TELEMETRY_DIR = join(AGENT_DIR, "harness", "telemetry");
const KEEP_DAYS = 14;
const ROLLING_WINDOW_MS = 60_000;
const MAX_RECENT_FILES = 3;

function readEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Skew between sibling Pi processes treated as ordinary rather than bogus.
 *
 * Every process stamps its own records, so their clocks are never exactly
 * equal. Beyond this tolerance a record is from a clock we cannot trust:
 * without an upper bound a future-stamped record becomes the newest anchor
 * and dictates both the level and the limit, turning skew into holds.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

function isUsableTimestamp(ts: unknown, now: number): boolean {
  return (
    typeof ts === "number" &&
    Number.isFinite(ts) &&
    ts <= now + CLOCK_SKEW_TOLERANCE_MS
  );
}

/** Governor knobs. Disable with PI_TPM_GOVERNOR=0. */
const GOVERNOR_ENABLED = process.env.PI_TPM_GOVERNOR !== "0";
const GOVERNOR_RESERVE = readEnvInt("PI_TPM_RESERVE", 20_000);
const GOVERNOR_MAX_WAIT_MS = readEnvInt("PI_TPM_MAX_WAIT_MS", 60_000);
/** Used only until a provider reports x-ratelimit-limit-tokens. */
const GOVERNOR_FALLBACK_LIMIT = readEnvInt("PI_TPM_LIMIT", 200_000);
/**
 * "actual" is correct for OpenAI, measured 2026-08-17: the same prompt at
 * max_tokens 1000 and 50000 spent an identical 8 tokens of budget, so the
 * requested ceiling never enters TPM accounting. PI_TPM_POLICY=reserved
 * remains for providers that do bill the ceiling.
 */
const GOVERNOR_POLICY: "reserved" | "actual" =
  process.env.PI_TPM_POLICY === "reserved" ? "reserved" : "actual";
const GOVERNOR_OUTPUT_ESTIMATE = readEnvInt("PI_TPM_OUTPUT_ESTIMATE", 16_000);

interface ModelAttribution {
  provider: string | null;
  model: string | null;
}

interface GovernorLimits {
  /** Provider token budget per 60s window. */
  limit: number;
  /** Headroom for sibling processes not yet visible in the shared log. */
  reserve: number;
  /** Upper bound on any single hold, so the agent can never be parked. */
  maxWaitMs: number;
}

interface TelemetryRecord {
  ts: number;
  pid: number;
  status: number | null;
  retryAfterMs: number | null;
  rateLimit: Record<string, string> | null;
  contextTokens: number | null;
  provider: string | null;
  model: string | null;
  /** True on a claim written before a request is sent. */
  intent?: boolean;
  /** Links a claim to the response that settles it. */
  intentId?: string | null;
  /** Tokens claimed by an in-flight request. Intent records only. */
  estimatedCost?: number | null;
}

interface MinimalExtensionContext {
  hasUI?: boolean;
  mode?: string;
  /** Current model, when one is active. Shape is read defensively. */
  model?: unknown;
  /** Abort signal while streaming, so a governor hold stays interruptible. */
  signal?: { aborted?: boolean; addEventListener?: unknown; removeEventListener?: unknown };
  getContextUsage?: () => { tokens: number } | null | undefined;
  ui?: {
    notify?: (message: string, level?: string) => void;
    setStatus?: (key: string, text: string) => void;
  };
}

interface MinimalExtensionApi {
  on(
    event: string,
    handler: (
      event: unknown,
      ctx: MinimalExtensionContext,
    ) => void | Promise<void>,
  ): void;
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (
        args: string,
        ctx: MinimalExtensionContext,
      ) => string | void | Promise<string | void>;
    },
  ): void;
}

let sessionRequests = 0;
let sessionRateLimited = 0;
let lastRetryAfterMs: number | null = null;
let lastRateLimit: Record<string, string> | null = null;
let lastContextTokens: number | null = null;
let sessionHolds = 0;
let sessionHeldMs = 0;
/**
 * The claim awaiting its response.
 *
 * One per process is enough because a Pi session issues provider requests
 * sequentially; concurrent work runs as separate processes, which is why
 * the shared log exists. A stale id simply settles the wrong claim, and
 * both expire out of the rolling window within the minute.
 */
let pendingIntentId: string | null = null;
let intentCounter = 0;

function dayStamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function logFilePath(timestamp: number): string {
  return join(TELEMETRY_DIR, `tpm-${dayStamp(timestamp)}.jsonl`);
}

function ensureTelemetryDir(): boolean {
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function appendRecord(record: TelemetryRecord): void {
  if (!ensureTelemetryDir()) {
    return;
  }
  try {
    appendFileSync(logFilePath(record.ts), `${JSON.stringify(record)}\n`);
  } catch {
    // Telemetry failure is never fatal.
  }
}

/** Prune daily logs older than KEEP_DAYS. Called once per session. */
function pruneOldFiles(): void {
  if (!ensureTelemetryDir()) {
    return;
  }
  const cutoff = dayStamp(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  let names: string[];
  try {
    names = readdirSync(TELEMETRY_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^tpm-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match || match[1] >= cutoff) {
      continue;
    }
    try {
      unlinkSync(join(TELEMETRY_DIR, name));
    } catch {
      // Keep going; pruning is opportunistic.
    }
  }
}

function parseRetryAfterMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value * 1000);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.round(numeric * 1000);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed - Date.now()));
    }
  }
  return null;
}

function extractRateLimitHeaders(
  headers: Record<string, unknown>,
): Record<string, string> | null {
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^x-ratelimit-/i.test(key) && typeof value === "string") {
      found[key.toLowerCase()] = value;
    }
  }
  return Object.keys(found).length > 0 ? found : null;
}

/** Read records from recent daily logs, tolerating partial or foreign lines. */
function readRecentRecords(now: number): TelemetryRecord[] {
  if (!ensureTelemetryDir()) {
    return [];
  }
  const days = new Set<string>();
  for (let offset = 0; offset < MAX_RECENT_FILES; offset += 1) {
    days.add(dayStamp(now - offset * 24 * 60 * 60 * 1000));
  }
  const records: TelemetryRecord[] = [];
  const cutoff = now - ROLLING_WINDOW_MS;
  for (const day of days) {
    let lines: string[] = [];
    try {
      lines = readFileSync(join(TELEMETRY_DIR, `tpm-${day}.jsonl`), "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as TelemetryRecord;
        if (
          typeof parsed.pid === "number" &&
          isUsableTimestamp(parsed.ts, now) &&
          parsed.ts >= cutoff
        ) {
          records.push(parsed);
        }
      } catch {
        // Skip malformed lines.
      }
    }
  }
  return records;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return String(tokens);
}

/**
 * Attribute a response to its provider and model.
 *
 * The shared log interleaves every provider a session touches, so an
 * unattributed record cannot be counted against one provider's budget.
 * Anything that is not a non-blank string degrades to null: the log is
 * read by other processes and must never carry objects or blanks.
 */
export function describeModel(model: unknown): ModelAttribution {
  if (!model || typeof model !== "object") {
    return { provider: null, model: null };
  }
  const fields = model as Record<string, unknown>;
  return {
    provider: readNonBlankString(fields.provider),
    model: readNonBlankString(fields.id),
  };
}

/**
 * The provider's own reported token budget, newest report wins.
 *
 * 200000 TPM is one account tier, not a constant: hardcoding it would
 * throttle a higher-tier account to a fraction of its real budget. Returns
 * null when nothing has been reported, leaving the fallback to the caller.
 */
export function readReportedLimit(
  records: TelemetryRecord[],
  provider: string | null,
  now: number,
): number | null {
  let limit: number | null = null;
  let limitTs = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (
      record.provider !== provider ||
      !isUsableTimestamp(record.ts, now) ||
      record.ts < limitTs
    ) {
      continue;
    }
    const raw = record.rateLimit?.["x-ratelimit-limit-tokens"];
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isFinite(value) && value > 0) {
      limit = value;
      limitTs = record.ts;
    }
  }
  return limit;
}

/**
 * What a pending request will draw from the bucket.
 *
 * Providers differ on whether the requested output ceiling is reserved
 * against the budget or only actual output is billed. For OpenAI this was
 * settled by measurement on 2026-08-17: the same prompt at max_tokens 1000
 * and 50000 spent an identical 8 tokens, so the ceiling never enters TPM
 * accounting and the "actual" policy is correct. `maxTokens` is therefore
 * read only under PI_TPM_POLICY=reserved, which remains for providers that
 * do bill the requested ceiling. See
 * docs/superpowers/specs/2026-08-17-tpm-governor-design.md.
 *
 * An unknown or nonsensical input size estimates 0, so the governor never
 * stalls an agent on the basis of no evidence.
 */
export function estimateCost(input: {
  contextTokens: number | null;
  maxTokens?: number | null;
  policy: "reserved" | "actual";
  outputEstimate: number;
}): number {
  const context = input.contextTokens;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
    return 0;
  }
  const ceiling =
    typeof input.maxTokens === "number" &&
    Number.isFinite(input.maxTokens) &&
    input.maxTokens > 0
      ? input.maxTokens
      : null;
  const output =
    input.policy === "reserved" && ceiling !== null
      ? ceiling
      : input.outputEstimate;
  return Math.round(context + output);
}

/**
 * Estimate how many tokens remain in a provider's TPM bucket.
 *
 * Anchored on the newest `x-ratelimit-remaining-tokens` the provider itself
 * reported: that number is authoritative, where a counter we maintain
 * drifts. Spend logged after the anchor is subtracted (context tokens stand
 * in for cost), and linear refill is added for elapsed time.
 *
 * Records are filtered by provider: sibling processes write to the same log,
 * but an Anthropic request does not spend OpenAI's budget. With no anchor at
 * all the bucket reads as full — the governor must never stall an agent on
 * the basis of no evidence.
 */
export function estimateBucket(
  records: TelemetryRecord[],
  now: number,
  config: GovernorLimits,
  provider: string | null,
): number {
  const mine = records.filter(
    (record) => record.provider === provider && isUsableTimestamp(record.ts, now),
  );
  let anchor: TelemetryRecord | null = null;
  let anchorRemaining = 0;
  for (const record of mine) {
    const raw = record.rateLimit?.["x-ratelimit-remaining-tokens"];
    const remaining = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(remaining)) {
      continue;
    }
    if (!anchor || record.ts >= anchor.ts) {
      anchor = record;
      anchorRemaining = remaining;
    }
  }
  if (!anchor) {
    return config.limit;
  }

  // A claim whose response has arrived is already represented by that
  // response, so counting both would charge one request twice.
  const settled = new Set<string>();
  for (const record of mine) {
    if (!record.intent && typeof record.intentId === "string") {
      settled.add(record.intentId);
    }
  }

  let level = anchorRemaining;
  for (const record of mine) {
    if (record === anchor || record.ts < anchor.ts) {
      continue;
    }
    if (record.intent) {
      const claimed = record.estimatedCost;
      const unsettled =
        typeof record.intentId !== "string" || !settled.has(record.intentId);
      if (unsettled && typeof claimed === "number" && Number.isFinite(claimed)) {
        level -= Math.max(0, claimed);
      }
      continue;
    }
    level -= record.contextTokens ?? 0;
  }
  level += Math.max(0, now - anchor.ts) * (config.limit / 60_000);
  return Math.max(0, Math.min(config.limit, Math.round(level)));
}

/**
 * How long to hold a request so it fits the remaining token budget.
 *
 * OpenAI refills its TPM bucket linearly at `limit` per 60s — verified
 * against x-ratelimit-reset-tokens to three decimal places — so a shortfall
 * converts directly to a wait. `reserve` is headroom for sibling Pi
 * processes whose requests have not yet reached the shared log.
 *
 * Returns 0 when the request cannot be helped by waiting: a request larger
 * than the entire bucket will 429 whenever it is sent, and holding the agent
 * for a minute first only wastes the minute.
 */
export function decideWait(
  level: number,
  cost: number,
  config: GovernorLimits,
): number {
  if (cost <= 0 || cost > config.limit) {
    return 0;
  }
  const shortfall = cost + config.reserve - level;
  if (shortfall <= 0) {
    return 0;
  }
  const refillPerMs = config.limit / 60_000;
  return Math.min(Math.ceil(shortfall / refillPerMs), config.maxWaitMs);
}

/**
 * A claim on the budget, written before a request goes out.
 *
 * Response records land a full round-trip after the spend begins, so
 * processes deciding concurrently each see a budget none of the others has
 * spent yet and all proceed. Writing the claim first makes in-flight work
 * visible to siblings immediately.
 *
 * An orphaned claim — a request that errored before any response — expires
 * on its own, because records outside the rolling window are not read and
 * the bucket refills fully within it.
 */
export function buildIntentRecord(input: {
  ts: number;
  pid: number;
  provider: string | null;
  model: string | null;
  estimatedCost: number;
  intentId: string;
}): TelemetryRecord {
  return {
    ts: input.ts,
    pid: input.pid,
    status: null,
    retryAfterMs: null,
    rateLimit: null,
    contextTokens: null,
    provider: input.provider,
    model: input.model,
    intent: true,
    intentId: input.intentId,
    estimatedCost: input.estimatedCost,
  };
}

/** Compose one log line from a provider response. Pure, so it is testable. */
export function buildRecord(input: {
  ts: number;
  pid: number;
  status: number | null;
  headers: Record<string, unknown>;
  contextTokens: number | null;
  model: unknown;
}): TelemetryRecord {
  const attribution = describeModel(input.model);
  return {
    ts: input.ts,
    pid: input.pid,
    status: input.status,
    retryAfterMs: parseRetryAfterMs(input.headers["retry-after"]),
    rateLimit: extractRateLimitHeaders(input.headers),
    contextTokens: input.contextTokens,
    provider: attribution.provider,
    model: attribution.model,
  };
}

function readNonBlankString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The model's output ceiling, when the catalog declares one. */
function readModelMaxTokens(model: unknown): number | null {
  if (!model || typeof model !== "object") {
    return null;
  }
  const value = (model as Record<string, unknown>).maxTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Hold for `ms`, returning early if the agent aborts.
 *
 * An uninterruptible hold would make Ctrl-C appear to hang for up to a
 * minute, so the abort signal must cut it short.
 */
function hold(ms: number, signal: MinimalExtensionContext["signal"]): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      try {
        (signal?.removeEventListener as ((t: string, l: unknown) => void) | undefined)?.(
          "abort",
          finish,
        );
      } catch {
        // Detaching is best-effort.
      }
      resolve();
    };
    if (signal?.aborted) {
      resolve();
      return;
    }
    timer = setTimeout(finish, ms);
    try {
      (signal?.addEventListener as ((t: string, l: unknown, o?: unknown) => void) | undefined)?.(
        "abort",
        finish,
        { once: true },
      );
    } catch {
      // Without a usable signal the timer still expires on its own.
    }
  });
}

function readContextTokens(ctx: MinimalExtensionContext): number | null {
  try {
    const usage = ctx.getContextUsage?.();
    return typeof usage?.tokens === "number" ? usage.tokens : null;
  } catch {
    return null;
  }
}

function updateStatus(ctx: MinimalExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }
  try {
    ctx.ui?.setStatus?.(
      "tpm",
      `tpm: ${sessionRateLimited} 429/${sessionRequests} req` +
        (lastRetryAfterMs !== null ? `, wait ${Math.round(lastRetryAfterMs / 1000)}s` : ""),
    );
  } catch {
    // UI is best-effort.
  }
}

export default function tpmTelemetry(pi: MinimalExtensionApi): void {
  let pruned = false;
  pi.on("session_start", async () => {
    if (!pruned) {
      pruneOldFiles();
      pruned = true;
    }
  });

  // Pre-send governor. The handler is awaited inside Pi's request path, so
  // holding here delays the outbound request. The payload is returned
  // untouched: this throttles, it never rewrites what the agent asked for.
  pi.on("before_provider_request", async (_event, ctx) => {
    if (!GOVERNOR_ENABLED) {
      return;
    }
    try {
      const provider = describeModel(ctx.model).provider;
      if (!provider) {
        return;
      }
      const now = Date.now();
      const records = readRecentRecords(now);
      const limits: GovernorLimits = {
        limit: readReportedLimit(records, provider, now) ?? GOVERNOR_FALLBACK_LIMIT,
        reserve: GOVERNOR_RESERVE,
        maxWaitMs: GOVERNOR_MAX_WAIT_MS,
      };
      const cost = estimateCost({
        contextTokens: readContextTokens(ctx),
        maxTokens: readModelMaxTokens(ctx.model),
        policy: GOVERNOR_POLICY,
        outputEstimate: GOVERNOR_OUTPUT_ESTIMATE,
      });
      const waitMs = decideWait(
        estimateBucket(records, now, limits, provider),
        cost,
        limits,
      );

      // Claim the budget before holding, not after, so siblings deciding
      // during our wait can see this request. This is what closes the race
      // where concurrent processes each read a budget none has spent yet.
      if (cost > 0) {
        pendingIntentId = `${process.pid}-${(intentCounter += 1)}-${now}`;
        appendRecord(
          buildIntentRecord({
            ts: now,
            pid: process.pid,
            provider,
            model: describeModel(ctx.model).model,
            estimatedCost: cost,
            intentId: pendingIntentId,
          }),
        );
      }

      if (waitMs > 0) {
        sessionHolds += 1;
        sessionHeldMs += waitMs;
        try {
          ctx.ui?.setStatus?.(
            "tpm",
            `tpm: holding ${Math.round(waitMs / 1000)}s for budget`,
          );
        } catch {
          // UI is best-effort.
        }
        await hold(waitMs, ctx.signal);
        updateStatus(ctx);
      }
    } catch {
      // Never break the request path because throttling failed.
    }
  });

  pi.on("after_provider_response", (rawEvent, ctx) => {
    const event = rawEvent as {
      status?: unknown;
      headers?: unknown;
    };
    const status = typeof event.status === "number" ? event.status : null;
    const headers =
      event.headers && typeof event.headers === "object"
        ? (event.headers as Record<string, unknown>)
        : {};
    const record = buildRecord({
      ts: Date.now(),
      pid: process.pid,
      status,
      headers,
      contextTokens: readContextTokens(ctx),
      model: ctx.model,
    });
    // Settle this request's claim so the estimate counts it once, by its
    // real cost, rather than twice.
    if (pendingIntentId !== null) {
      record.intentId = pendingIntentId;
      pendingIntentId = null;
    }

    sessionRequests += 1;
    if (status === 429) {
      sessionRateLimited += 1;
      lastRetryAfterMs = record.retryAfterMs;
      if (record.rateLimit) {
        lastRateLimit = record.rateLimit;
      }
    }
    lastContextTokens = record.contextTokens;

    appendRecord(record);
    updateStatus(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    lastContextTokens = readContextTokens(ctx);
    updateStatus(ctx);
  });

  pi.registerCommand("tpm", {
    description: "Show rate-limit telemetry: session 429s, rolling usage, and guidance.",
    handler(_args, ctx) {
      const now = Date.now();
      const recent = readRecentRecords(now);
      const processIds = new Set(recent.map((record) => record.pid));
      const tokenSum = recent.reduce(
        (sum, record) => sum + (record.contextTokens ?? 0),
        0,
      );
      const recent429s = recent.filter((record) => record.status === 429).length;

      const lines = [
        `TPM telemetry (pid ${process.pid})`,
        `  session: ${sessionRequests} requests, ${sessionRateLimited} rate-limited`,
        `  last 60s: ${recent.length} requests, ~${formatTokens(tokenSum)} context tokens, ${processIds.size} process(es), ${recent429s} rate-limited`,
      ];
      if (lastRetryAfterMs !== null) {
        lines.push(`  last 429 retry-after: ${Math.round(lastRetryAfterMs / 1000)}s`);
      }
      if (lastRateLimit) {
        lines.push(
          `  rate-limit headers: ${Object.entries(lastRateLimit)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}`,
        );
      }
      const currentTokens = readContextTokens(ctx) ?? lastContextTokens;
      if (currentTokens !== null) {
        lines.push(`  context: ~${formatTokens(currentTokens)} tokens`);
      }
      if (GOVERNOR_ENABLED) {
        const provider = describeModel(ctx.model).provider;
        const limit = readReportedLimit(recent, provider, now) ?? GOVERNOR_FALLBACK_LIMIT;
        const level = estimateBucket(
          recent,
          now,
          { limit, reserve: GOVERNOR_RESERVE, maxWaitMs: GOVERNOR_MAX_WAIT_MS },
          provider,
        );
        lines.push(
          `  governor: on (${GOVERNOR_POLICY}), ~${formatTokens(level)} of ` +
            `${formatTokens(limit)} budget left for ${provider ?? "unknown"}`,
        );
        lines.push(
          `  holds: ${sessionHolds} this session, ${Math.round(sessionHeldMs / 1000)}s total`,
        );
      } else {
        lines.push("  governor: off (PI_TPM_GOVERNOR=0)");
      }
      lines.push(
        "  guidance: honor retry-after before retrying; reduce parallel subagents or",
        "  run /compact before large turns when the budget is contended.",
      );

      for (const line of lines) {
        try {
          ctx.ui?.notify?.(line);
        } catch {
          // Non-TUI modes skip notifications.
        }
      }
      return lines.join("\n");
    },
  });
}
