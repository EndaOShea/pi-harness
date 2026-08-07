# Context-aware task contracts

Use conversation context to decide whether the latest prompt is a task, an amendment, or an unresolved reference. Semantic context outranks keywords.

## Build the effective task

Compile, without inventing:

```text
effective task =
    original task contract
  + explicit later corrections
  + accepted decisions
  + verified completed and outstanding state
  + latest user delta
```

Model-specific guidance is an execution layer applied after this contract. It cannot change the contract unless the user explicitly asks.

Use only context actually available to the optimizer:

- target model and runtime;
- initial task prompt;
- relevant recent turns;
- explicit user corrections and accepted decisions;
- current plan or task-state record;
- verified completed and unresolved work;
- repository or tool evidence;
- latest user message.

Do not reconstruct missing turns from inference.

## Classify the latest prompt

### FULL_TASK

Use when the prompt stands alone or clearly starts/replaces the task. Phrases such as "new task," "separately," "ignore the previous task," or "start over" are evidence, not definitive rules.

Apply the full model-specific optimization while preserving requirements.

### CONTEXT_DELTA

Use when the prompt intentionally relies on active context. Common signals include "now," "also," "instead," "continue," "next," "use that," "apply this," "same for," and "remaining," but decide from meaning.

Preserve the compact follow-up form. A useful expansion, only when needed, is:

```text
Continue from the current task state.

Apply this change:
- [precise latest delta]

Preserve the previously established scope, constraints, acceptance criteria,
settled decisions, and unrelated working behavior.

Do not reopen completed decisions unless this change creates a direct conflict.
```

Omit any line that adds no value. Do not repeat the original specification or model guidance already active in context.

### AMBIGUOUS_REFERENCE

Use when a referent such as "that," "the other one," or "make it better" cannot be identified reliably.

Inspect available conversation, plan, state, and repository evidence. If the referent remains unclear:

- interactive workflow: ask one focused clarification;
- autonomous artifact: retain an explicit `[UNRESOLVED: ...]` marker and block execution at that dependency.

Never choose a plausible referent merely to keep moving.

## Maintain compact state when useful

For long workflows or handoffs, use this state shape when the user or host requests state maintenance:

```markdown
# Active task

## Original objective
## Frozen constraints
## Accepted decisions
## Completed
## Current work
## Outstanding
## Latest user amendment
```

Update it from explicit conversation and verified tool results. Do not silently create or mutate a state file. The state is a compact derivative of the task contract, not authority to override it.

## Avoid repeat processing

Recognize previously corrected prompt structures, active model-execution blocks, and prior transformation metadata. On later turns:

- apply only the new delta;
- do not nest another full wrapper;
- do not duplicate model guidance;
- leave settled requirements untouched;
- return no change when the follow-up is already precise.
