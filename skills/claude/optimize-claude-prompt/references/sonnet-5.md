# Claude Sonnet 5 prompt profile

Official source: <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5>

Use these rules selectively. Prefer changing the runtime setting named here over adding compensating prose to the prompt.

## Core behavior

- Expect response length to scale with task complexity. Specify a required length, structure, voice, or example when the output contract matters.
- Expect literal and explicit instruction following, especially at lower effort. State when an instruction applies to every item, section, file, or turn; do not rely on silent generalization.
- Provide the task, intent, constraints, and relevant context early for autonomous coding work. Well-specified first turns reduce follow-up interactions.
- Use positive examples to calibrate style and concision when exact presentation matters.

## Effort and thinking

- Use `high` for most tasks and `xhigh` for the hardest coding or agentic work. Use `medium` for cost-sensitive work and `low` only for short, scoped, latency-sensitive tasks.
- Raise effort before adding elaborate "think harder" instructions when complex work is shallow. At a deliberately low effort, one targeted multistep-reasoning instruction can help.
- Adaptive thinking is the supported default. Do not configure a manual thinking-token budget.
- Leave ample `max_tokens` headroom at high or greater effort for reasoning, tool calls, and the final response. Revisit limits inherited from earlier Sonnet versions.
- Prefer thinking enabled at a lower effort over disabling thinking for workloads that need tools or reasoning.

## Tools and progress

- Define when and why to use each important tool if tool selection is part of success, especially when thinking is disabled.
- Do not force progress updates at a fixed tool-call cadence. Describe the desired content and frequency only when the native updates do not fit the product.
- For interactive coding agents, favor `high` or `xhigh`, provide a complete brief, and minimize unnecessary user round trips.

## Workload-specific adjustments

- Code review: ask for broad issue coverage first, with confidence and severity, then filter or rank separately. If filtering in one pass, define a concrete inclusion threshold instead of saying only "important" or "high severity."
- Frontend/design: give a concrete visual direction, palette, typography, layout, and interaction language. For variety, ask for several distinct directions and have the user choose; do not depend on sampling temperature.
- Style: express tone and variation in prompt text. Non-default `temperature`, `top_p`, and `top_k` are not accepted for Sonnet 5.
- Computer use: 1080p is a strong default balance; consider lower resolutions for cost-sensitive workloads.

## Avoid

- Implicitly applying an example or constraint beyond the item it names.
- Legacy manual thinking budgets.
- Tight output budgets that leave no room for adaptive thinking.
- Vague visual guidance that merely swaps one generic house style for another.
