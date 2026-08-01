# Codebase Structure

**Analysis Date:** 2026-08-01

## Directory Layout

```text
flue-repo-assistant/
├── agents/                 # Flue v2 agent composition
├── tools/                  # Repository reader and four inspection tools
├── planner/                # Plan, execute, replan, and reflect abstractions
├── investigation/          # Deterministic bounded loop and evidence answers
├── reliability/            # Retry, timeout, validation, fallback, logging
├── tests/                  # Node test-runner suites and fixture helpers
├── demo/                   # Deterministic doc-aware/reliability demos
├── eval/                   # Evaluation runner and bundled sample repository
├── skills/                 # Flue Agent Skill package
├── docs/                   # Static showcase HTML
├── .github/workflows/      # CI workflow
├── app.ts                  # Flue route map
├── sandbox.ts              # Restricted in-memory sandbox
├── flue.config.ts          # Flue runtime target
├── vite.config.ts          # Flue Vite plugin
├── package.json            # Scripts and dependencies
├── tsconfig.json           # Strict TypeScript config
└── README.md               # User-facing documentation
```

## Directory Purposes

**`agents/`:**
- Purpose: Define the single production agent and its model-facing instructions.
- Contains: `repo-assistant.ts`.
- Key files: `agents/repo-assistant.ts` registers hooks, four inspection tools, three planning tools, sandbox, and skill.

**`tools/`:**
- Purpose: Provide the only application-data access to the configured repository.
- Contains: `RepositoryReader`, shared budget, canonical tool/limit contracts, and list/read/code-search/docs-search tool factories.
- Key files: `tools/contracts.ts`, `tools/repository.ts`, `tools/list-files.ts`, `tools/read-file.ts`, `tools/search-code.ts`, `tools/search-docs.ts`.

**`planner/`:**
- Purpose: Separate model intent from repository inspection and record outcomes.
- Contains: `types.ts`, `plan-store.ts`, `planner.ts`, `executor.ts`, `reflection.ts`.
- Key files: `planner/planner.ts` and `planner/executor.ts`.

**`investigation/`:**
- Purpose: Deterministically model bounded observe → act → reflect behavior for tests/demos.
- Contains: loop, evidence collector, answer formatter, call tracker, and types.
- Key files: `investigation/loop.ts`, `investigation/evidence.ts`, `investigation/answer.ts`.

**`reliability/`:**
- Purpose: Harden tool calls and provide testable failure behavior.
- Contains: error classes, retry policy, validation, resilient wrapper, fallback, observability, and failure injection.
- Key files: `reliability/resilient-tool.ts`, `reliability/retry.ts`, `reliability/validation.ts`.

**`tests/`:**
- Purpose: Unit and integration-style coverage against temporary fixture repositories.
- Contains: separate `.test.ts` suites plus `tests/helpers.ts`.
- Key files: `tests/tools.test.ts`, `tests/planner.test.ts`, `tests/doc-aware.test.ts`, `tests/reliability.test.ts`.

**`demo/`:**
- Purpose: Human-readable deterministic demonstrations.
- Contains: `demo/doc-aware-demo.ts`, `demo/doc-aware-demo.sh`, and `demo/reliability-demo.sh`.

**`eval/`:**
- Purpose: Model-tool-selection evaluation without asserting nondeterministic LLM output.
- Contains: `eval/run-eval.sh`, `eval/README.md`, and `eval/fixtures/sample-repo/`.

**`skills/`:**
- Purpose: Package reusable model guidance for repository analysis.
- Contains: `skills/analyzing-repositories/SKILL.md`.

**`docs/`:**
- Purpose: Static product/project showcase, separate from the runtime route map.
- Contains: `docs/index.html`.

## Key File Locations

**Entry Points:**
- `agents/repo-assistant.ts`: CLI/Flue agent definition.
- `app.ts`: HTTP route map for the Flue agent.
- `demo/doc-aware-demo.ts`: deterministic investigation demo.
- `eval/run-eval.sh`: live model-driven evaluation launcher.

**Configuration:**
- `package.json`: scripts, dependency versions, and Node engine.
- `.env.example`: documented runtime environment variables.
- `tsconfig.json`: strict compiler settings and included source areas.
- `flue.config.ts`: Node runtime target.
- `vite.config.ts`: Flue Vite build integration.
- `.github/workflows/ci.yml`: Node version and CI check sequence.

**Core Logic:**
- `tools/contracts.ts`: canonical tool names and shared inspection/evidence limits.
- `tools/repository.ts`: path confinement, repository traversal, and shared budget.
- `planner/`: planning/execution contracts.
- `investigation/`: evidence loop and answer semantics.
- `reliability/`: resilient tool execution.

**Testing:**
- `tests/helpers.ts`: temporary fixture repository and tool context helpers.
- `tests/tools.test.ts`: tool contracts and safety limits.
- `tests/repository.test.ts`: reader/path/budget behavior.
- `tests/planner.test.ts`: plan lifecycle and execution.
- `tests/doc-aware.test.ts`: documentation search, evidence, confidence, and loop behavior.
- `tests/reliability.test.ts`: error classification, retries, timeout, validation, fallback, and wrapper behavior.
- `tests/eval-scenarios.test.ts`: deterministic evaluation patterns.

## Naming Conventions

**Files:**
- Kebab-case for tool files (`search-code.ts`, `read-file.ts`), lower-case descriptive names for other modules (`repository.ts`, `executor.ts`), and `.test.ts` suffix for tests. See `tools/`, `planner/`, and `tests/`.

**Directories:**
- Lowercase nouns by responsibility: `agents`, `tools`, `planner`, `investigation`, `reliability`, `tests`, and `eval`.

## Where to Add New Code

**New Feature:**
- Primary code: Add the smallest focused module under the relevant responsibility directory; compose it from `agents/repo-assistant.ts` if it becomes model-facing.
- Tests: Add or extend the corresponding suite under `tests/`; use `tests/helpers.ts` for temporary fixtures.

**New Component/Module:**
- Tool: `tools/<tool-name>.ts`, with a factory receiving `RepositoryReader`, `StepBudget`, and `DebugLogger`; register it in `agents/repo-assistant.ts` and add a reliability validator if needed.
- Planning behavior: `planner/` with types in `planner/types.ts` and model-facing registration in the agent.
- Investigation behavior: `investigation/` with evidence/citation tests.
- Reliability behavior: `reliability/` with deterministic injected failures and safe logging.

**Utilities:**
- Shared tool contracts and limits: `tools/contracts.ts`.
- Shared repository/budget helpers: `tools/repository.ts`.
- Shared test fixtures and contexts: `tests/helpers.ts`.

## Special Directories

**`dist/`, `.flue-vite/`, and `coverage/`:**
- Purpose: Generated build, Flue, or coverage artifacts.
- Generated: Yes.
- Committed: No; ignored by `.gitignore`.

**`.env` and `.env.*` except `.env.example`:**
- Purpose: Local secrets/runtime configuration.
- Generated: No, user-managed.
- Committed: No; ignored by `.gitignore`.

**`eval/fixtures/sample-repo/node_modules/`:**
- Purpose: Deliberate dependency noise used to verify ignored-directory behavior.
- Generated: Fixture content, intentionally retained.
- Committed: Yes/kept by explicit `.gitignore` exceptions; skipped at runtime.

**`.planning/codebase/`:**
- Purpose: Fresh onboarding and architecture map generated by this codemap run.
- Generated: Yes.
- Committed: Not automatically; no commit was requested.

---

*Structure analysis: 2026-08-01*
