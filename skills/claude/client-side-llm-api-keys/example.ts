/**
 * Client-side BYO-key LLM client — adapters + llmGenerate + key store.
 *
 * Self-contained and framework-agnostic: copy into a browser/SPA app, rename the
 * STORAGE_PREFIX, and call `llmGenerate({ prompt, json: true })`. The browser calls
 * each provider directly via fetch; the key the user pastes is sent ONLY to the chosen
 * provider. Containment for that key is the deploy CSP `connect-src` allowlist (these
 * four hosts only) — set it in prod (nginx/_headers) AND dev (Vite server.headers).
 *
 * Pairs with SKILL.md: client-side-llm-api-keys.
 */

const STORAGE_PREFIX = "app"; // rename per project, e.g. "neural-refresh" / "orintu"
const KEYS_STORAGE = `${STORAGE_PREFIX}:llm-keys`;
const SELECTION_STORAGE = `${STORAGE_PREFIX}:llm-selection`;
const REMEMBER_STORAGE = `${STORAGE_PREFIX}:llm-remember`;

// ── Provider interface + adapters ────────────────────────────────────────────
export type LlmModel = { id: string; label: string };
export type BuildArgs = { model: string; apiKey: string; prompt: string; temperature: number; maxTokens: number; json: boolean };
export type BuiltRequest = { url: string; headers: Record<string, string>; body: unknown };
export type LlmProvider = {
  id: string;
  label: string;
  keyUrl: string; // where the user gets a key
  defaultModel: string;
  models: LlmModel[];
  buildRequest(a: BuildArgs): BuiltRequest;
  extractText(json: unknown, opts?: { json?: boolean }): string;
};

const anthropic: LlmProvider = {
  id: "anthropic",
  label: "Anthropic",
  keyUrl: "https://console.anthropic.com/settings/keys",
  defaultModel: "claude-haiku-4-5-20251001",
  models: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast, cheap)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 (most capable)" },
  ],
  buildRequest({ model, apiKey, prompt, temperature, maxTokens, json }) {
    const messages: Array<{ role: string; content: string }> = [{ role: "user", content: prompt }];
    // Anthropic has no native JSON flag: prefill the assistant turn with '{' so the
    // model continues the object; extractText re-prepends the stripped brace.
    if (json) messages.push({ role: "assistant", content: "{" });
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true", // required for browser calls
      },
      body: { model, max_tokens: maxTokens, temperature, messages },
    };
  },
  extractText(json, opts) {
    const j = json as { content?: Array<{ type: string; text?: string }> };
    if (!Array.isArray(j?.content)) return "";
    const text = j.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return opts?.json ? `{${text}` : text;
  },
};

function openaiCompatible(id: string, label: string, base: string, keyUrl: string, defaultModel: string, models: LlmModel[]): LlmProvider {
  return {
    id,
    label,
    keyUrl,
    defaultModel,
    models,
    buildRequest({ model, apiKey, prompt, temperature, maxTokens, json }) {
      const body: Record<string, unknown> = { model, messages: [{ role: "user", content: prompt }], temperature, max_tokens: maxTokens };
      if (json) body.response_format = { type: "json_object" };
      return { url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body };
    },
    extractText(json) {
      return (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "";
    },
  };
}

const openai = openaiCompatible("openai", "OpenAI", "https://api.openai.com/v1", "https://platform.openai.com/api-keys", "gpt-4o-mini", [
  { id: "gpt-4o-mini", label: "GPT-4o mini (cheap)" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
]);

const deepseek = openaiCompatible("deepseek", "DeepSeek", "https://api.deepseek.com", "https://platform.deepseek.com/api_keys", "deepseek-v4-flash", [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (cheap)" },
]);

const gemini: LlmProvider = {
  id: "gemini",
  label: "Google",
  keyUrl: "https://aistudio.google.com/app/apikey",
  defaultModel: "gemini-2.5-flash",
  models: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (cheap)" }],
  buildRequest({ model, apiKey, prompt, temperature, maxTokens, json }) {
    const generationConfig: Record<string, unknown> = { temperature, maxOutputTokens: maxTokens };
    if (json) generationConfig.responseMimeType = "application/json";
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: { contents: [{ parts: [{ text: prompt }] }], generationConfig },
    };
  },
  extractText(json) {
    return (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  },
};

export const PROVIDERS: LlmProvider[] = [anthropic, gemini, openai, deepseek];
export const DEFAULT_PROVIDER_ID = "anthropic";
export const getProvider = (id: string): LlmProvider => PROVIDERS.find((p) => p.id === id) ?? anthropic;
// The exact hosts the deploy CSP `connect-src` must allowlist:
export const PROVIDER_API_HOSTS = ["https://api.anthropic.com", "https://generativelanguage.googleapis.com", "https://api.openai.com", "https://api.deepseek.com"];

// ── Key store: sessionStorage by default; opt-in localStorage ─────────────────
export const getRememberKeys = (): boolean => {
  try { return localStorage.getItem(REMEMBER_STORAGE) === "true"; } catch { return false; }
};
const keyStore = (): Storage => (getRememberKeys() ? localStorage : sessionStorage);
export const loadKeys = (): Record<string, string> => {
  try { return JSON.parse(keyStore().getItem(KEYS_STORAGE) || "{}") as Record<string, string>; } catch { return {}; }
};
export const getKey = (providerId: string): string => loadKeys()[providerId] || "";
export const setKey = (providerId: string, key: string): void => {
  const keys = loadKeys();
  if (key) keys[providerId] = key; else delete keys[providerId];
  try { keyStore().setItem(KEYS_STORAGE, JSON.stringify(keys)); } catch { /* in-memory only */ }
};
// Migrate keys to the new store and purge the old one so a key never lingers.
export const setRememberKeys = (remember: boolean): void => {
  const current = loadKeys();
  const from = keyStore();
  try { localStorage.setItem(REMEMBER_STORAGE, remember ? "true" : "false"); } catch { /* ignore */ }
  const to = keyStore();
  if (from !== to) {
    try { to.setItem(KEYS_STORAGE, JSON.stringify(current)); } catch { /* ignore */ }
    try { from.removeItem(KEYS_STORAGE); } catch { /* ignore */ }
  }
};

// Provider/model selection is non-secret → always localStorage.
export type LlmSelection = { providerId: string; model: string };
export const loadSelection = (): LlmSelection => {
  let saved: Partial<LlmSelection> = {};
  try { saved = JSON.parse(localStorage.getItem(SELECTION_STORAGE) || "{}") as Partial<LlmSelection>; } catch { /* ignore */ }
  const provider = getProvider(saved.providerId || DEFAULT_PROVIDER_ID);
  const model = provider.models.some((m) => m.id === saved.model) ? (saved.model as string) : provider.defaultModel;
  return { providerId: provider.id, model };
};
export const saveSelection = (s: LlmSelection): void => {
  try { localStorage.setItem(SELECTION_STORAGE, JSON.stringify(s)); } catch { /* ignore */ }
};

// ── Core call: normalised, with 429 backoff ──────────────────────────────────
export type LlmResponse = { ok: boolean; status: number; statusText: string; text: string; raw: unknown };
export const llmGenerate = async (opts: {
  providerId?: string; model?: string; apiKey?: string; prompt: string;
  temperature?: number; maxTokens?: number; retries?: number; json?: boolean;
}): Promise<LlmResponse> => {
  const { prompt, temperature = 0.7, maxTokens = 2000, retries = 2, json = false } = opts;
  const sel = loadSelection();
  const provider = getProvider(opts.providerId || sel.providerId);
  const model = opts.model || (provider.models.some((m) => m.id === sel.model) ? sel.model : provider.defaultModel);
  const apiKey = opts.apiKey || getKey(provider.id);
  if (!apiKey) return { ok: false, status: 0, statusText: "No API key", text: "", raw: null };

  const { url, headers, body } = provider.buildRequest({ model, apiKey, prompt, temperature, maxTokens, json });
  let res: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10000)));
      continue;
    }
    break;
  }
  const response = res as Response;
  let raw: unknown = null;
  let text = "";
  if (response.ok) {
    try { raw = await response.json(); text = provider.extractText(raw, { json }); } catch { /* leave empty */ }
  }
  return { ok: response.ok, status: response.status, statusText: response.statusText, text, raw };
};
