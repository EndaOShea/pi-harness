/**
 * Shared append-only log conventions for harness extensions.
 *
 * Extracted from the pattern proven in tpm-telemetry.ts: logs live under
 * $PI_AGENT_DIR/harness/<name>/, one JSONL file per UTC day, pruned by age
 * or total size once per session. Every operation is fail-open — a logging
 * failure must never take down a session or alter a tool result.
 *
 * This directory deliberately has no index.ts: Pi loads extensions from
 * extensions/*.ts and extensions/*_/index.ts, and this is a library, not an
 * extension. Deliberately no dependency on the Pi package types, so this
 * file stays parseable by the repository's validation without an installed
 * runtime (same convention as tpm-telemetry.ts).
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Pi agent directory this process is using. */
export function agentDir(): string {
  return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Create `dir` (recursively) with owner-only permissions. */
export function ensureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

function dayStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Append one JSON record to `<dir>/<prefix>-YYYY-MM-DD.jsonl`. */
export function appendDaily(
  dir: string,
  prefix: string,
  ts: number,
  record: object,
): void {
  if (!ensureDir(dir)) {
    return;
  }
  try {
    appendFileSync(
      join(dir, `${prefix}-${dayStamp(ts)}.jsonl`),
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Logging failure is never fatal.
  }
}

interface AgedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

function listFilesByAge(dir: string): AgedFile[] {
  const files: AgedFile[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isFile()) {
          files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // A file that vanished mid-listing is already pruned.
      }
    }
  } catch {
    return [];
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
}

/** Delete regular files in `dir` older than `keepDays` days. */
export function pruneOldFiles(dir: string, keepDays: number, now: number): void {
  const cutoff = now - keepDays * 86_400_000;
  for (const file of listFilesByAge(dir)) {
    if (file.mtimeMs < cutoff) {
      try {
        unlinkSync(file.path);
      } catch {
        // Best-effort.
      }
    }
  }
}

/** Delete oldest files in `dir` until total size is at most `maxBytes`. */
export function pruneToSize(dir: string, maxBytes: number): void {
  const files = listFilesByAge(dir);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of files) {
    if (total <= maxBytes) {
      return;
    }
    try {
      unlinkSync(file.path);
      total -= file.size;
    } catch {
      // Best-effort.
    }
  }
}
