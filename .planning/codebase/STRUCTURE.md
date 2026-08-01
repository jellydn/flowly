# Codebase Structure

**Analysis Date:** 2026-08-01

## Directory Layout

```text
flue-repo-assistant/
├── agents/                 # Flue agent composition and model-facing prompt
├── tools/                  # Repository reader, contracts, registry, and search tools
├── planner/                # Plan lifecycle, execution, replanning, reflection
├── investigation/          # Shared execution loop, evidence, citations, answers
├── reliability/            # Invocation seam, retry, timeout, validation, fallback
├── tests/                  # Native node:test suites and temporary fixtures
├── demo/                   # Deterministic doc-aware and reliability demos
├── eval/                   # Live evaluation runner and sample repository
├── skills/                 # Packaged Flue Agent Skill
├── docs/                   # Static showcase HTML
├── .github/workflows/      # CI workflow
├── app.ts                  # Flue route map
├── sandbox.ts              # Restricted in-memory sandbox
├── flue.config.ts          # Flue runtime target
├── vite.config.ts          # Flue Vite integration
├── package.json            # Scripts and dependencies
├── tsconfig.json           # Strict TypeScript configuration
└── README.md               # User-facing documentation
```

## Responsibility Directories

**`agents/`**
- `repo-assistant.ts`: creates the repository reader, budget, reliability settings, `InspectionRegistry`, planning tools, sandbox, skill, and model configuration.

**`tools/`**
- `contracts.ts`: canonical inspection/planner names and shared output/evidence limits.
- `repository.ts`: `RepositoryReader`, path confinement, file discovery, shared budget, and debug logging.
- `inspection-registry.ts`: constructs and orders the four reliable inspection tools.
- `repository-search.ts` and `search-utils.ts`: shared bounded source/documentation search policy and matching.
- `list-files.ts`, `read-file.ts`, `search-code.ts`, `search-docs.ts`: model-facing typed tool factories.

**`planner/`**
- `plan-run.ts`: deep plan lifecycle state and shared execution/replan/reflection behavior.
- `plan-store.ts`: narrow compatibility interface and legacy result-preservation adapters.
- `planner.ts`: deterministic plan generation and `create_plan` tool.
- `executor.ts`: programmatic plan execution and `replan` tool.
- `reflection.ts`: reflection calculation/formatting and `reflect_plan` tool.
- `types.ts`: plan, step, result, status, and reflection types.

**`investigation/`**
- `tool-call.ts`: generic bounded execution-loop protocol.
- `tool-execution.ts`: normalized tool outcomes, resolution, metadata, cancellation, and compatibility exports.
- `loop.ts`: deterministic investigation adapter.
- `evidence.ts`, `answer.ts`, `call-tracker.ts`, `types.ts`: evidence, citations, confidence, duplicate-call prevention, and domain types.

**`reliability/`**
- `tool-invocation.ts`: Flue v2 context/envelope normalization.
- `resilient-tool.ts`: reliable inspection-tool construction and execution.
- `retry.ts`, `errors.ts`, `validation.ts`, `fallback.ts`, `observability.ts`, `failure-injection.ts`: policy and support modules.

**`tests/`**
- `tools.test.ts`, `repository.test.ts`: repository safety, tool contracts, and budgets.
- `planner.test.ts`: plan lifecycle, execution, replanning, reflection, and cancellation.
- `tool-execution.test.ts`: invocation metadata, cancellation, callback behavior, and compatibility exports.
- `inspection-registry.test.ts`: registry order, tool construction, shared budget, and live tool behavior.
- `repository-search.test.ts`: search scopes and pre-cancellation.
- `doc-aware.test.ts`: documentation search, investigation, evidence, citations, and confidence.
- `reliability.test.ts`: classification, retries, timeouts, validation, fallback, logging, and failure injection.
- `eval-scenarios.test.ts`: deterministic expected tool sequences.
- `helpers.ts`: temporary fixture repository, tool contexts, and envelope unwrapping.

## Key Locations

- Agent entrypoint: `agents/repo-assistant.ts`.
- Route map: `app.ts`.
- Runtime/build config: `flue.config.ts`, `vite.config.ts`, `tsconfig.json`.
- User configuration: `.env.example`, `README.md`, `AGENTS.md`.
- CI: `.github/workflows/ci.yml`.
- Skill: `skills/analyzing-repositories/SKILL.md`.
- Codebase map: `.planning/codebase/`.

## Naming Conventions

- Lowercase descriptive filenames; tool files use kebab-case (`search-code.ts`).
- Tests use `<area>.test.ts`.
- Directories are lowercase responsibility names.
- Functions use descriptive verb-first camelCase; factories use `create*`.
- Exported types use PascalCase; finite states use string unions.
- Shared constants use `UPPER_SNAKE_CASE`.

## Where to Add Code

- New repository capability: add a focused tool under `tools/`, update `tools/contracts.ts` if names/limits change, register through `InspectionRegistry`, and add safety/reliability tests.
- New plan behavior: add lifecycle logic to `planner/plan-run.ts` or an adjacent planner module; preserve `PlanStore` compatibility where needed.
- New execution protocol: extend the shared execution seam rather than duplicating invocation logic in an adapter.
- New reliability behavior: add to `reliability/` with deterministic injected-failure tests.
- New evidence behavior: add to `investigation/` with citation/confidence tests.

## Generated and Local State

- `dist/`, `.flue-vite/`, and `coverage/` are generated and ignored.
- `.env` is user-managed and ignored; `.env.example` is committed.
- `.freebuff/` is local desktop state and remains unrelated to application source.
- `.planning/codebase/` is generated documentation; this refresh does not commit it automatically.

---

*Structure analysis: 2026-08-01*
