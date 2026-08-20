/**
 * CI probe: dumps what the assembled product actually discovered.
 *
 * On before_agent_start, writes skill and context-file names from
 * systemPromptOptions to $HARNESS_PROBE_OUT as JSON. Names only — the
 * options object can carry full file contents, which must not be dumped.
 * CI-only repo tooling; see README.md in this directory.
 *
 * Shapes (verified against dist/core/system-prompt.d.ts and
 * dist/core/skills.d.ts in the installed @earendil-works/pi-coding-agent
 * package):
 *   BuildSystemPromptOptions.skills: Skill[] where Skill.name and
 *     Skill.baseDir are required strings (also has filePath, sourceInfo,
 *     etc. — not dumped). Skills bundled under one configured directory
 *     (e.g. the "core" collection) each get their own `name`, distinct
 *     from the directory name, so discovery is proven by `baseDir`
 *     (which retains the configured path prefix), not by `name` alone.
 *   BuildSystemPromptOptions.contextFiles: Array<{ path: string; content:
 *     string }> — no `name` field, so we key off `path`.
 * The extraction below tolerates plain strings too, in case either shape
 * changes to a bare string list in a future Pi version.
 */
import { writeFileSync } from "node:fs";

interface MinimalExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

export default function probeDiscovery(pi: MinimalExtensionApi) {
  pi.on("before_agent_start", (rawEvent) => {
    try {
      const out = process.env.HARNESS_PROBE_OUT;
      if (!out) {
        return;
      }
      const options = (rawEvent as { systemPromptOptions?: unknown })
        ?.systemPromptOptions as {
        skills?: Array<{ name?: unknown; baseDir?: unknown } | string>;
        contextFiles?: Array<{ path?: unknown; name?: unknown } | string>;
      } | undefined;

      const extract = (list: unknown, keys: string[]): string[] =>
        Array.isArray(list)
          ? list
              .map((item) => {
                if (typeof item === "string") {
                  return item;
                }
                for (const key of keys) {
                  const value = (item as Record<string, unknown>)?.[key];
                  if (typeof value === "string" && value.length > 0) {
                    return value;
                  }
                }
                return "";
              })
              .filter((name) => name.length > 0)
          : [];

      writeFileSync(
        out,
        JSON.stringify({
          skills: extract(options?.skills, ["name"]),
          // Names only for skills; baseDir is a filesystem location the
          // installer itself put there, not file content, so recording it
          // is what lets the assertion prove *which* configured skill
          // directories were actually scanned (a bundle directory like
          // "core" never surfaces as a skill name — only its members do).
          skillDirs: extract(options?.skills, ["baseDir"]),
          contextFiles: extract(options?.contextFiles, ["path", "name"]),
        }),
      );
    } catch {
      // The assertion script treats a missing probe file as the failure.
    }
  });
}
