# Repo Context Architect

A cross-CLI Agent Skill for creating progressive-disclosure repository documentation.

## Install for all repositories

```bash
python3 scripts/install_skill.py --scope user
```

This installs identical copies to:

```text
~/.agents/skills/repo-context-architect/
~/.claude/skills/repo-context-architect/
```

The `.agents` copy is discoverable by Codex and Gemini CLI. The `.claude` copy is discoverable by Claude Code.

## Install inside one repository

```bash
python3 scripts/install_skill.py --scope repo --repo /path/to/repository
```

## Use

In a supporting CLI, invoke the skill by name or ask:

```text
Use repo-context-architect to inspect this repository and set up progressive-disclosure documentation for all coding CLIs. Preserve existing useful docs and preview changes before applying them.
```

The skill will use `scripts/setup_repo_context.py` to scaffold conservative defaults, then complete them from repository evidence.
