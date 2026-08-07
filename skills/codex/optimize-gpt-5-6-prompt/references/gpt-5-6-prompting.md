# GPT-5.6 prompting profile

Official source: <https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices>

Snapshot reviewed: 2026-07-28.

Apply only the guidance relevant to the workload. Do not turn every item into boilerplate.

## Lean prompts

- Begin with a prompt and tool set that already works. Remove one instruction group, example set, or tool group at a time and rerun the same evaluations.
- State each instruction once.
- Keep tool descriptions concise and precise, and expose only task-relevant tools.
- Retain examples and style rules that encode product requirements or correct measured failures.
- Watch repeated prompt and tool content as conversations grow.

## Autonomy and approval

- Distinguish read-only requests such as answering, reviewing, diagnosing, and planning from requests that authorize changes.
- For change, build, or fix requests, permit in-scope local edits and relevant non-destructive validation without unnecessary permission checks.
- Require confirmation for external writes, destructive actions, purchases, or material scope expansion.
- Name safe local actions when ambiguity would cause unnecessary pauses. Keep the policy in one place rather than repeating "ask first" rules.

## Response length and tone

- GPT-5.6 is relatively concise by default. Remove blanket brevity instructions when they make required content disappear.
- Use `text.verbosity` for the default detail level when supported, then specify task-specific length, structure, and required content in the prompt.
- For short answers, identify what must remain: conclusions, required facts, evidence, material caveats, decisions, and next actions. Trim introductions, repetition, reassurance, and optional background first.
- Define tone through observable choices: directness, acknowledgment of problems, reassurance, formality, and sign-offs.

## Pro mode

- Use Pro mode selectively for difficult, high-value tasks where a marginal reliability gain matters more than latency and token cost.
- Treat reasoning mode and reasoning effort as independent controls. Compare configurations on representative tasks.
- Enable Pro mode in the API request, not in prompt prose.
- Keep the same outcome-focused prompt: goal, context, constraints, evidence, success criteria, and output format.
- Do not request "pro mode," harder thinking, or multiple hidden candidate answers in the prompt.

## Programmatic Tool Calling

- Use Programmatic Tool Calling for bounded workflows that can reduce many or large tool results through predictable filtering, joining, ranking, deduplication, aggregation, or validation.
- Prefer direct calls when one call is enough, results are small, each result changes the next decision, approval is needed, or citations/native artifacts must survive.
- When both routes exist, state the bounded stage, eligible tools, exact output schema, evidence fields, concurrency, retry and stopping limits, direct-call work, and one handoff.
- Document tool return fields, types, and error behavior. If the return shape is unknown, use a direct call first.
- Validate both the `program_output` and the final assistant message. Resource savings count only when the final response still satisfies existing evaluations.

## General optimization judgment

- Prefer an outcome, success criteria, relevant context, constraints, evidence requirements, output format, and stop conditions over step-by-step reasoning instructions.
- Preserve explicit user values. Use decision rules rather than broad defaults for judgment calls.
- Add the smallest targeted instruction that fixes an observed failure.
- Keep model, reasoning, verbosity, caching, and tool-registration controls in runtime configuration rather than duplicating them in prompt text.
- Validate migrations against representative tasks before attributing a behavior change to the prompt.
