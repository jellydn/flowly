# Architecture

**Analysis Date:** 2026-08-02

## Pattern Overview

**Overall:** Layered, tool-driven agent architecture with bounded read-only ports and a trusted PR-review adapter

**Key Characteristics:**
- Two Flue agents are composed at the application boundary: a plan-execute-reflect repository assistant and a stateful incremental PR reviewer, both mounted through `app.ts`.
- Model-facing repository access is capability-based and read-only: `sandbox.ts` removes shell/filesystem tools while `tools/` exposes four typed, confined, budgeted inspection operations.
- Side effects are isolated behind trusted application code: Git and GitHub access live in `review/pr-data.ts`, `github/client.ts`, and `github/adapter.ts`, never in the model sandbox.
- Cross-cutting planning, deterministic investigation, retry, validation, evidence, and observability modules are dependency-injected and independently testable.

## Layers

**HTTP and Flue Routing Layer:**
- Purpose: Expose agent endpoints and a health endpoint through Hono/Flue routing.
- Location: `app.ts`
- Contains: Hono application creation, `createAgentRouter` mounts, and `/api/ping`.
- Depends on: `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`, `@flue/runtime/routing`, and `hono` supplied by the Flue runtime.
- Used by: Flue/Vite runtime builds and HTTP consumers.

**Agent Composition Layer:**
- Purpose: Construct per-run dependencies, register models/tools/skills/sandbox, and provide the model's operating protocol.
- Location: `agents/`
- Contains: `RepoAssistant()` in `agents/repo-assistant.ts` and `PrReviewer()` in `agents/pr-reviewer.ts`.
- Depends on: `tools/`, `planner/`, `reliability/`, `review/`, `github/`, `sandbox.ts`, and `skills/analyzing-repositories/SKILL.md`.
- Used by: `app.ts`, `npm start`, direct `flue run`, and `scripts/review-pr.ts`.

**Sandbox and Capability Boundary:**
- Purpose: Preserve Flue's required session environment while removing default model-facing shell and filesystem capabilities.
- Location: `sandbox.ts`
- Contains: A `just-bash` in-memory session factory and an empty model-facing tool list.
- Depends on: `@flue/runtime` and `just-bash`.
- Used by: Both agents in `agents/repo-assistant.ts` and `agents/pr-reviewer.ts`.

**Repository Inspection Layer:**
- Purpose: Confine repository paths, walk/read text safely, search source or documentation, enforce output limits, and account for inspection calls.
- Location: `tools/`
- Contains: `RepositoryReader`, `StepBudget`, tool contracts/factories, shared search mechanics, and `InspectionRegistry`.
- Depends on: Node read-only filesystem APIs, Valibot, Flue tool definitions, and reliability wrappers in `reliability/`.
- Used by: Both agents, deterministic investigation code, demos, evals, and tests.

**Planning Layer:**
- Purpose: Represent and manage plan creation, execution, replanning, and post-execution reflection without consuming inspection budget.
- Location: `planner/`
- Contains: `PlanRun`, `PlanStore`, plan/result types, deterministic planner/executor functions, and model-facing `create_plan`, `replan`, and `reflect_plan` tools.
- Depends on: Canonical tool names in `tools/contracts.ts`, budgets/debug logging in `tools/repository.ts`, and the execution protocol in `investigation/tool-call.ts`.
- Used by: `agents/repo-assistant.ts`, planner tests, and deterministic callers.

**Investigation and Evidence Layer:**
- Purpose: Provide a bounded deterministic observe-act loop, normalize tool execution, prevent duplicate calls, collect evidence, and produce citation/confidence-based answers.
- Location: `investigation/`
- Contains: `runExecutionLoop`, `runInvestigation`, tool-resolution/execution adapters, `EvidenceCollector`, `CallTracker`, answer formatting, and domain types.
- Depends on: Flue tool definitions, `reliability/tool-invocation.ts`, `tools/contracts.ts`, and `tools/repository.ts`.
- Used by: `planner/plan-run.ts`, `demo/doc-aware-demo.ts`, and investigation/planner tests; the live repository agent follows the same workflow through its prompt and model-facing tools.

**Reliability Layer:**
- Purpose: Wrap logical inspection calls with timeout, transient retry/backoff, output validation, safe error classification, failure injection, and structured logging.
- Location: `reliability/`
- Contains: Error taxonomy, retry policy, reliable tool wrapper, Flue invocation seam, output validators, optional fallback, observability, and test/demo failure injection.
- Depends on: Flue tool definitions and repository budget/debug abstractions.
- Used by: `tools/inspection-registry.ts`, investigation execution, demos, and tests.

**PR Review Domain Layer:**
- Purpose: Model PR diffs and review results, filter non-reviewable files, load trusted PR data, expose review tools, and persist incremental review state.
- Location: `review/`
- Contains: Unified-diff parsing, file classification, configurable limits, `PrDataSource`, review schemas, review tool factories, and hidden-comment state/store modules.
- Depends on: Node `child_process`, Valibot, repository context tools, and `github/client.ts`.
- Used by: `agents/pr-reviewer.ts`, `github/adapter.ts`, and PR-review tests.

**GitHub Integration and Mutation Layer:**
- Purpose: Hold credentials, call narrowly scoped GitHub REST endpoints, validate model output against the actual diff, and post one safe review.
- Location: `github/`
- Contains: Fetch-based `GitHubClient`, `GitHubApiError`, and `createReviewPublisher`.
- Depends on: `review/diff.ts`, `review/schema.ts`, `review/limits.ts`, and `review/review-state-store.ts`.
- Used by: `agents/pr-reviewer.ts`; invoked operationally by `scripts/review-pr.ts` and `.github/workflows/pr-review.yml`.

**Guidance, Demo, Evaluation, and Documentation Layer:**
- Purpose: Encode repository-analysis behavior, demonstrate deterministic/live flows, provide a fixture repository, and document the project.
- Location: `skills/`, `demo/`, `eval/`, `docs/`, `README.md`, `AGENTS.md`
- Contains: The packaged analysis skill, demo scripts, evaluation runner/fixture, static showcase, and contributor/user documentation.
- Depends on: Public agent/tool APIs and npm scripts.
- Used by: The repository assistant, developers, evaluators, and project users.

## Data Flow

**Repository Assistant Request:**
1. Flue invokes `RepoAssistant()` from `agents/repo-assistant.ts` through `npm start`, direct CLI execution, or `/agents/repo-assistant` in `app.ts`.
2. Composition resolves `REPOSITORY_PATH`, creates `RepositoryReader`, one shared `StepBudget`, reliability configuration, `PlanRun`, and the four-tool `InspectionRegistry`.
3. The model calls `create_plan`, then `list_files`, `read_file`, `search_code`, and/or `search_docs`; each logical inspection consumes one budget slot while internal retries do not.
4. `RepositoryReader` canonicalizes paths, rejects escapes/symlinks/oversized or binary files, and returns bounded repository-relative results; searches use `tools/repository-search.ts` and `tools/search-utils.ts`.
5. The model optionally calls `replan`, calls `reflect_plan`, and returns an evidence-grounded answer with citations and confidence under instructions from `agents/repo-assistant.ts` and `skills/analyzing-repositories/SKILL.md`.

**Deterministic Investigation:**
1. A caller such as `demo/doc-aware-demo.ts` supplies tools, a `StepBudget`, and a deterministic `DecisionFn` to `runInvestigation()` in `investigation/loop.ts`.
2. `runExecutionLoop()` bounds iterations and delegates calls to `executeToolCallWithMetadata()`; `CallTracker` blocks identical repeated calls.
3. Successful search/read outputs become bounded, deduplicated `Evidence` entries, and `formatAnswer()` derives citations and confidence; failures are recorded rather than fabricated around.

**First PR Review:**
1. `.github/workflows/pr-review.yml` invokes `npm run review-pr`; `scripts/review-pr.ts` validates environment and launches `agents/pr-reviewer.ts` through Flue.
2. `PrReviewer()` creates `GitHubClient`, `ReviewStateStore`, `PrDataSource`, a context-read budget, review tools, and the trusted publisher.
3. Review tools fetch PR metadata via GitHub and full diff/file content via trusted `git diff`/`git show`; `review/diff.ts` parses file and hunk metadata while `review/filters.ts` marks generated, lock, snapshot, vendored, and binary files to skip.
4. The model inspects changed files and limited repository context, then sends a Valibot-constrained `ReviewResult` to `submit_review` exactly once.
5. `github/adapter.ts` re-validates, caps findings, checks changed paths, clamps inline lines to hunks, posts `COMMENT` or `REQUEST_CHANGES`, and stores the reviewed SHA/findings in a bot-authored hidden issue comment.

**Incremental PR Review:**
1. On a later `synchronize` event, `review/review-state-store.ts` loads only a state comment authored by the configured bot and `review/review-state.ts` safely parses it.
2. `review/pr-data.ts` computes `git diff previousReviewedSha...HEAD_SHA`; an unreachable previous SHA degrades to first-review behavior.
3. The model focuses on the incremental changes, classifies prior findings, re-raises still-present issues, and submits the new structured review.
4. The publisher renders classifications and best-effort updates the hidden state comment without turning a post-review state-write failure into a duplicate-review retry.

**State Management:**
- Agent-run configuration, repository caches, budgets, plan/results/reflection, evidence, and call history are in-memory closures or objects scoped to one invocation.
- `review/pr-data.ts` caches the full diff, parsed files, metadata, and prior state for one review run.
- Cross-run PR state is the sole persistent application state: a schema-validated hidden GitHub issue comment containing reviewed head SHA, findings, and timestamp.
- No database, writable repository store, general model filesystem, or application-wide state container is present.

## Key Abstractions

**`RepositoryReader`:**
- Purpose: The canonical read-only boundary around one configured checkout.
- Examples: `tools/repository.ts`, `tools/list-files.ts`, `tools/read-file.ts`
- Pattern: Repository/facade with canonical-path confinement and bounded filesystem operations.

**`InspectionRegistry`:**
- Purpose: Construct the four raw inspection tools once, apply a uniform reliability policy, and expose one ordered registration list.
- Examples: `tools/inspection-registry.ts`, `agents/repo-assistant.ts`
- Pattern: Registry plus composition root.

**`StepBudget`:**
- Purpose: Enforce a shared mutable call limit and expose snapshots in tool results/errors.
- Examples: `tools/repository.ts`, `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`
- Pattern: Explicitly injected quota/capability object.

**`PlanRun`:**
- Purpose: Own plan lifecycle state and deterministic execution, replan, and reflection transitions.
- Examples: `planner/plan-run.ts`, `planner/plan-store.ts`, `planner/executor.ts`
- Pattern: Stateful deep module behind a narrow compatibility interface.

**`ExecutionLoopAdapter`:**
- Purpose: Separate generic bounded iteration/invocation from planner- or investigation-specific decisions and result handling.
- Examples: `investigation/tool-call.ts`, `investigation/loop.ts`, `planner/plan-run.ts`
- Pattern: Strategy/adapter around a shared execution loop.

**`EvidenceCollector`:**
- Purpose: Store bounded, deduplicated, source-classified evidence and support grounded confidence calculation.
- Examples: `investigation/evidence.ts`, `investigation/answer.ts`
- Pattern: Collector with value-based deduplication.

**`PrDataSource`:**
- Purpose: Present trusted PR metadata, diff, hunks, changed-file reads, and prior state through an injectable interface.
- Examples: `review/pr-data.ts`, `review/review-tools.ts`
- Pattern: Ports-and-adapters data-source interface with production Git/GitHub adapter and test fakes.

**`ReviewResult`:**
- Purpose: Define the only model output accepted for GitHub review publication.
- Examples: `review/schema.ts`, `review/review-tools.ts`, `github/adapter.ts`
- Pattern: Schema-first boundary DTO validated both at tool input and mutation boundary.

**`ReviewStateStore`:**
- Purpose: Load/update trusted incremental-review state while preventing untrusted comment spoofing.
- Examples: `review/review-state-store.ts`, `review/review-state.ts`
- Pattern: Store interface backed by a bot-authenticated hidden GitHub comment.

## Entry Points

**HTTP Application:**
- Location: `app.ts`
- Triggers: Vite/Flue runtime loading the default Hono application.
- Responsibilities: Mount `/agents/repo-assistant`, `/agents/pr-reviewer`, and `/api/ping`.

**Repository Assistant CLI/Agent:**
- Location: `agents/repo-assistant.ts`
- Triggers: `npm start -- --input ...`, `npx flue run agents/repo-assistant.ts -m ...`, or its HTTP route.
- Responsibilities: Compose the model, planner, bounded reliable inspection tools, restricted sandbox, analysis skill, and repository-assistant prompt.

**PR Reviewer CLI/Agent:**
- Location: `scripts/review-pr.ts`, `agents/pr-reviewer.ts`
- Triggers: `npm run review-pr` locally or the pull-request events in `.github/workflows/pr-review.yml`.
- Responsibilities: Validate PR environment, compose trusted Git/GitHub boundaries and review tools, inspect a full/incremental diff, and terminate after one submitted review.

**Deterministic Demo:**
- Location: `demo/doc-aware-demo.ts`, `demo/doc-aware-demo.sh`
- Triggers: `npx tsx demo/doc-aware-demo.ts` or the shell wrapper.
- Responsibilities: Exercise the investigation/tool/evidence flow against `eval/fixtures/sample-repo/` without an LLM.

**Evaluation Runner:**
- Location: `eval/run-eval.sh`
- Triggers: Direct shell execution with a provider key.
- Responsibilities: Run five model-driven tool-selection scenarios against the committed fixture with debug logging.

**Build and Verification:**
- Location: `package.json`, `vite.config.ts`, `flue.config.ts`
- Triggers: `npm run check`, `npm test`, `npm run typecheck`, and `npm run build`.
- Responsibilities: Typecheck strict TypeScript, run native Node tests through `tsx`, and package the route/agents with the Flue Vite plugin.

## Error Handling

**Strategy:** Fail closed at trust boundaries, retry only classified transient inspection failures, preserve cancellation as exceptional, degrade safely when optional state/incremental context is unavailable, and report insufficient evidence rather than guessing.

**Patterns:**
- `reliability/errors.ts` maps raw filesystem/network/status failures to stable retryable/non-retryable categories and user-safe messages; `reliability/retry.ts` applies per-attempt timeout and exponential backoff with jitter.
- `reliability/resilient-tool.ts` consumes one budget slot per logical call, validates bounded outputs, prevents double wrapping, and attaches budget snapshots to errors.
- Repository path traversal, absolute paths, escaping symlinks, binary data, oversized files, invalid line ranges, and exhausted budgets are rejected by `tools/repository.ts` and individual tool schemas.
- `review/schema.ts` and `github/adapter.ts` validate review output twice; invalid/unpostable findings are dropped to the body, and a GitHub 422 from inline comments is retried once as a body-only review.
- Corrupt/missing review state returns `null`; unreachable incremental SHAs fall back to a full-review signal; state-save failure after posting is non-fatal to avoid duplicate reviews.

## Cross-Cutting Concerns

**Logging:** `tools/repository.ts` and `reliability/observability.ts` emit opt-in, stderr-only safe summaries under `REPO_ASSISTANT_DEBUG`; logs omit file contents, secrets, absolute paths, and model reasoning. `scripts/review-pr.ts` emits orchestration status with a `[flue-review]` prefix.

**Validation:** Valibot schemas validate every model-facing tool input and the structured review contract; `tools/contracts.ts`, `review/limits.ts`, repository confinement, reliability output validators, and trusted diff checks enforce size, count, path, and line bounds outside model instructions.

**Authentication:** General repository analysis has no application authentication and no network capability. PR automation keeps `GITHUB_TOKEN` private inside `GitHubClient`, uses Bearer authentication against GitHub's REST API, relies on workflow-scoped permissions in `.github/workflows/pr-review.yml`, and accepts persisted review state only from `REVIEW_BOT_LOGIN` (default `github-actions[bot]`). LLM provider authentication is supplied through environment variables such as `OPENROUTER_API_KEY` and handled by Flue, not custom tools.

---

*Architecture analysis: 2026-08-02*
