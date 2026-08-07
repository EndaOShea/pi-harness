# Repository context content model

## Root AGENTS.md

Always-loaded orientation:

- purpose
- repository map
- task routing
- verified commands
- global invariants
- global forbidden actions
- documentation links

## Module AGENTS.md

Scoped operational knowledge:

- responsibility
- boundaries/non-responsibilities
- entry points
- local flow
- interfaces/dependencies
- invariants
- narrow tests
- generated assets
- common errors

## README.md

Human-facing introduction:

- value proposition
- quick start
- simple usage
- links to deeper documentation

## docs/architecture.md

System-wide explanation:

- components
- data/control flow
- interfaces
- deployment topology
- cross-cutting concerns

## docs/development.md

Environment and contribution detail.

## docs/testing.md

Test taxonomy, fixtures, dependencies, and commands.

## docs/workflows/*.md

One repeatable procedure per document.

## docs/decisions/*.md

One architecture decision record per decision. Include status, context, decision, consequences, and alternatives.

## .repo-context.yaml

Machine-readable index for automation. It does not replace Markdown documentation.
