/**
 * Pair a local-model session (e.g. Qwen) with a frontier model acting as
 * reviewer or orchestrator, by editing `~/.pi/agent/settings.json` — the
 * file pi-subagents reads.
 *
 * Every pairing is applied as a plan: the exact prior value of each
 * settings key it touches is recorded in a marker at
 * `settings.pair.pairActive` before the key is changed. Turning pairing
 * off replays that marker to restore each key to its recorded prior value
 * (or removes it, if it did not exist before) and then removes the
 * marker itself. This makes every pairing perfectly reversible without
 * needing to know what else might have modified settings.json in between.
 *
 * The settings-planning and model-resolution sections below are the pure
 * core of that mechanism: they never touch the filesystem. Callers pass in
 * a settings object and get back the next settings object (or an error).
 * Only the command section at the end of this file reads or writes
 * settings.json. Amendment: review mode only ever touches user-scoped
 * settings (`subagents.watchdog.*`) — it does not modify project-level
 * configuration.
 *
 * Known limitation: settings.json writes here are unlocked (a plain
 * fs.writeFileSync, unlike Pi's own SettingsManager, which takes a
 * proper-lockfile lock on the same file). Running /pair commands
 * concurrently in two Pi sessions can lose an update. Accepted: adding
 * a lock would require a new dependency, which is out of scope.
 */

import fs from "node:fs";
import os from "node:os";
// Imported under a distinct name: the pure helpers below take a dotted
// settings path in a parameter named `path`, which would shadow it.
import nodePath from "node:path";

export const PAIR_MARKER_KEY = "pairActive";

export type PairMode = "review" | "orchestrate";

export interface PairMarker {
  mode: PairMode;
  frontierModel: string;
  workerModel?: string;
  /** Session thinking level from just before orchestrate mode raised it to
   *  "high", so /pair off can restore it. Absent for review-mode markers
   *  (which never touch session thinking) and for any marker written by a
   *  version of this extension that predates this field — both cases
   *  simply mean "nothing to restore". */
  priorThinking?: string;
  /** Exact prior values of every settings key the pairing changed.
   *  A key that did not exist is recorded as { existed: false }. */
  priors: Record<string, { existed: boolean; value?: unknown }>;
}

/** Dotted paths into the settings object touched by review mode. */
export const REVIEW_KEYS: readonly string[] = [
  "subagents.watchdog.enabled",
  "subagents.watchdog.main.enabled",
  "subagents.watchdog.main.model",
  "subagents.watchdog.main.thinking",
];

export const ORCHESTRATE_KEY = "subagents.defaultModel";

/** Splits a dotted path string into its segments. Key names in this
 *  feature never contain literal dots, so a plain split is exact. */
function splitPath(path: string): string[] {
  return path.split(".");
}

/** Reads the value at a dotted path, or undefined if any segment along
 *  the way is absent or not a plain object. */
function getPath(root: Record<string, unknown>, path: string): unknown {
  const segments = splitPath(path);
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Returns whether the value at a dotted path exists (including if its
 *  value is explicitly undefined/null — presence, not truthiness). */
function hasPath(root: Record<string, unknown>, path: string): boolean {
  const segments = splitPath(path);
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    if (!(segment in (current as Record<string, unknown>))) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/** Sets a value at a dotted path, creating intermediate plain objects as
 *  needed. Returns an error string if a non-object value blocks the path
 *  instead of clobbering it. Mutates `root` in place (callers clone first). */
function setPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): { error: string } | undefined {
  const segments = splitPath(path);
  let current: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = current[segment];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return { error: `settings key "${segments.slice(0, i + 1).join(".")}" is not an object` };
    }
    current = next as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
  return undefined;
}

/** Deletes the value at a dotted path (no-op if absent), then prunes any
 *  intermediate object along the path that became empty as a result.
 *  Mutates `root` in place (callers clone first). */
function deletePath(root: Record<string, unknown>, path: string): void {
  const segments = splitPath(path);
  const chain: Record<string, unknown>[] = [root];
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return;
    }
    current = (current as Record<string, unknown>)[segments[i]];
    if (current === undefined) {
      return;
    }
    chain.push(current as Record<string, unknown>);
  }
  const leafObject = chain[chain.length - 1];
  if (leafObject === null || typeof leafObject !== "object" || Array.isArray(leafObject)) {
    return;
  }
  delete leafObject[segments[segments.length - 1]];
  // Prune now-empty intermediate objects, innermost first.
  for (let i = chain.length - 1; i > 0; i--) {
    const obj = chain[i];
    if (Object.keys(obj).length > 0) {
      break;
    }
    delete chain[i - 1][segments[i - 1]];
  }
}

/** Reads the pairing marker from a settings object, if present. */
export function readPairMarker(
  settings: Record<string, unknown>,
): PairMarker | undefined {
  const pair = settings.pair;
  if (pair === null || typeof pair !== "object" || Array.isArray(pair)) {
    return undefined;
  }
  const marker = (pair as Record<string, unknown>)[PAIR_MARKER_KEY];
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) {
    return undefined;
  }
  return marker as PairMarker;
}

/**
 * Pure: returns the next settings object (deep-cloned) with the pairing
 * applied and the marker recorded, or an error string if a pairing is
 * already active.
 */
export function planPairApply(
  settings: Record<string, unknown>,
  input: {
    mode: PairMode;
    frontierModel: string;
    workerModel?: string;
    priorThinking?: string;
  },
): { settings: Record<string, unknown> } | { error: string } {
  if (readPairMarker(settings) !== undefined) {
    return { error: "a pairing is already active; run /pair off first" };
  }

  const next = structuredClone(settings);

  const keys = input.mode === "review" ? REVIEW_KEYS : [ORCHESTRATE_KEY];
  const priors: PairMarker["priors"] = {};
  for (const key of keys) {
    priors[key] = hasPath(next, key)
      ? { existed: true, value: getPath(next, key) }
      : { existed: false };
  }

  if (input.mode === "review") {
    for (const [key, value] of [
      ["subagents.watchdog.enabled", true],
      ["subagents.watchdog.main.enabled", true],
      ["subagents.watchdog.main.model", input.frontierModel],
      ["subagents.watchdog.main.thinking", "high"],
    ] as const) {
      const result = setPath(next, key, value);
      if (result) {
        return result;
      }
    }
  } else {
    const result = setPath(next, ORCHESTRATE_KEY, input.workerModel);
    if (result) {
      return result;
    }
  }

  const marker: PairMarker = {
    mode: input.mode,
    frontierModel: input.frontierModel,
    ...(input.workerModel !== undefined ? { workerModel: input.workerModel } : {}),
    ...(input.priorThinking !== undefined ? { priorThinking: input.priorThinking } : {}),
    priors,
  };
  const markerResult = setPath(next, `pair.${PAIR_MARKER_KEY}`, marker);
  if (markerResult) {
    return markerResult;
  }

  return { settings: next };
}

/**
 * Pure: returns the next settings object with priors restored and the
 * marker removed, or an error string if no marker is present.
 */
export function planPairOff(
  settings: Record<string, unknown>,
): { settings: Record<string, unknown>; marker: PairMarker } | { error: string } {
  const marker = readPairMarker(settings);
  if (marker === undefined) {
    return { error: "no pairing is active" };
  }

  const next = structuredClone(settings);

  for (const [key, prior] of Object.entries(marker.priors)) {
    if (prior.existed) {
      const result = setPath(next, key, prior.value);
      if (result) {
        return result;
      }
    } else {
      deletePath(next, key);
    }
  }

  deletePath(next, `pair.${PAIR_MARKER_KEY}`);

  return { settings: next, marker };
}

/**
 * Frontier model resolution — pure, independent of the settings-planning
 * section above. Answers: given a user-typed model query (or nothing) and
 * the live list of models Pi knows about, which one do we pair with?
 *
 * A query is optionally `provider<sep>id` where `<sep>` is `/`, `:`, or
 * `.`. The prefix before the separator is only treated as a provider if it
 * case-insensitively matches a provider present among the candidates —
 * otherwise the whole query is a bare id (so `gpt-5.5` does not split into
 * provider "gpt"). Only the first separator is honored, so `qwen3:8b`
 * splits into provider "qwen3" only if "qwen3" is an actual provider name
 * (it never is here), and `ollama/qwen3:8b` splits into provider "ollama",
 * id "qwen3:8b".
 *
 * Id comparison is case-insensitive with `.` normalized to `-`. A
 * candidate id also matches if a trailing `-YYYYMMDD` or `-YYYY-MM-DD`
 * date stamp is stripped from it first (date-stamp tolerance applies to
 * the candidate side only, never the query).
 */

export interface CandidateModel {
  provider: string;
  id: string;
  reasoning: boolean;
  authenticated: boolean;
}

const PROVIDER_SEPARATORS = ["/", ":", "."];

/** Lowercases and maps `.` to `-`, for comparing model ids. */
function normalizeId(id: string): string {
  return id.toLowerCase().replaceAll(".", "-");
}

/** Strips a trailing `-YYYYMMDD` or `-YYYY-MM-DD` date stamp, if present. */
function stripDateStamp(id: string): string {
  return id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/** Splits a query into an optional provider and an id. The prefix before
 *  the first separator is only treated as a provider if it matches (case-
 *  insensitively) a provider name present among `candidates`. */
function splitQuery(
  query: string,
  candidates: CandidateModel[],
): { provider?: string; id: string } {
  let sepIndex = -1;
  for (let i = 0; i < query.length; i++) {
    if (PROVIDER_SEPARATORS.includes(query[i])) {
      sepIndex = i;
      break;
    }
  }
  if (sepIndex === -1) {
    return { id: query };
  }
  const prefix = query.slice(0, sepIndex);
  const rest = query.slice(sepIndex + 1);
  const knownProvider = candidates.some(
    (c) => c.provider.toLowerCase() === prefix.toLowerCase(),
  );
  if (!knownProvider) {
    return { id: query };
  }
  return { provider: prefix, id: rest };
}

/** Fuzzy-resolve a query against candidates. Resolution order:
 *  1) exact provider/id, 2) fuzzy. Returns the model or an error listing
 *  near misses / ambiguous candidates. */
export function resolveModelQuery(
  query: string,
  candidates: CandidateModel[],
): { model: CandidateModel } | { error: string } {
  const exact = candidates.find((c) => `${c.provider}/${c.id}` === query);
  if (exact) {
    return { model: exact };
  }

  const { provider, id } = splitQuery(query, candidates);
  const normalizedQueryId = normalizeId(id);
  const pool = provider
    ? candidates.filter((c) => c.provider.toLowerCase() === provider.toLowerCase())
    : candidates;

  const matches = pool.filter((c) => {
    const normalizedCandidateId = normalizeId(c.id);
    if (normalizedCandidateId === normalizedQueryId) {
      return true;
    }
    return normalizeId(stripDateStamp(normalizedCandidateId)) === normalizedQueryId;
  });

  const distinct = new Map<string, CandidateModel>();
  for (const m of matches) {
    distinct.set(`${m.provider}/${m.id}`, m);
  }

  if (distinct.size === 1) {
    return { model: [...distinct.values()][0] };
  }

  if (distinct.size > 1) {
    return {
      error: `ambiguous model query "${query}" matches multiple models: ${[...distinct.keys()].join(", ")}`,
    };
  }

  const nearMisses = candidates
    .filter((c) => {
      if (provider && c.provider.toLowerCase() === provider.toLowerCase()) {
        return true;
      }
      return normalizeId(c.id).includes(normalizedQueryId);
    })
    .slice(0, 3)
    .map((c) => `${c.provider}/${c.id}`);

  const suffix = nearMisses.length > 0 ? ` (did you mean: ${nearMisses.join(", ")}?)` : "";
  return { error: `no model matches query "${query}"${suffix}` };
}

const DEFAULT_FRONTIER_PROVIDERS = ["openai", "openai-codex"];

/** The built-in default frontier model, preferred over the dynamic pick
 *  below whenever it is present among the candidates and authenticated.
 *  Exported so tests can assert against it and a future change has one
 *  place to edit. */
export const PREFERRED_DEFAULT_FRONTIER = "openai-codex/gpt-5.6-sol";

/** Fallback: prefers PREFERRED_DEFAULT_FRONTIER when it is present among the
 *  candidates and authenticated. Otherwise, falls back to the newest
 *  authenticated OpenAI-family model. Providers considered for the fallback
 *  path: "openai", "openai-codex". Prefers reasoning models; among equals,
 *  later registry position wins (registries append newer models). */
export function pickDefaultFrontier(
  candidates: CandidateModel[],
): { model: CandidateModel } | { error: string } {
  const preferred = candidates.find(
    (c) => `${c.provider}/${c.id}` === PREFERRED_DEFAULT_FRONTIER && c.authenticated === true,
  );
  if (preferred) {
    return { model: preferred };
  }

  const eligible = candidates.filter(
    (c) => c.authenticated === true && DEFAULT_FRONTIER_PROVIDERS.includes(c.provider),
  );

  if (eligible.length === 0) {
    return {
      error:
        "no authenticated OpenAI-family model available; pass a model explicitly or run /pair default",
    };
  }

  const reasoning = eligible.filter((c) => c.reasoning === true);
  const pool = reasoning.length > 0 ? reasoning : eligible;

  return { model: pool[pool.length - 1] };
}

/** Providers whose models run locally rather than against a frontier API. */
export const LOCAL_PROVIDER_IDS: readonly string[] = [
  "ollama",
  "lmstudio",
  "llamacpp",
  "llama.cpp",
];

/** Case-insensitive membership test against LOCAL_PROVIDER_IDS. */
export function isLocalModel(provider: string): boolean {
  return LOCAL_PROVIDER_IDS.some((p) => p.toLowerCase() === provider.toLowerCase());
}

/**
 * Command surface — argument parsing and status text (pure), settings
 * file I/O, and the extension factory that wires both to Pi's `/pair`
 * command. Everything above this point is filesystem- and Pi-agnostic.
 */

export type PairSubcommand =
  | { kind: "review"; model?: string }
  | { kind: "orchestrate"; model?: string }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "default"; model?: string }
  | { kind: "help" };

const SUBCOMMANDS_TAKING_A_MODEL = ["review", "orchestrate", "default"];
const SUBCOMMANDS_TAKING_NOTHING = ["off", "status"];

export const PAIR_USAGE = [
  "Usage:",
  "  /pair review [model]        keep the local model, add a frontier reviewer (watchdog)",
  "  /pair orchestrate [model]   switch the session to a frontier model, run subagents locally",
  "  /pair off                   restore every setting the pairing changed",
  "  /pair status                show the active pairing and the default frontier model",
  "  /pair default [model]       show or set the frontier model used when none is given",
].join("\n");

/**
 * Pure: parses `/pair` arguments into a subcommand. Empty input is `help`;
 * an unknown subcommand or a stray extra token is an error.
 */
export function parsePairArgs(args: string): PairSubcommand | { error: string } {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { kind: "help" };
  }

  const [name, ...rest] = tokens;
  const known = [...SUBCOMMANDS_TAKING_A_MODEL, ...SUBCOMMANDS_TAKING_NOTHING];
  if (!known.includes(name)) {
    return {
      error: `unknown subcommand "${name}"; expected one of: ${known.join(", ")}`,
    };
  }

  if (SUBCOMMANDS_TAKING_NOTHING.includes(name)) {
    if (rest.length > 0) {
      return { error: `"${name}" takes no arguments` };
    }
    return name === "off" ? { kind: "off" } : { kind: "status" };
  }

  if (rest.length > 1) {
    return {
      error: `too many arguments for "${name}"; expected at most one model, got ${rest.length}`,
    };
  }
  const model = rest.length === 1 ? rest[0] : undefined;
  if (name === "review") {
    return { kind: "review", model };
  }
  if (name === "orchestrate") {
    return { kind: "orchestrate", model };
  }
  return { kind: "default", model };
}

/**
 * Pure: builds the multi-line text `/pair status` prints — active mode
 * and models in play, the configured or resolved default frontier model,
 * and the settings keys the active pairing changed.
 */
export function formatPairStatus(input: {
  marker: PairMarker | undefined;
  currentSessionModel: string | undefined;
  defaultFrontierModel: string | undefined;
  resolvedFallback: string | undefined;
}): string {
  const lines: string[] = [];

  if (input.marker === undefined) {
    lines.push("No pairing active.");
  } else {
    lines.push(`Pairing active: ${input.marker.mode} mode.`);
    lines.push(`  frontier model: ${input.marker.frontierModel}`);
    if (input.marker.workerModel !== undefined) {
      lines.push(`  worker model: ${input.marker.workerModel}`);
    }
  }

  lines.push(`  session model: ${input.currentSessionModel ?? "unknown"}`);

  if (input.defaultFrontierModel !== undefined) {
    lines.push(`  default frontier model: configured: ${input.defaultFrontierModel}`);
  } else if (input.resolvedFallback !== undefined) {
    lines.push(
      `  default frontier model: fallback would resolve to: ${input.resolvedFallback}`,
    );
  } else {
    lines.push(
      "  default frontier model: none available — run /pair default <model>",
    );
  }

  if (input.marker !== undefined) {
    const changed = Object.keys(input.marker.priors);
    lines.push("  settings changed by this pairing:");
    if (changed.length === 0) {
      lines.push("    (none recorded)");
    } else {
      for (const key of changed) {
        lines.push(`    ${key}`);
      }
    }
    lines.push("Turn off with /pair off.");
  }

  return lines.join("\n");
}

/** Path to the settings.json pi-subagents reads, honoring
 *  PI_CODING_AGENT_DIR (including a leading `~`). */
function settingsPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir =
    configured === "~"
      ? os.homedir()
      : configured?.startsWith("~/")
        ? nodePath.join(os.homedir(), configured.slice(2))
        : configured || nodePath.join(os.homedir(), ".pi", "agent");
  return nodePath.join(agentDir, "settings.json");
}

/** Throws on unreadable or non-object JSON, so callers can abort without
 *  ever writing over a file they could not understand. */
function readSettings(): Record<string, unknown> {
  const file = settingsPath();
  if (!fs.existsSync(file)) {
    return {};
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.json does not contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function writeSettings(settings: Record<string, unknown>): void {
  const file = settingsPath();
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads settings, converting any failure into a reportable error rather
 *  than a throw — a command that cannot read settings must not write. */
function loadSettings(): { settings: Record<string, unknown> } | { error: string } {
  try {
    return { settings: readSettings() };
  } catch (error) {
    return {
      error: `could not read ${settingsPath()}: ${errorMessage(error)}. Settings were not modified.`,
    };
  }
}

/** Writes settings, returning an error string instead of throwing. */
function saveSettings(settings: Record<string, unknown>): string | undefined {
  try {
    writeSettings(settings);
    return undefined;
  } catch (error) {
    return `could not write ${settingsPath()}: ${errorMessage(error)}`;
  }
}

/** Minimal shapes of the Pi objects this extension uses, declared locally
 *  so the extension does not depend on Pi's type exports. */
interface PairModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface PairModelRegistry {
  getAll(): PairModel[];
  find(provider: string, modelId: string): PairModel | undefined;
  hasConfiguredAuth(model: PairModel): boolean;
}

interface PairCommandContext {
  model: PairModel | undefined;
  modelRegistry: PairModelRegistry;
  setModel(model: PairModel): Promise<boolean>;
  getActiveTools(): string[];
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
}

interface PairExtensionApi {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: PairCommandContext) => Promise<void>;
    },
  ): void;
  sendMessage(message: {
    customType: string;
    content: string;
    display: boolean;
  }): void;
  on(event: "session_start", handler: () => void): void;
}

/** "provider/id" — the form settings.json and every message use. */
function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Splits a "provider/id" reference on its first slash. */
function splitModelRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return undefined;
  }
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function buildCandidates(ctx: PairCommandContext): CandidateModel[] {
  return ctx.modelRegistry.getAll().map((model) => ({
    provider: model.provider,
    id: model.id,
    reasoning: model.reasoning,
    authenticated: ctx.modelRegistry.hasConfiguredAuth(model),
  }));
}

/** Explicit argument, then the configured default, then the fallback. */
function resolveFrontier(
  query: string | undefined,
  settings: Record<string, unknown>,
  candidates: CandidateModel[],
): { model: CandidateModel } | { error: string } {
  if (query !== undefined) {
    return resolveModelQuery(query, candidates);
  }
  const configured = getPath(settings, "pair.defaultFrontierModel");
  if (typeof configured === "string" && configured.length > 0) {
    const resolved = resolveModelQuery(configured, candidates);
    if ("error" in resolved) {
      return {
        error: `configured default frontier model "${configured}" no longer resolves: ${resolved.error}`,
      };
    }
    return resolved;
  }
  return pickDefaultFrontier(candidates);
}

/** pi-subagents supplies the `subagent` tool; both pairing modes depend on
 *  it. Defaults to present so an unexpected API shape cannot brick /pair. */
function hasSubagentTool(ctx: PairCommandContext): boolean {
  try {
    return ctx.getActiveTools().includes("subagent");
  } catch {
    return true;
  }
}

/** Result of a session model switch: `true` on success, or an object
 *  carrying the reason for a failure so callers can report the real
 *  cause instead of guessing at one. */
type SwitchModelResult = true | { reason: string };

/** Switches the session model. A missing model, a refused switch (e.g.
 *  no API key configured), or a thrown error (Pi's internal setModel
 *  performs its own async checkAuth, which can throw for reasons beyond
 *  a missing key, such as a key that is present but invalid) are all
 *  reported back as a reason string rather than collapsed to `false`. */
async function switchSessionModel(
  ctx: PairCommandContext,
  target: { provider: string; id: string },
): Promise<SwitchModelResult> {
  try {
    const model = ctx.modelRegistry.find(target.provider, target.id);
    if (model === undefined) {
      return { reason: `no such model ${target.provider}/${target.id}` };
    }
    const ok = await ctx.setModel(model);
    return ok ? true : { reason: "the switch was refused" };
  } catch (error) {
    return { reason: errorMessage(error) };
  }
}

export default function pair(pi: PairExtensionApi): void {
  const send = (text: string): void => {
    pi.sendMessage({ customType: "pair-text", content: text, display: true });
  };

  const handleReview = async (
    ctx: PairCommandContext,
    query: string | undefined,
  ): Promise<void> => {
    const loaded = loadSettings();
    if ("error" in loaded) {
      send(loaded.error);
      return;
    }
    const frontier = resolveFrontier(query, loaded.settings, buildCandidates(ctx));
    if ("error" in frontier) {
      send(frontier.error);
      return;
    }
    const frontierRef = modelRef(frontier.model);

    const planned = planPairApply(loaded.settings, {
      mode: "review",
      frontierModel: frontierRef,
    });
    if ("error" in planned) {
      send(planned.error);
      return;
    }
    const writeError = saveSettings(planned.settings);
    if (writeError !== undefined) {
      send(writeError);
      return;
    }

    const lines: string[] = [];
    if (ctx.model && !isLocalModel(ctx.model.provider)) {
      lines.push(
        `Warning: the session model ${modelRef(ctx.model)} is not a local model, so this pairs a frontier reviewer with a frontier session.`,
      );
    }
    lines.push(
      `Pairing active: review mode with ${frontierRef} as the reviewer.`,
      "The subagent watchdog engages from the next turn — no restart needed.",
      "The session model is unchanged. End the pairing with /pair off.",
    );
    send(lines.join("\n"));
  };

  const handleOrchestrate = async (
    ctx: PairCommandContext,
    query: string | undefined,
  ): Promise<void> => {
    if (!ctx.model) {
      send(
        "no session model to designate as worker; select a local model with /model first",
      );
      return;
    }
    const workerRef = modelRef(ctx.model);

    const loaded = loadSettings();
    if ("error" in loaded) {
      send(loaded.error);
      return;
    }
    const frontier = resolveFrontier(query, loaded.settings, buildCandidates(ctx));
    if ("error" in frontier) {
      send(frontier.error);
      return;
    }
    const frontierRef = modelRef(frontier.model);
    if (frontierRef === workerRef) {
      send(
        `the session is already on ${frontierRef}; switch to a local model with /model before pairing`,
      );
      return;
    }

    // Captured before any write, so a failed model switch can be undone.
    const prePlanSettings = structuredClone(loaded.settings);
    // Captured now (nothing between here and the switch below touches
    // session thinking) so the marker can record it in the same write as
    // everything else, ahead of the switch this plan is about to attempt.
    const priorThinking = ctx.getThinkingLevel();
    const planned = planPairApply(loaded.settings, {
      mode: "orchestrate",
      frontierModel: frontierRef,
      workerModel: workerRef,
      priorThinking,
    });
    if ("error" in planned) {
      send(planned.error);
      return;
    }
    const writeError = saveSettings(planned.settings);
    if (writeError !== undefined) {
      send(writeError);
      return;
    }

    const switchResult = await switchSessionModel(ctx, frontier.model);
    if (switchResult !== true) {
      const rollbackError = saveSettings(prePlanSettings);
      send(
        rollbackError === undefined
          ? `could not switch the session model to ${frontierRef} (${switchResult.reason}); settings were rolled back and nothing changed`
          : `could not switch the session model to ${frontierRef} (${switchResult.reason}), and rolling the settings back failed: ${rollbackError}. Run /pair off to restore them.`,
      );
      return;
    }

    // Thinking is only ever raised once the switch is confirmed to have
    // succeeded — if the switch had failed above, this line never runs.
    ctx.setThinkingLevel("high");

    send(
      [
        `Pairing active: orchestrate mode with ${frontierRef} orchestrating.`,
        `Subagents launched with /run now use ${workerRef}.`,
        "Session thinking raised to high.",
        "End the pairing with /pair off, which also restores the session model.",
      ].join("\n"),
    );
  };

  const handleOff = async (ctx: PairCommandContext): Promise<void> => {
    const loaded = loadSettings();
    if ("error" in loaded) {
      send(loaded.error);
      return;
    }
    const planned = planPairOff(loaded.settings);
    if ("error" in planned) {
      // planPairOff fails either because there is nothing to turn off, or
      // because restoring a prior hit a settings key it refuses to clobber.
      // The second case leaves the pairing in place, so it must be reported
      // rather than collapsed into a reassuring "nothing to do".
      send(
        readPairMarker(loaded.settings) === undefined
          ? "No pairing active."
          : `could not turn the pairing off: ${planned.error}. The pairing is still active and settings were not modified.`,
      );
      return;
    }

    // Settings are restored first, before any attempt to switch the model
    // back. Pi's own ctx.setModel asynchronously persists defaultModel /
    // defaultProvider into this same settings.json; writing our restored
    // snapshot after that call would silently discard Pi's update. Pi's
    // settings writer does a fresh read-modify-merge under a lock at
    // actual-write time, so landing our write first is safe regardless of
    // when Pi's write lands.
    const writeError = saveSettings(planned.settings);
    if (writeError !== undefined) {
      send(`Settings were NOT restored: ${writeError}`);
      return;
    }

    const changed = Object.keys(planned.marker.priors);
    const lines: string[] = [`Pairing off: ${planned.marker.mode} mode ended.`];
    lines.push(
      changed.length === 0
        ? "No settings needed restoring."
        : `Settings restored to their prior values: ${changed.join(", ")}.`,
    );

    // The model switch happens after the settings restore and its outcome
    // never blocks or is blocked by it: a failed switch is reported but
    // the settings restore above has already completed either way.
    if (planned.marker.mode === "orchestrate" && planned.marker.workerModel) {
      const worker = splitModelRef(planned.marker.workerModel);
      const switchResult: SwitchModelResult =
        worker !== undefined
          ? await switchSessionModel(ctx, worker)
          : { reason: `malformed worker model reference "${planned.marker.workerModel}"` };
      lines.push(
        switchResult === true
          ? `Session model restored to ${planned.marker.workerModel}.`
          : `Could not restore the session model to ${planned.marker.workerModel} (${switchResult.reason}) — switch back with /model.`,
      );
    }

    // Thinking restore is independent of the model-switch outcome above and
    // must never block completion of /pair off: a marker from before this
    // field existed simply has nothing to restore, and a failure here is
    // reported the same way a failed model restore is, above.
    if (planned.marker.priorThinking !== undefined) {
      try {
        ctx.setThinkingLevel(planned.marker.priorThinking as ThinkingLevel);
        lines.push(`Session thinking restored to ${planned.marker.priorThinking}.`);
      } catch (error) {
        lines.push(
          `Could not restore session thinking to ${planned.marker.priorThinking} (${errorMessage(error)}) — adjust it manually if needed.`,
        );
      }
    }

    send(lines.join("\n"));
  };

  const handleStatus = async (ctx: PairCommandContext): Promise<void> => {
    const loaded = loadSettings();
    if ("error" in loaded) {
      send(loaded.error);
      return;
    }
    const configured = getPath(loaded.settings, "pair.defaultFrontierModel");
    const fallback = pickDefaultFrontier(buildCandidates(ctx));
    send(
      formatPairStatus({
        marker: readPairMarker(loaded.settings),
        currentSessionModel: ctx.model ? modelRef(ctx.model) : undefined,
        defaultFrontierModel: typeof configured === "string" ? configured : undefined,
        resolvedFallback: "model" in fallback ? modelRef(fallback.model) : undefined,
      }),
    );
  };

  const handleDefault = async (
    ctx: PairCommandContext,
    query: string | undefined,
  ): Promise<void> => {
    const loaded = loadSettings();
    if ("error" in loaded) {
      send(loaded.error);
      return;
    }
    const candidates = buildCandidates(ctx);
    const configured = getPath(loaded.settings, "pair.defaultFrontierModel");

    if (query === undefined) {
      const fallback = pickDefaultFrontier(candidates);
      send(
        [
          typeof configured === "string"
            ? `Default frontier model: ${configured}`
            : "Default frontier model: not configured.",
          "model" in fallback
            ? `Without one configured, /pair would resolve to ${modelRef(fallback.model)}.`
            : `Without one configured, /pair could not resolve a frontier model: ${fallback.error}`,
          "Set one with /pair default <model>.",
        ].join("\n"),
      );
      return;
    }

    const resolved = resolveModelQuery(query, candidates);
    if ("error" in resolved) {
      send(resolved.error);
      return;
    }
    const next = structuredClone(loaded.settings);
    const setError = setPath(next, "pair.defaultFrontierModel", modelRef(resolved.model));
    if (setError !== undefined) {
      send(setError.error);
      return;
    }
    const writeError = saveSettings(next);
    if (writeError !== undefined) {
      send(writeError);
      return;
    }
    send(
      `Default frontier model set to ${modelRef(resolved.model)}. It survives /pair off.`,
    );
  };

  const handler = async (args: string, ctx: PairCommandContext): Promise<void> => {
    try {
      const parsed = parsePairArgs(args);
      if ("error" in parsed) {
        send(`${parsed.error}\n\n${PAIR_USAGE}`);
        return;
      }
      if (parsed.kind === "help") {
        send(PAIR_USAGE);
        return;
      }
      if (
        (parsed.kind === "review" || parsed.kind === "orchestrate") &&
        !hasSubagentTool(ctx)
      ) {
        send("pi-subagents is required for /pair review and /pair orchestrate");
        return;
      }
      switch (parsed.kind) {
        case "review":
          await handleReview(ctx, parsed.model);
          return;
        case "orchestrate":
          await handleOrchestrate(ctx, parsed.model);
          return;
        case "off":
          await handleOff(ctx);
          return;
        case "status":
          await handleStatus(ctx);
          return;
        case "default":
          await handleDefault(ctx, parsed.model);
          return;
      }
    } catch (error) {
      send(`/pair failed: ${errorMessage(error)}`);
    }
  };

  pi.registerCommand("pair", {
    description:
      "Pair a local-model session with a frontier reviewer or orchestrator",
    handler,
  });

  // Passive: a pairing outlives the session that created it, so say so.
  // Wrapped whole — this check must never block session startup.
  pi.on("session_start", () => {
    try {
      const marker = readPairMarker(readSettings());
      if (marker === undefined) {
        return;
      }
      const changed = Object.keys(marker.priors).join(", ") || "none";
      send(
        `Pair: a '${marker.mode}' pairing from a previous session is still active (settings: ${changed}). Run /pair off to clear it.`,
      );
    } catch {
      // Degrade silently: an unreadable settings.json is /pair's problem
      // to report when the user actually runs a command.
    }
  });
}
