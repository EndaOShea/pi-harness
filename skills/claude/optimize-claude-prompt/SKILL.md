---
name: optimize-claude-prompt
description: Optimize, rewrite, or review prompts for Claude Sonnet 5, Claude Opus 5, or Claude Fable 5. Use when the user asks to improve a standalone prompt, short context-dependent follow-up, system prompt, CLAUDE.md instruction, Claude Code skill, agent definition, API prompt, tool-use harness, or long-running workflow for one of these models. Preserve the active task contract when optimizing follow-up messages.
---

# Optimize Claude Prompt

Tailor behavioral and orchestration instructions to the model that will execute the prompt. Preserve the user's actual task contract.

## Resolve the target model

Resolve the target independently on every optimization request:

1. Use an explicit target in the user's request.
2. Otherwise use the model configured in the artifact or harness.
3. Otherwise use the active runtime model when the user says "current" or "active."

Do not infer the active model from `ANTHROPIC_MODEL`, settings files, or default-family variables; these can disagree with `/model`, resumed sessions, organization defaults, or turn overrides. If the runtime identity is unavailable and the family materially changes the rewrite, ask one concise question.

Read exactly the matching profile:

- Sonnet 5: [references/sonnet-5.md](references/sonnet-5.md)
- Opus 5: [references/opus-5.md](references/opus-5.md)
- Fable 5: [references/fable-5.md](references/fable-5.md)

For another or unknown Claude model, do not guess or substitute a nearby profile. Return the assessment without a model-specific rewrite unless the user explicitly requests general prompt guidance.

## Compile the effective task

Read [references/context-delta.md](references/context-delta.md) completely. Classify the latest prompt before applying model guidance:

- `FULL_TASK`: a standalone or clearly new task.
- `CONTEXT_DELTA`: a follow-up that extends, corrects, narrows, or advances the active task.
- `AMBIGUOUS_REFERENCE`: a follow-up whose referent remains unresolved after inspecting available context.

Use the visible initial task, recent turns, accepted decisions, current plan or task state, completed work, outstanding work, and repository evidence when available. Treat a contextual follow-up as an amendment, not a replacement. Never invent missing conversation state.

Apply this precedence:

1. System and environment constraints.
2. Original task requirements and acceptance criteria.
3. Explicit later user corrections.
4. Accepted execution decisions.
5. Latest user instruction.
6. Model-specific behavioral optimization.

The model layer must not silently override levels 1–5.

## Preserve invariants

- Never remove concrete requirements, acceptance criteria, file boundaries, safety constraints, or user intent.
- Never invent functionality, tools, permissions, project facts, decisions, or completed work.
- Change behavioral and orchestration instructions only unless the user explicitly authorizes task-contract changes.
- Detect and report conflicts between the source contract, later amendments, and proposed model guidance.
- Do not add hidden-reasoning or chain-of-thought requests. Ask for conclusions, evidence, assumptions, checks, or concise rationale.
- Detect an already model-corrected prompt. If the target and task delta have not changed, return `No change needed` instead of wrapping it again.

## Transform by prompt mode

For `FULL_TASK`, apply the relevant model profile to scope, autonomy, tool use, progress, delegation, verification, runtime settings, response style, and stopping conditions. Add only guidance that changes likely behavior.

For `CONTEXT_DELTA`, preserve brevity and prior-context references. Clarify only materially ambiguous scope, state the requested change, and preserve earlier constraints and settled decisions. Do not restate the full task, invent acceptance criteria, reopen completed planning, or reprocess unrelated prompt sections. An unchanged follow-up is valid when it already expresses the delta precisely.

For `AMBIGUOUS_REFERENCE`, inspect available conversation, plan, task state, and repository evidence first. If unresolved, ask for clarification in an interactive workflow. For an autonomous prompt artifact, mark the exact unresolved referent and stop execution rather than guessing.

Put runtime controls outside prompt text when they belong in configuration, including model, effort, thinking mode, `max_tokens`, timeouts, and sampling parameters.

For prompt files, make surgical edits unless the user requests a full rewrite. Do not edit files or task-state records unless requested.

## Return the result

Unless the user requests another format, return:

## Prompt assessment

- Prompt mode:
- Target model:
- Issues detected:
- Changes applied:
- Requirements preserved:
- Potential conflicts:

## Corrected prompt

Return one ready-to-paste prompt. For an unresolved interactive reference, ask the clarification instead.

## Transformation diff

Show a concise unified diff for prompt text or the actual file diff after an edit. If nothing changed, state `No change needed`.

Add `Runtime settings` only when a non-prompt setting materially improves the workload. If the user requests only the prompt, output only the corrected prompt.
