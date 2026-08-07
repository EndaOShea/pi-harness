# CLI compatibility model

The canonical repository contract is `AGENTS.md`. Tool-specific files are adapters, not separate sources of truth.

| Tool | Repository instructions | Skill location | Strategy |
|---|---|---|---|
| Codex CLI | `AGENTS.md` hierarchy | `.agents/skills/<name>/SKILL.md` | Native canonical format |
| Claude Code | `CLAUDE.md`, scoped memory/rules | `.claude/skills/<name>/SKILL.md` | Adapter points to canonical files |
| Gemini CLI | `GEMINI.md` hierarchy/imports | `.agents/skills/<name>/SKILL.md` or `.gemini/skills/` | Use `.agents` shared skill location |
| GitHub Copilot CLI/IDE | `.github/copilot-instructions.md`; optional path rules | Tool support varies | Adapter points to canonical files |
| Cursor CLI/IDE | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules` | Tool support varies | Prefer canonical `AGENTS.md` |
| Other agents | varies | varies | Explicitly instruct them to read `AGENTS.md` |

## Installation approach

Store the maintained skill once outside or inside the repo, then install copies or links:

```text
.agents/skills/repo-context-architect/
.claude/skills/repo-context-architect/
```

Symlinks reduce duplication on macOS/Linux, but committed symlinks can be awkward on Windows. For maximum portability, keep identical copies and use the included installation script to refresh them.

## Adapter principle

Adapters should contain only:

- which canonical files to read;
- how to find the nearest scoped `AGENTS.md`;
- a small number of genuinely tool-specific rules;
- a warning not to duplicate canonical content.
