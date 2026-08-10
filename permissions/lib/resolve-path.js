import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Resolve a path to its physical location so a symlink inside the
 * workspace cannot launder access to a gated location. The deepest
 * existing ancestor is resolved through the filesystem and any
 * not-yet-existing suffix is re-joined lexically. On any resolution
 * failure the original path is returned — policies then match the
 * lexical path, which is never more permissive for symlink targets
 * than before this helper existed.
 */
export function resolvePhysicalPath(absolutePath) {
  let probe = absolutePath;
  const suffix = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      return absolutePath;
    }
    suffix.unshift(basename(probe));
    probe = parent;
  }
  try {
    return join(realpathSync(probe), ...suffix);
  } catch {
    return absolutePath;
  }
}
