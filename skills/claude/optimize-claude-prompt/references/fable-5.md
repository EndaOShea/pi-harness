# Claude Fable 5 prompt profile

Official source: <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5>

Use these rules selectively. Fable 5 is intended for difficult, long-running work; older prescriptive scaffolding can reduce its performance.

## Core behavior

- Give the larger purpose, intended user, and what the output enables, not only the immediate request.
- State action boundaries. Distinguish assessment requests from authorization to change state, and require evidence before state-changing commands.
- At high effort, prohibit unrelated features, cleanup, refactors, speculative abstractions, impossible-case validation, and unnecessary compatibility shims.
- Tell the model to act once it has enough information, avoid re-litigating settled choices, and recommend one path instead of surveying options it will not pursue.
- Use brief, direct behavioral instructions. Strong instruction following usually makes exhaustive lists unnecessary.

## Effort and long runs

- Use `high` for most tasks, `xhigh` for the most capability-sensitive work, and `medium` or `low` for routine or interactive work. Reduce effort when a successful task takes longer than needed.
- Plan for long turns with streaming, generous timeouts, asynchronous status checks, and non-blocking orchestration.
- For autonomous pipelines, explicitly require completion rather than ending with a promise or unnecessary permission request. Pause only for destructive/irreversible actions, real scope changes, or input only the user can provide.
- Avoid exposing a context-token countdown. If the harness must expose one, reassure the model that it should continue rather than proposing a new session solely because of the count.

## Evidence, delegation, and memory

- Ground every progress claim in a tool result from the current run. Report failed tests, skipped steps, and unverified work plainly.
- Delegate genuinely independent subtasks and continue useful work while they run. Prefer long-lived subagents and asynchronous communication for extended programs.
- For long-run verification, establish periodic checks against the specification. Fresh-context verifier subagents can outperform repeated self-critique.
- For recurring work, provide a durable memory location. Store concise confirmed lessons and corrections, update duplicates, and remove invalid notes.

## User communication and harnesses

- Lead final responses with the outcome. Keep them selective but readable; use complete sentences rather than dense shorthand or unexplained internal vocabulary.
- After a long unattended run, write the final response as a re-grounding for a reader who did not follow the tool trace.
- If the application needs verbatim mid-run deliverables or direct replies, provide a dedicated send-to-user tool and explicitly instruct when to call it. Do not route internal reasoning or routine narration through it.
- Do not request hidden reasoning, chain-of-thought, or a transcription of thinking. Ask for decisions, evidence, assumptions, or concise rationale. Reasoning-extraction requests can trigger refusals.

## Safety-aware routing

- Fable 5 applies additional classifiers to offensive cybersecurity, biology/life-sciences, and reasoning-extraction requests. Design the application to handle a `refusal` stop reason and an approved fallback when appropriate.
- Do not weaken safeguards in the prompt. For benign work in affected domains, make authorization, defensive purpose, scope, and desired safe deliverable concrete.

## Avoid

- Assigning only simple benchmark tasks that do not exercise long-horizon capability.
- Overly prescriptive skills copied unchanged from earlier models.
- Fabricated or inference-only progress reports.
- Stopping because the task is long when no user-only blocker exists.
