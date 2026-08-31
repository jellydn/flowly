# Codebase Structure

**Analysis Date:** 2026-08-04

## Directory Layout

```
flowly/
├── agents/            # Flue agent definitions (repo assistant, PR reviewer, factory implementer)
├── tools/             # Read-only inspection tool factories + repository reader
├── investigation/     # Deterministic evidence-collection loop
├── planner/           # Plan → execute → reflect meta-tools
├── reliability/       # Retry / timeout / validation / failure-injection wrappers
├── review/            # PR review tools, schema, filters, limits, state
├── factory/           # Issue intake, state orchestration, isolated mutation, independent review, draft PR
├── github/            # Trusted GitHub client/adapter + event router
├── index/             # TF-IDF and relationship repository indexes
├── scripts/           # CLI entrypoints (review-pr, route-event, flue-eval)
├── eval/              # Capstone eval + benchmark framework + fixtures
├── demo/              # Deterministic demos (bash + ts)
├── docs/              # Hand-maintained docs page + ADRs
├── skills/            # Flue skills (analyzing-repositories)
├── tests/             # Node test-runner tests (47 files + helpers)
├── .planning/         # Codebase map + internal planning docs
├── .github/workflows/ # CI + review + example workflows
├── sandbox.ts         # Empty toolset replacing default FS/shell tools
├── app.ts             # Flue 2 route map
├── flue.config.ts     # Flue config (target: node)
└── vite.config.ts     # @flue/vite build integration
```

## Directory Purposes

**`agents/`:**

- Purpose: Model-facing agents
- Contains: `repo-assistant.ts`, `pr-reviewer.ts`, `factory-implementer.ts`
- Key files: all three agent factories

**`tools/`:**

- Purpose: Read-only inspection tools and the repository boundary
- Contains: `list-files.ts`, `read-file.ts`, `search-code.ts`, `search-docs.ts`, `retrieve.ts`, `related-context.ts`, `search.ts` (scope-parameterized search factory), `repository.ts`, `contracts.ts`, `inspection-registry.ts`, `repository-search.ts`, `search-utils.ts`, `result-stats.ts`
- Key files: `repository.ts` (`RepositoryReader`, `StepBudget`), `contracts.ts` (`TOOL_LIMITS`)

**`investigation/`:**

- Purpose: Deterministic bounded loop with evidence, dedup, citations
- Contains: `loop.ts`, `types.ts`, `evidence.ts`, `answer.ts`, `call-tracker.ts`, `tool-execution.ts`, `tool-call.ts`
- Key files: `loop.ts` (`runInvestigation`), `types.ts`

**`planner/`:**

- Purpose: Plan/execute/reflect workflow, budget-free meta-tools
- Contains: `planner.ts`, `plan-run.ts`, `plan-store.ts`, `reflection.ts`, `types.ts`
- Key files: `planner.ts` (`create_plan`), `plan-run.ts` (programmatic executor + replan lifecycle)

**`reliability/`:**

- Purpose: Cross-cutting resilience and observability
- Contains: `resilient-tool.ts`, `retry.ts`, `fallback.ts`, `fallback-tool.ts` (search→read fallback seam), `errors.ts`, `validation.ts`, `observability.ts`, `failure-injection.ts`, `tool-invocation.ts`
- Key files: `resilient-tool.ts`, `errors.ts`

**`review/`:**

- Purpose: PR review domain (tools, schema, state, filters, limits)
- Contains: `review-tools.ts`, `schema.ts`, `pr-data.ts`, `diff.ts`, `filters.ts`, `limits.ts`, `review-state.ts`, `review-state-store.ts`, `specialists.ts`, `advisor.ts`, `model-runners.ts`, `pipeline.ts`
- Key files: `schema.ts` (ReviewResult), `pipeline.ts` (specialist/advisor orchestration), `review-tools.ts`

**`factory/`:**

- Purpose: Typed issue-to-PR run state and trusted implementation, review, and draft-PR boundaries
- Contains: `types.ts`, `schema.ts`, `store.ts`, `run-state-store.ts`, `orchestrator.ts`, `intake.ts`, `plan.ts`, `run.ts`, `dispatch.ts`, `defaults.ts`, `model.ts`, `model-adapters.ts`, `agent-implementer.ts`, `git.ts`, `implementation.ts`, `verification.ts`, `review.ts`, `publisher.ts`, `pipeline.ts`
- Key files: `orchestrator.ts` (monotonic run transitions), `plan.ts` (read-only analyst stage), `run.ts` (end-to-end factory pipeline), `git.ts` (isolated factory-only Git mutation), `pipeline.ts` (independent review + draft PR coordinator)

**`github/`:**

- Purpose: Trusted GitHub boundary — client, adapter, and event router
- Contains: `client.ts`, `adapter.ts`, `events/` (types, config, payloads, router, dedupe, logger, index)
- Key files: `adapter.ts` (trusted publisher), `events/config.ts`, `events/router.ts`

**`index/`:**

- Purpose: Repository-local indexes for semantic retrieval and explicit relationships
- Contains: `repository-indexer.ts`, `repository-relationship-index.ts`
- Key files: both index implementations

**`scripts/`:**

- Purpose: CI entrypoints
- Contains: `review-pr.ts`, `run-factory.ts`, `route-event.ts`, `flue-eval.ts`, `check-doc-tree.ts`
- Key files: all three

**`eval/`:**

- Purpose: Evaluation — capstone suite + benchmark framework + fixture
- Contains: `capstone-eval.ts`, `bench/` (types, schema, config, metrics, store, runner, judge, providers, model-loop, patch, index), `benchmarks/sample.json`, `fixtures/sample-repo/`, `run-eval.sh`, `run-capstone-eval.sh`, `README.md`
- Key files: `bench/runner.ts`, `bench/schema.ts`, `capstone-eval.ts`

**`demo/`:**

- Purpose: Deterministic, key-free demos
- Contains: `doc-aware-demo.ts/.sh`, `reliability-demo.sh`, `capstone-demo.ts/.sh`
- Key files: `doc-aware-demo.ts`

**`docs/`:**

- Purpose: Hand-maintained docs
- Contains: `index.html`, `adr/` (0001–0005, README, template), `showcase/` (three-page product showcase: `showcase/index.html`, `showcase/features.html`, `showcase/how-it-works.html`, `showcase/styles.css`, `showcase/favicon.svg`), favicon package (`favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest`)
- Key files: `index.html`, `adr/0001-event-router.md`, `adr/0002-model-eval-benchmark.md`, `adr/0003-tool-composition-seam.md`, `adr/0004-live-eval-provider-seam.md`, `adr/0005-transcript-based-showcase.md`

**`tests/`:**

- Purpose: All automated tests (single directory, not co-located)
- Contains: 47 `.test.ts` files + `helpers.ts` (fixture builders, tool invocation)
- Key files: `helpers.ts`, `event-router.test.ts`, `bench-runner.test.ts`

## Key File Locations

**Entry Points:**

- `agents/repo-assistant.ts`: general repo assistant agent
- `agents/pr-reviewer.ts`: PR review agent
- `agents/factory-implementer.ts`: isolated writable factory implementation agent
- `scripts/review-pr.ts`: CI review entrypoint
- `scripts/route-event.ts`: CI event-router entrypoint
- `scripts/flue-eval.ts`: benchmark CLI
- `eval/capstone-eval.ts`: capstone suite entrypoint
- `app.ts`: Flue route map

**Configuration:**

- `flue.config.ts`: Flue target
- `vite.config.ts`: build
- `tsconfig.json`: strict TS config
- `prek.toml` + `.oxlintrc.json` + `.oxfmtrc.json`: lint/format contract
- `package.json`: scripts/deps
- `.env.example`: all environment variables

**Core Logic:**

- `tools/repository.ts`: repository boundary + budget
- `investigation/loop.ts`: investigation loop
- `reliability/resilient-tool.ts`: resilience wrapper
- `factory/implementation.ts`: controlled implementation stage
- `factory/git.ts`: trusted factory Git mutation boundary
- `factory/pipeline.ts`: independent review + draft PR stage
- `github/adapter.ts`: trusted review publisher
- `eval/bench/runner.ts`: benchmark execution

**Testing:**

- `tests/` (all), `tests/helpers.ts` (fixtures)

## Naming Conventions

**Files:**

- kebab-case for modules (`list-files.ts`, `search-code.ts`, `review-tools.ts`)
- `*.test.ts` for tests, co-located under `tests/`
- Factories named `createXxx.ts` pattern inside files, not file names

**Directories:**

- Singular lowercase (`tools/`, `agents/`, `review/`); `github/events/` nests the event-router subdomain; `eval/bench/` nests the framework

## Where to Add New Code

**New Feature:**

- Primary code: a new factory module under the relevant domain dir (e.g. `tools/`, `review/`, `github/events/`), exported from its `index.ts` barrel where one exists
- Tests: `tests/<feature>.test.ts` using `tests/helpers.ts`

**New Component/Module:**

- Implementation: its own directory with an `index.ts` barrel (e.g. `github/events/`, `eval/bench/`) or a single file in the matching domain dir

**Utilities:**

- Shared helpers: `tools/search-utils.ts`, `reliability/`, or a new module in the owning domain; `tests/helpers.ts` for test utilities

## Special Directories

**`.planning/`:**

- Purpose: Codebase map (this file set) and internal planning docs
- Generated: Yes (by the codemap skill / manual refresh)
- Committed: Yes

**`eval/fixtures/`:**

- Purpose: Bundled deterministic fixture repository (sample-repo) with intentional noise (node_modules/ignored.js) that tools must skip
- Generated: No
- Committed: Yes (kept unformatted; lint hooks exclude it)

**`dist/`:**

- Purpose: Vite build output
- Generated: Yes
- Committed: No (gitignored)

**`.github/workflows/*.example`:**

- Purpose: Example workflows (`event-router.example`, `eval.example`) deliberately not `.yml` so Actions does not run them
- Generated: No
- Committed: Yes

---

_Structure analysis: 2026-08-04_
