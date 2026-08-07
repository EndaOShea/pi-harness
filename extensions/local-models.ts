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

export interface DiscoveredModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** Accepts `host:port` or a full URL; strips trailing slashes and `/v1`. */
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
  return withScheme.replace(/\/+$/, "").replace(/\/v1$/, "");
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
    const id =
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
        ? ((entry as { id: string }).id ?? "").trim()
        : "";
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
      contextWindow: 32768,
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
    if (!response.ok) {
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
    }),
  );
}
