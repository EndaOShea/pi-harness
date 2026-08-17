/**
 * Discover locally running OpenAI-compatible model servers (Ollama, LM
 * Studio) at session start and register their models with Pi.
 *
 * llama.cpp is intentionally absent: Pi supports its router natively via
 * /login llama.cpp and /llama (see docs/CAPABILITIES.md).
 *
 * A server that is not running, hangs past the probe timeout, or returns
 * an unusable payload is silently skipped — an absent provider in /model
 * is the signal. Endpoints beyond the localhost defaults come only from
 * environment variables, never from files in this repository.
 */

export interface LocalProviderTarget {
  providerId: string;
  displayName: string;
  defaultBaseUrl: string;
  envVar: string;
}

export const LOCAL_PROVIDER_TARGETS: LocalProviderTarget[] = [
  {
    providerId: "ollama",
    displayName: "Ollama (local)",
    defaultBaseUrl: "http://127.0.0.1:11434",
    envVar: "OLLAMA_HOST",
  },
  {
    providerId: "lmstudio",
    displayName: "LM Studio (local)",
    defaultBaseUrl: "http://127.0.0.1:1234",
    envVar: "LMSTUDIO_BASE_URL",
  },
];

const PROBE_TIMEOUT_MS = 500;
const REASONING_ID_PATTERN = /qwen3|gpt-oss|deepseek-r1|thinking/i;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_MODELS = 200;
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/g;

export interface DiscoveredModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Conservative context window used when a model's real window cannot be
 * discovered. Registration requires *some* `contextWindow` (ordinary chat
 * must keep working), but this value is never treated as a verified window
 * by consumers deciding whether context-pressure features may arm.
 */
export const PLACEHOLDER_CONTEXT_WINDOW = 32768;

function toPositiveFiniteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * True if `response` declares a `content-length` over `MAX_RESPONSE_BYTES`.
 * A response with no (or non-numeric) `content-length` header is treated
 * as within bounds — there is nothing to compare against — matching the
 * pre-existing permissiveness of this check.
 */
function exceedsMaxResponseBytes(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) {
    return false;
  }
  const declaredSize = Number(contentLength);
  return Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES;
}

/** True when two Ollama model references name the same model. Ollama
 *  normalizes a tagless name to `:latest`, and the two endpoints compared
 *  here do not always agree on whether the tag is spelled out. */
function ollamaNamesMatch(a: string, b: string): boolean {
  const normalize = (name: string): string =>
    name.includes(":") ? name : `${name}:latest`;
  return normalize(a) === normalize(b);
}

/**
 * Pure: Ollama `/api/ps` payload + model id → the **loaded runtime** context
 * length, or undefined.
 *
 * Deliberately not `/api/show`. That endpoint reports GGUF metadata — the
 * length the model was *trained* for (`model_info["<arch>.context_length"]`,
 * e.g. 40960 for a qwen3) — which is not what the server honors for a
 * request. The honored window is `num_ctx`, which defaults to 4096 (or
 * `OLLAMA_CONTEXT_LENGTH`) and is usually far smaller. Reporting the
 * architectural maximum as "verified" would arm the context handoff against
 * a window roughly 10x too large, which is exactly the wrong-number failure
 * the verified-window rule exists to prevent.
 *
 * Fields read, so a future reader can correct them against a live server:
 *   - the model list lives at `payload.models` (an array);
 *   - an entry is matched on its `model` or `name` field;
 *   - the runtime window is read from the entry's `context_length`, falling
 *     back to `num_ctx`. Both are Ollama's own names for the loaded window;
 *     neither is the architectural maximum.
 *
 * A model that is not currently loaded has no entry in `/api/ps`, and an
 * entry carrying no usable value is treated the same way: undefined. Callers
 * must read undefined as "unverified" and disarm, never as a cue to fall
 * back to some other number.
 */
export function extractOllamaLoadedContextLength(
  payload: unknown,
  modelId: string,
): number | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return undefined;
  }
  const entry = models.find((item) => {
    if (item === null || typeof item !== "object") {
      return false;
    }
    const record = item as { model?: unknown; name?: unknown };
    return (
      (typeof record.model === "string" && ollamaNamesMatch(record.model, modelId)) ||
      (typeof record.name === "string" && ollamaNamesMatch(record.name, modelId))
    );
  }) as { context_length?: unknown; num_ctx?: unknown } | undefined;
  if (!entry) {
    return undefined;
  }
  return (
    toPositiveFiniteInt(entry.context_length) ?? toPositiveFiniteInt(entry.num_ctx)
  );
}

/**
 * Pure: LM Studio `/api/v0/models` payload + model id → context length or
 * undefined.
 *
 * `loaded_context_length` wins over `max_context_length` when both are
 * present and valid, because the loaded value is what the server will
 * actually honor for a request.
 */
export function extractLmStudioContextLength(
  payload: unknown,
  modelId: string,
): number | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const entry = data.find(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (item as { id?: unknown }).id === modelId,
  ) as { loaded_context_length?: unknown; max_context_length?: unknown } | undefined;
  if (!entry) {
    return undefined;
  }
  return (
    toPositiveFiniteInt(entry.loaded_context_length) ??
    toPositiveFiniteInt(entry.max_context_length)
  );
}

/** Pure: dispatch a provider's context-length payload to its parser. Any
 *  provider without one — or any payload shape neither parser recognises —
 *  yields undefined, which every caller must read as "unverified". */
export function extractContextLength(
  providerId: string,
  payload: unknown,
  modelId: string,
): number | undefined {
  if (providerId === "ollama") {
    return extractOllamaLoadedContextLength(payload, modelId);
  }
  if (providerId === "lmstudio") {
    return extractLmStudioContextLength(payload, modelId);
  }
  return undefined;
}

/**
 * Impure: fetch the payload the context-length parsers read; undefined on
 * any failure.
 *
 * One request covers every model on the server — Ollama's `/api/ps` lists
 * all loaded models and LM Studio's `/api/v0/models` lists all of its own —
 * so callers registering many models fetch this once, not once per model.
 *
 * `baseUrl` has no trailing `/v1` (both endpoints are siblings of `/v1`, not
 * children of it). Bounded by the same `PROBE_TIMEOUT_MS` used for model
 * discovery; any timeout, non-ok response, or oversized body silently yields
 * undefined.
 */
export async function fetchContextLengthSource(
  providerId: string,
  baseUrl: string,
): Promise<unknown | undefined> {
  const path =
    providerId === "ollama"
      ? "/api/ps"
      : providerId === "lmstudio"
        ? "/api/v0/models"
        : undefined;
  if (path === undefined) {
    return undefined;
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok || exceedsMaxResponseBytes(response)) {
      return undefined;
    }
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Impure: probe one model's honored context length; undefined on any
 * failure. `source` lets a caller that already fetched the provider's
 * payload reuse it instead of paying a second round trip.
 */
export async function probeContextLength(
  providerId: string,
  baseUrl: string,
  modelId: string,
  source?: unknown,
): Promise<number | undefined> {
  const payload =
    source !== undefined ? source : await fetchContextLengthSource(providerId, baseUrl);
  if (payload === undefined) {
    return undefined;
  }
  return extractContextLength(providerId, payload, modelId);
}

/**
 * Accepts `host:port` or a full URL; strips trailing slashes and `/v1`.
 *
 * A bare host with no explicit port (e.g. `localhost`, as accepted by
 * Ollama) would otherwise resolve to port 80 and silently fail discovery,
 * so an unspecified port is defaulted from the fallback URL's port.
 */
export function normalizeBaseUrl(
  raw: string | undefined,
  fallback: string,
): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return fallback;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  const stripped = withScheme.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const url = new URL(stripped);
    if (url.port === "") {
      const fallbackUrl = new URL(fallback);
      if (fallbackUrl.port !== "") {
        url.port = fallbackUrl.port;
        return url.toString().replace(/\/+$/, "");
      }
    }
  } catch {
    return stripped;
  }
  return stripped;
}

/** Pure mapping from a /v1/models `data` payload to Pi model configs. */
export function mapDiscoveredModels(
  payloadData: unknown,
): DiscoveredModelConfig[] {
  if (!Array.isArray(payloadData)) {
    return [];
  }
  const models: DiscoveredModelConfig[] = [];
  const seen = new Set<string>();
  for (const entry of payloadData) {
    if (models.length >= MAX_MODELS) {
      break;
    }
    const rawId =
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
        ? ((entry as { id: string }).id ?? "").trim()
        : "";
    const id = rawId.replace(CONTROL_CHARS_PATTERN, "");
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      id,
      name: id,
      reasoning: REASONING_ID_PATTERN.test(id),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: PLACEHOLDER_CONTEXT_WINDOW,
      maxTokens: 4096,
    });
  }
  return models;
}

async function probeModels(baseUrl: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok || exceedsMaxResponseBytes(response)) {
      return undefined;
    }
    const payload = (await response.json()) as { data?: unknown };
    return payload?.data;
  } catch {
    return undefined;
  }
}

interface MinimalExtensionApi {
  registerProvider(providerId: string, config: object): void;
}

/**
 * Discovers models, then attempts to replace each one's placeholder
 * `contextWindow` with its real value. The context-length payload is
 * fetched once per provider and parsed per model, so this adds at most one
 * further `PROBE_TIMEOUT_MS` to discovery latency regardless of how many
 * models a server reports. A model with no usable value in that payload —
 * for Ollama, any model that is not currently loaded — keeps the
 * placeholder, and consumers deciding whether to arm a context-pressure
 * feature must not treat a placeholder as verified.
 */
export default async function localModels(
  pi: MinimalExtensionApi,
): Promise<void> {
  await Promise.all(
    LOCAL_PROVIDER_TARGETS.map(async (target) => {
      const baseUrl = normalizeBaseUrl(
        process.env[target.envVar],
        target.defaultBaseUrl,
      );
      const models = mapDiscoveredModels(await probeModels(baseUrl));
      if (models.length === 0) {
        return;
      }
      const contextSource = await fetchContextLengthSource(
        target.providerId,
        baseUrl,
      );
      if (contextSource !== undefined) {
        for (const model of models) {
          const contextLength = extractContextLength(
            target.providerId,
            contextSource,
            model.id,
          );
          if (contextLength !== undefined) {
            model.contextWindow = contextLength;
          }
        }
      }
      try {
        pi.registerProvider(target.providerId, {
          name: target.displayName,
          baseUrl: `${baseUrl}/v1`,
          apiKey: "local",
          api: "openai-completions",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models,
        });
      } catch {
        // Silent-failure contract: a misbehaving registration must not
        // block discovery of other providers or reject the factory.
      }
    }),
  );
}
