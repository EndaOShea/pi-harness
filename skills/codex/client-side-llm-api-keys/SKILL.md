---
name: client-side-llm-api-keys
description: Use when a browser or static-site app must call an LLM provider (Anthropic, OpenAI, Gemini, DeepSeek) directly from the client with a user-supplied (BYO) API key and no backend — deciding where the key lives (never a server .env), how to store it (sessionStorage vs localStorage), how to call providers directly from the browser (CORS, anthropic-dangerous-direct-browser-access), and how to contain a browser-held key with a CSP connect-src allowlist.
---

# Client-side LLM API keys (BYO-key)

## Overview

When each user brings their own LLM key and there is no backend, the key lives **only in the browser** and is sent **only** to the provider's API, directly via `fetch`. The security model is two moves: **minimise where the key is stored**, and **contain where it can be sent** with a CSP `connect-src` allowlist. No server, no `.env`, no proxy.

## When to use

- Static site / SPA with **per-user** keys and no backend you control.
- Users supply their own provider key (you do not ship a shared org key).

**When NOT to use** — if you need a single org-owned key hidden from users, server-side rate limiting, or billing, run a backend proxy and keep the key server-side instead. This pattern is BYO-key only.

## Architecture (4 parts — see `example.ts`)

1. **Provider adapters** — one object per provider exposing `buildRequest()→{url,headers,body}` + `extractText(json)`. Raw `fetch`, **no SDKs** (smaller bundle, uniform interface, no `dangerouslyAllowBrowser`).
2. **`llmGenerate()`** — normalises every provider to `{ ok, status, text, raw }`; retries 429 with backoff; returns `ok:false` (no network) when no key is set.
3. **Key store** — per-provider keys in **`sessionStorage` by default** (wiped on tab close); opt-in `localStorage` via a "Remember on this device" toggle that **migrates and purges** on switch. Persist the (non-secret) provider/model selection separately in `localStorage`.
4. **Settings UI** — provider + model picker, password key input, remember toggle, "Get a key" link, and **low-spend-key** guidance.

## Provider quick reference

| Provider | Endpoint | Auth | Native JSON | Browser-callable |
|---|---|---|---|---|
| Anthropic | `api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version` | prefill assistant turn with `{`, re-prepend in `extractText` | **yes** — add header `anthropic-dangerous-direct-browser-access: true` |
| OpenAI | `api.openai.com/v1/chat/completions` | `Authorization: Bearer` | `response_format:{type:"json_object"}` | yes (CORS; may be network-blocked) |
| Gemini | `generativelanguage.googleapis.com/.../:generateContent` | `x-goog-api-key` | `generationConfig.responseMimeType:"application/json"` | yes |
| DeepSeek | `api.deepseek.com/chat/completions` | `Authorization: Bearer` | OpenAI-compatible | yes (CORS) |

## Security model — the point of this skill

1. **No server custody.** The key goes browser→provider only; never a `.env`, a server, or git. Say so in `.env.example`.
2. **Storage minimisation.** `sessionStorage` by default; `localStorage` only on explicit opt-in, with migrate-and-purge when toggled off.
3. **CSP `connect-src` allowlist = the load-bearing control.** Allow **only** the provider hosts. Then even under XSS a stolen key cannot be POSTed anywhere else. Pair with `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`. Set it in **prod** (nginx `add_header`, or a `_headers` file) **and dev** (Vite `server.headers`) so CSP breakage surfaces early. The dev policy is looser (`'unsafe-inline' 'unsafe-eval' ws: wss:` for HMR) but keeps the same `connect-src`.
4. **Escape/sanitise all LLM output before rendering.** Model output is untrusted input — the main XSS vector. Framework auto-escaping covers plain text; use **DOMPurify (strict allowlist)** if you render HTML/markdown.
5. **TLS + HSTS** at the edge.
6. **Tell users to use a restricted, low-spend key** — it runs client-side with whatever scope it is granted.

## Common mistakes

- Key in `VITE_*` / build-time env → baked into the shipped bundle, shared across all users. Never.
- Exposing the key client-side **without** the CSP `connect-src` allowlist → one XSS exfiltrates it to any host.
- Defaulting to `localStorage` → key persists on shared machines. Default to `sessionStorage`.
- Reaching for a provider SDK in the browser → bloat + `dangerouslyAllowBrowser`. A raw-`fetch` adapter is smaller and uniform.
- Rendering model output via `innerHTML` / `dangerouslySetInnerHTML` unsanitised.

## Reference implementations

- **Neural Refresh** (`bitbucket.org/endao3/llms-cs-trivia-game`) — `src/services/llm/{providers.js,index.js}`, dev CSP in `vite.config.js`, edge vhost in `deploy/neural-refresh.conf`.
- **Orintu** — `app/src/llm/{providers.ts,index.ts,LlmSettings.tsx}`, prod CSP in `deploy/nginx/app.conf`, dev CSP in `app/vite.config.ts`.
- **Adaptable starting point:** `example.ts` in this skill (adapters + `llmGenerate` + key store, self-contained).
