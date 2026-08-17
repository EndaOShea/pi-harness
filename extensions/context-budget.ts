/**
 * Harness context-budget guard.
 *
 * Trims oversized exploration output before it reaches the model. Pi's own
 * per-result cap is 50KB (roughly 12000 tokens); a review agent doing 39
 * tool calls can reach 90000 tokens of context on that budget alone, and on
 * a 200000 tokens-per-minute provider limit a 90000-token request costs
 * nearly half the minute. Bounding what enters context is the cheapest lever
 * on tokens-per-minute pressure, because input is almost the entire cost of
 * an agent request.
 *
 * Head and tail are both preserved. The head shows what ran; errors, exit
 * status and summaries live at the end, so a head-only trim discards the
 * half that usually decides the next step. The trim is always announced in
 * the text, never silent, so the agent can narrow its query rather than
 * assume it saw everything.
 *
 * Only exploration tools are trimmed (see TRIMMED_TOOLS). `read` is
 * deliberately excluded: an agent that edits a file it only partially saw
 * writes broken code, which is worse than a large context.
 *
 * Disable with PI_TOOL_OUTPUT_MAX_BYTES=0. All handling is exception-wrapped
 * and returns the result unmodified on any failure.
 *
 * Deliberately no dependency on the Pi package types, so this file stays
 * parseable by the repository's validation without an installed runtime
 * (same convention as local-models.ts and tpm-telemetry.ts).
 */

/** Tools whose output is exploratory and safe to trim. */
export const TRIMMED_TOOLS = ["bash", "grep", "find", "ls"];

/**
 * Providers whose tokens-per-minute budget makes context growth expensive.
 *
 * Trimming is a rate-limit remedy, not a general improvement: it costs the
 * agent visibility. Applying it to a provider with abundant throughput pays
 * that cost for nothing, so an unlisted or unknown provider is left alone.
 * Override with PI_TOOL_OUTPUT_TRIM_PROVIDERS as a comma-separated list.
 */
const DEFAULT_TRIMMED_PROVIDERS = "openai,openai-codex";

const DEFAULT_MAX_BYTES = 10_240;

function readEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const MAX_BYTES = readEnvInt("PI_TOOL_OUTPUT_MAX_BYTES", DEFAULT_MAX_BYTES);
const TRIMMED_PROVIDERS = new Set(
  (process.env.PI_TOOL_OUTPUT_TRIM_PROVIDERS ?? DEFAULT_TRIMMED_PROVIDERS)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0),
);

/** The active provider, read defensively; null when there is no model. */
function activeProvider(ctx: unknown): string | null {
  const model = (ctx as { model?: unknown } | undefined)?.model;
  if (!model || typeof model !== "object") {
    return null;
  }
  const provider = (model as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.trim() ? provider.trim() : null;
}
/** Share of the budget given to the head; the rest keeps the tail. */
const HEAD_SHARE = 0.6;
/**
 * Headroom for UTF-8 replacement characters.
 *
 * Cutting at a byte offset can split a multi-byte character, and decoding
 * the fragment yields U+FFFD — three bytes where one or two stood. Two cut
 * points can therefore grow the result by a few bytes, which would breach a
 * budget computed exactly.
 */
const REPLACEMENT_CHAR_SLACK = 8;

interface TextBlock {
  type: "text";
  text: string;
}

type ContentBlock = TextBlock | { type: string; [key: string]: unknown };

function isTextBlock(block: unknown): block is TextBlock {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Trim a tool result's text to `maxBytes`, keeping both ends.
 *
 * Returns null when nothing should change — small output, a disabled
 * budget, or anything malformed — so callers can leave the result alone
 * rather than replace it with a reconstruction.
 */
export function trimToolContent(
  content: unknown,
  options: { maxBytes: number },
): ContentBlock[] | null {
  const maxBytes = options.maxBytes;
  if (!Array.isArray(content) || content.length === 0 || maxBytes <= 0) {
    return null;
  }

  const textBlocks = content.filter(isTextBlock);
  const total = textBlocks.reduce((sum, block) => sum + byteLength(block.text), 0);
  if (total <= maxBytes) {
    return null;
  }

  // The notice is part of what the model receives, so it comes out of the
  // budget rather than being added on top; otherwise maxBytes is advisory.
  // Reserve against the worst case (dropped === total) so the final notice,
  // which is never longer, always fits what was set aside.
  const makeNotice = (dropped: number) =>
    `\n\n[harness: trimmed ${dropped} bytes of ${total} to protect the ` +
    `context budget. Narrow the query to see the middle.]\n\n`;
  const available = Math.max(
    0,
    maxBytes - byteLength(makeNotice(total)) - REPLACEMENT_CHAR_SLACK,
  );
  const headBytes = Math.floor(available * HEAD_SHARE);
  const tailBytes = available - headBytes;
  const notice = makeNotice(total - headBytes - tailBytes);

  // Walk the blocks in order, carrying a cursor over the concatenated text,
  // so a text block that followed an image still follows it. Flattening all
  // text into one leading block would change what a multimodal result means.
  const trimmed: ContentBlock[] = [];
  const tailStart = total - tailBytes;
  let cursor = 0;
  let noticePlaced = false;
  for (const block of content) {
    if (!isTextBlock(block)) {
      trimmed.push(block as ContentBlock);
      continue;
    }
    const buffer = Buffer.from(block.text, "utf8");
    const start = cursor;
    const end = start + buffer.length;
    cursor = end;

    let text = sliceOverlap(buffer, start, 0, headBytes);
    if (!noticePlaced && end > headBytes) {
      text += notice;
      noticePlaced = true;
    }
    text += sliceOverlap(buffer, start, tailStart, total);
    if (text.length > 0) {
      trimmed.push({ type: "text", text });
    }
  }
  if (!noticePlaced) {
    trimmed.push({ type: "text", text: notice });
  }
  return trimmed;
}

/**
 * The bytes of `buffer` that fall inside [rangeStart, rangeEnd) of the
 * concatenated text, where `buffer` begins at `blockStart`.
 */
function sliceOverlap(
  buffer: Buffer,
  blockStart: number,
  rangeStart: number,
  rangeEnd: number,
): string {
  const from = Math.max(rangeStart - blockStart, 0);
  const to = Math.min(rangeEnd - blockStart, buffer.length);
  return to > from ? buffer.subarray(from, to).toString("utf8") : "";
}

interface MinimalExtensionApi {
  on(
    event: string,
    handler: (event: unknown, ctx: unknown) => unknown,
  ): void;
}

export default function contextBudget(pi: MinimalExtensionApi): void {
  pi.on("tool_result", (rawEvent, ctx) => {
    try {
      const event = rawEvent as { toolName?: unknown; content?: unknown };
      if (typeof event.toolName !== "string" || !TRIMMED_TOOLS.includes(event.toolName)) {
        return undefined;
      }
      const provider = activeProvider(ctx);
      if (provider === null || !TRIMMED_PROVIDERS.has(provider)) {
        return undefined;
      }
      const trimmed = trimToolContent(event.content, { maxBytes: MAX_BYTES });
      return trimmed ? { content: trimmed } : undefined;
    } catch {
      // A guard that breaks tool results is worse than a large context.
      return undefined;
    }
  });
}
