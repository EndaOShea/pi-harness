---
name: optimize-gpt-5-6-prompt
description: Optimize, rewrite, review, or migrate prompts specifically for GPT-5.6, gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna. Use for standalone prompts or short context-dependent follow-ups, system or developer prompts, agent instructions, tool descriptions, response contracts, autonomy rules, Pro mode workloads, or Programmatic Tool Calling orchestration. Preserve the active task contract for follow-up messages. Do not use for other model families or general OpenAI API questions.
---

# Optimize GPT-5.6 Prompt

Optimize behavioral and orchestration instructions for the GPT-5.6 execution model while preserving the user's actual task contract.

Read these references completely before rewriting or reviewing:

- [references/context-delta.md](references/context-delta.md)
- [references/gpt-5-6-prompting.md](references/gpt-5-6-prompting.md)

If the explicit target or artifact configuration is not a GPT-5.6 family model, stop safely instead of applying this profile.

## Compile the effective task

Classify the latest prompt before applying model guidance:

- `FULL_TASK`: a standalone or clearly new task.
- `CONTEXT_DELTA`: a follow-up that extends, corrects, narrows, or advances the active task.
- `AMBIGUOUS_REFERENCE`: a follow-up whose referent remains unresolved after inspecting available context.

Use the visible initial task, recent turns, accepted decisions, current plan or task state, completed work, outstanding work, and repository evidence when available. Treat a contextual follow-up as an amendment, not a replacement. Never invent missing state.

Apply this precedence:

1. System and environment constraints.
2. Original task requirements and acceptance criteria.
3. Explicit later user corrections.
4. Accepted execution decisions.
5. Latest user instruction.
6. GPT-5.6 behavioral optimization.

The GPT-5.6 layer must not silently override levels 1–5.

## Preserve invariants

- Never remove concrete requirements, acceptance criteria, file boundaries, safety constraints, or user intent.
- Never invent functionality, tools, permissions, project facts, decisions, or completed work.
- Change behavioral and orchestration instructions only unless the user explicitly authorizes task-contract changes.
- Detect and report conflicts between the source contract, later amendments, and proposed model guidance.
- Do not add hidden-reasoning or chain-of-thought requests. Ask for conclusions, evidence, assumptions, checks, or concise rationale.
- Detect an already GPT-5.6-corrected prompt. If the target and task delta have not changed, return `No change needed` instead of wrapping it again.

## Transform by prompt mode

For `FULL_TASK`, extract the goal, success criteria, evidence, scope, side-effect authority, tools, output contract, and stop conditions. Make the smallest useful GPT-5.6 rewrite:

- State each rule once and remove contradictions, obsolete scaffolding, irrelevant tools, and nonessential examples.
- Describe outcomes and completion criteria instead of prescribing every reasoning step.
- Define autonomy and approval boundaries.
- Specify task-specific response requirements and concrete tone choices.
- Define tool prerequisites, return fields, failure behavior, retries, stopping conditions, and handoffs only when relevant.
- Add validation tied to actual success criteria.

For `CONTEXT_DELTA`, preserve brevity and prior-context references. Clarify only materially ambiguous scope, state the requested change, and preserve earlier constraints and settled decisions. Do not restate the full task, add acceptance criteria, reopen planning, or reprocess unrelated sections. Leaving a precise follow-up unchanged is valid.

For `AMBIGUOUS_REFERENCE`, inspect available conversation, plan, task state, and repository evidence. If still unresolved, ask one focused question in an interactive workflow. For an autonomous artifact, mark the exact unresolved referent and stop rather than guessing.

Do not rewrite an entire working prompt stack merely to make it look cleaner. For migrations, preserve the baseline, make one coherent change at a time, and recommend representative evaluations.

## Separate runtime configuration

Keep model selection, `reasoning.effort`, `reasoning.mode`, `reasoning.context`, `text.verbosity`, prompt caching, and tool registration outside prompt text when they belong in request configuration.

Recommend Pro mode only for difficult, quality-sensitive work where evaluations justify its latency and cost. Do not add instructions to "use pro mode" or "think harder."

Recommend Programmatic Tool Calling only for a bounded, predictable reduction stage. Keep direct tool calls for approval, semantic judgment, citation preservation, and final validation. Define one handoff and prevent repeated work.

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

Add `Runtime settings` only when material. Add `Evaluation notes` only for migrations or recommendations requiring measurement. If the user requests only the prompt, output only the corrected prompt.

Treat bundled guidance as a snapshot. If the user asks for current or verified guidance, consult official OpenAI documentation before relying on it.
