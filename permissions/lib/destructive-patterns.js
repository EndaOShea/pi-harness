/**
 * Fallback detection for destructive operations hidden inside interpreter
 * commands or shell constructs. Direct commands are parsed structurally by
 * @thurstonsand/pi-permissions in confirm-deletions.ts.
 */
export const DESTRUCTIVE_FALLBACK_PATTERNS = [
  {
    name: "interpreter filesystem deletion",
    pattern:
      /\b(?:python(?:3)?|node|ruby)\b[\s\S]*(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|Path\([^)]*\)\.(?:unlink|rmdir)|(?:fs\.|require\(["'](?:node:)?fs["']\)\.)(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)|FileUtils\.rm_rf|File\.(?:delete|unlink))\b/,
  },
  {
    name: "perl filesystem deletion",
    pattern: /\bperl\b[\s\S]*\b(?:unlink|rmdir|rmtree|remove_tree)\b/,
  },
  {
    name: "nested shell deletion",
    pattern:
      /\b(?:bash|sh|zsh|dash|ksh)\b[^\n;&|]*\s-[a-zA-Z]*c\b[\s\S]*\b(?:rm|rmdir|unlink|shred)\b/,
  },
  {
    name: "xargs deletion",
    pattern: /\bxargs\b[^\n;&|]*(?:\brm\b|\brmdir\b|\bunlink\b|\bshred\b)/,
  },
  {
    name: "rsync deletion",
    pattern: /\brsync\b[^\n;&|]*--delete/,
  },
  {
    name: "dd overwrite",
    pattern: /\bdd\b[^\n;&|]*\bof=(?!\/dev\/)/,
  },
  {
    name: "git stash destruction",
    pattern: /\bgit\b[^\n;&|]*\bstash\s+(?:drop|clear)\b/,
  },
  {
    name: "git forced branch deletion",
    pattern:
      /\bgit\b[^\n;&|]*\bbranch\s+(?:-[a-zA-Z]*D[a-zA-Z]*\b|--delete\b[^\n;&|]*--force\b|--force\b[^\n;&|]*--delete\b)/,
  },
  {
    name: "git forced push",
    pattern:
      /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-zA-Z]*f[a-zA-Z]*\b)/,
  },
  {
    name: "explicit file truncation",
    pattern:
      /(?:\btruncate\b[^\n;&|]*(?:\s-s\s*0\b|\s--size(?:=|\s+)0\b)|\bcp\b[^\n;&|]*\/dev\/null\b|(?:^|[;&|]\s*)(?::|true)\s*>\s*[^>&])/m,
  },
];

export function findDestructiveFallbacks(command) {
  return DESTRUCTIVE_FALLBACK_PATTERNS.filter(({ pattern }) =>
    pattern.test(command),
  );
}
