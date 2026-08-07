# Claude Opus 5 prompt profile

Official source: <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5>

Use these rules selectively. Opus 5 already completes, verifies, and self-corrects difficult work well, so remove scaffolding that duplicates those defaults.

## Core behavior

- Give the complete task specification up front for multi-file features, refactors, and end-to-end work, then allow the model to execute.
- Explicitly calibrate visible response length. Lower effort controls reasoning cost, not conversational verbosity.
- Calibrate written artifacts separately: require enough substance without filler sections, redundant summaries, or boilerplate.
- For user-facing updates, specify a light cadence: one sentence before the first tool call, then updates only for important findings or changes in direction. Require the final response to lead with the outcome.

## Effort and thinking

- Start at the default `high`, then sweep effort against evaluations. Use `low` and `medium` freely where quality holds; use `xhigh` for demanding coding and agentic work.
- Keep thinking enabled. For cost-sensitive tasks, thinking enabled at `low` generally performs better than disabled thinking at similar cost.
- If thinking must be disabled, permit a short sentence before tool calls, allow the model to say when no tool fits, and prohibit internal/system XML tags in visible output.
- Do not tell the model not to think or reason; that can worsen visible internal-tag artifacts when thinking is disabled.

## Scope, verification, and correction

- State the intended scope for narrow tasks. Ask the model to make routine judgment calls, finish the requested work, and stop before clearly out-of-scope actions.
- Remove generic requirements to add a final verification step, re-check, double-check, or always use a verifier. Opus 5 already verifies and self-corrects reliably; duplicated checks add cost.
- Ask it to narrate a correction only when the error changes the user's code, conclusion, or decision.
- If the request appears mistaken, instruct the model to give one brief warning and then continue at the requested scope unless different interpretations cause materially different work.

## Delegation and workload-specific adjustments

- Permit subagents only for sizeable, genuinely independent, parallel work. Keep spawn counts low and do not delegate merely to re-check the main model's work.
- Code review: request every finding and filter in a separate pass. Conservative or high-severity-only language can suppress valid issues.
- Vision and UI replication: provide iterative image-analysis, crop, and visual-verification tools; these are a more efficient lever than thinking alone.
- Spreadsheets, slides, and documents: supply the required style, template, or format explicitly.

## Avoid

- Verbosity controls expressed only through effort.
- Mandatory verification scaffolding inherited from older models.
- Broad permission to expand or reinterpret a narrow task.
- Subagents for work the main model can finish in a few tool calls.
