# Architecture

**Analysis Date:** 2026-08-04

## Pattern Overview

**Overall:** Bounded, read-only agent loop (observe → act → reflect) built on Flue 2.0, with a strict separation between model-facing tools and trusted application code. The agent decides; the harness constrains.

**Key Characteristics:**
- Model never holds credentials or a shell — sandbox replaces Flue's default filesystem/shell tools with an empty toolset (`sandbox.ts`)
- Repository access exists only through custom read-only inspection tools (path confinement + shared `StepBudget`)
- Trusted boundary: GitHub token, git diff, and review posting live in application code (`github/`, `review/pr-data.ts`), never in sandbox tools
- Deterministic, key-free evaluation paths for CI alongside live provider-backed paths
- Factory-function composition everywhere (`createXxx`) with Valibot schema validation at the edges

## Decisions

Significant architecture decisions are recorded as ADRs in [`docs/adr/`](../../docs/adr/README.md)
and indexed there. When a decision changes the architecture described in this
map, record an ADR and keep both documents in sync:

| ADR | Decision | Status |
| --- | -------- | ------ |
| [0001 – Event router](../../docs/adr/0001-event-router.md) | Declarative Valibot route config, normalized event model, first-match routing with AND-ed filters, duplicate-delivery stores, decision-only dispatch (agent execution wired by workflows) | Accepted |
| [0002 – Model evaluation benchmark](../../docs/adr/0002-model-eval-benchmark.md) | `eval/bench/` framework with deterministic + live runner modes, keyword judge with an LLM-as-a-judge seam, provider pricing, `npm run eval` CLI | Accepted |

See [`docs/adr/README.md`](../../docs/adr/README.md) for conventions and how to add a new record.

## Layers

**Agents:**
- Purpose: Model-facing entrypoints that decide what to do
- Location: `agents/`
- Contains: `RepoAssistant()` (`repo-assistant.ts`), `PrReviewer()` (`pr-reviewer.ts`) — both `'use agent'` directives returning synchronous render functions
- Depends on: tools, planner, investigation, skills
- Used by: `app.ts` route map, `npm start` / `npm run review-pr`

**Tools:**
- Purpose: The only capabilities the model can exercise
- Location: `tools/`
- Contains: `list_files`, `read_file`, `search_code`, `search_docs`, `retrieve` factories; `repository.ts` holds `RepositoryReader` (path confinement, limits) and `StepBudget`; `contracts.ts` centralizes `TOOL_LIMITS` and names; `inspection-registry.ts` composes the tool list
- Depends on: `reliability/` wrappers, `index/` (retrieval)
- Used by: agents, `investigation/`, `eval/`

**Investigation loop:**
- Purpose: Deterministic evidence-collection loop (dedup, bounds, early stop)
- Location: `investigation/`
- Contains: `loop.ts` (`runInvestigation`, `buildToolMap`), `types.ts` (`DecisionFn`, `InvestigationResult`), `evidence.ts`, `call-tracker.ts`, `answer.ts`, `tool-execution.ts`, `tool-call.ts`
- Depends on: tools, `reliability/tool-invocation.ts`
- Used by: `demo/`, `eval/`, tests — and conceptually by the live agent

**Planner:**
- Purpose: Plan → execute → reflect meta-tools (`create_plan`, `replan`, `reflect_plan`) that do not consume inspection budget
- Location: `planner/`
- Contains: `planner.ts`, `executor.ts`, `plan-store.ts`, `reflection.ts`, `types.ts`
- Depends on: tools (for execution)
- Used by: the repo assistant; deterministic functions used by tests

**Reliability:**
- Purpose: Cross-cutting resilience — retry (transient only), timeout via `AbortController`, output validation, failure injection
- Location: `reliability/`
- Contains: `resilient-tool.ts`, `retry.ts`, `timeout`/`fallback.ts`, `errors.ts`, `validation.ts`, `observability.ts`, `failure-injection.ts`, `tool-invocation.ts`
- Depends on: tools contracts
- Used by: every inspection tool wrapper

**PR Review:**
- Purpose: Review pull requests with trusted GitHub access, incremental state, and repository memory
- Location: `review/`, `github/`
- Contains: `review/review-tools.ts` (get_pr_metadata/diff/hunks/review_state/context/submit), `review/pr-data.ts` (git+GitHub data), `review/schema.ts` (ReviewResult Valibot), `review/filters.ts` (skip lockfiles/generated), `review/limits.ts`, `review/review-state.ts` + `review-state-store.ts` (hidden-comment state), `github/client.ts` (REST), `github/adapter.ts` (trusted publisher)
- Depends on: tools (read/search), `just-bash`, GitHub REST
- Used by: `scripts/review-pr.ts` (CI entrypoint)

**Event router:**
- Purpose: Map GitHub events to agent IDs; decision-only, agent execution out of scope
- Location: `github/events/`
- Contains: `types.ts`, `config.ts` (Valibot route schema + loading), `payloads.ts` (normalization), `router.ts` (first-match + filters), `dedupe.ts` (memory/file stores), `logger.ts`, `index.ts`
- Used by: `scripts/route-event.ts` (CI entrypoint)

**Evaluation:**
- Purpose: Benchmark models on repo-assistant workloads
- Location: `eval/`
- Contains: `capstone-eval.ts` (Day-30 suite), `bench/` (framework: `types.ts`, `schema.ts`, `config.ts`, `metrics.ts`, `store.ts`, `runner.ts`, `judge.ts`, `providers.ts`, `patch.ts`, `index.ts`), `benchmarks/sample.json`, `fixtures/sample-repo/`
- Depends on: investigation, tools, index
- Used by: `scripts/flue-eval.ts` (CLI), `eval/run-capstone-eval.sh`, CI example

## Data Flow

**Repo question (assistant):**
1. User question → Flue harness → agent
2. Agent declares a plan (`create_plan`, budget-free)
3. Agent calls inspection tools (`search_docs`/`search_code`/`retrieve` → `read_file`) within the shared `StepBudget`
4. Investigation evidence is collected, deduplicated, size-limited
5. Agent reflects (`reflect_plan`) and answers with file/line citations and confidence
6. Harness validates tool inputs via Valibot; reliability wrapper retries/timeouts/validates outputs

**PR review:**
1. `pr-review.yml` triggers on PR events with `GITHUB_TOKEN`, `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`
2. Reviewer loads metadata/diff, reads context (`get_review_context`, repository memory), classifies prior findings (incremental)
3. Emits structured `ReviewResult` → `github/adapter.ts` re-validates (paths in diff, lines clamped to hunks, verdict never `APPROVE`) → posts one review
4. State comment persisted for incremental reviews

**Event routing:**
1. Actions sets `GITHUB_EVENT_NAME`/`GITHUB_EVENT_PATH`; `npm run route-event` runs
2. `loadConfigFromFile` validates routes; `parseEventPayload` normalizes the event
3. `router` first-match on event + AND-ed filters; dedupe store blocks redeliveries
4. On dispatch: prints JSON decision and writes `agent=<id>` to `$GITHUB_OUTPUT`

**Benchmark eval:**
1. `npm run eval -- run` loads a suite config (JSON), builds deciders (deterministic) or a `modelCall` (live)
2. Each scenario runs through the investigation pipeline; judge scores 0..1 (keyword default, LLM seam)
3. Metrics: quality, latency, tokens, cost (pricing table), tool success, patch applicability (opt-in)
4. Reports persist as JSON under `eval/results/`; `compare`/`leaderboard`/`report` read them

**State Management:**
- Stateless per run; no application database. Persistent state: PR review state in hidden GitHub comments, benchmark reports as JSON files, event-router dedupe in an optional file store

## Key Abstractions

**`RepositoryReader`:**
- Purpose: Read-only, path-confined access to one repository
- Examples: `tools/repository.ts`
- Pattern: Factory (`createRepositoryReader` / `createRepositoryReaderSync`), realpath + symlink confinement, ignored dirs, size/line limits

**`StepBudget`:**
- Purpose: Shared inspection budget (1–20, default 8) consumed by inspection tools only
- Examples: `tools/repository.ts`, `tools/contracts.ts`
- Pattern: Snapshot object `{ used, remaining, limit }` surfaced in every tool result

**`DecisionFn`:**
- Purpose: Given investigation state, choose next tool call or stop
- Examples: `investigation/types.ts`; mock deciders in `eval/capstone-eval.ts` and `eval/bench/runner.ts`
- Pattern: Deterministic function; enables key-free testing and CI evaluation

**`Valibot` schemas:**
- Purpose: Validate everything at the edges (tool input, review result, event config, benchmark suites)
- Examples: `tools/contracts.ts`, `review/schema.ts`, `github/events/config.ts`, `eval/bench/schema.ts`
- Pattern: `safeParse` with field-path error messages

## Entry Points

**`app.ts`:**
- Location: `app.ts`
- Triggers: `vite build` (route map), Flue dev server
- Responsibilities: mounts `/agents/repo-assistant` and `/agents/pr-reviewer` via `createAgentRouter`; serves `/api/ping`

**`scripts/review-pr.ts`:**
- Location: `scripts/review-pr.ts`
- Triggers: `.github/workflows/pr-review.yml`; `npm run review-pr`
- Responsibilities: end-to-end PR review with trusted publishing

**`scripts/route-event.ts`:**
- Location: `scripts/route-event.ts`
- Triggers: Actions event-routing step; `npm run route-event`
- Responsibilities: route a GitHub event to an agent id, write `$GITHUB_OUTPUT`

**`scripts/flue-eval.ts`:**
- Location: `scripts/flue-eval.ts`
- Triggers: `npm run eval` (run/compare/leaderboard/report)
- Responsibilities: benchmark execution and reporting

**`eval/capstone-eval.ts`:**
- Location: `eval/capstone-eval.ts`
- Triggers: `npm run capstone:eval`, `eval/run-capstone-eval.sh`
- Responsibilities: Day-30 deterministic evaluation suite; entrypoint guarded by an is-main check so imports don't run it

## Error Handling

**Strategy:** Typed, categorized errors with user-safe messages; permanent vs transient classification; controlled results instead of crashes for negative outcomes (empty searches, unsupported events)

**Patterns:**
- `SafeToolError` with stable `category` + `retryable` flag (`reliability/errors.ts`)
- Retry only transient (408/429/5xx/resets/timeouts); never retry auth/permission/not-found
- `{ ok: true } | { ok: false; issues: string[] }` result types for config/payload loading (event router, benchmark config)
- Failed tool calls become error entries in the investigation loop, never crash it

## Cross-Cutting Concerns

**Logging:** Debug-gated structured logs (`REPO_ASSISTANT_DEBUG`, `EVENT_ROUTER_DEBUG`) — one safe line per tool call; never secrets, file contents, or payloads

**Validation:** Valibot at every edge: tool inputs, tool outputs, ReviewResult, event-router config, benchmark suites

**Authentication:** API keys in env; GitHub token held only by trusted `github/` code; model never sees it

**Security:** Read-only FS access, path confinement, symlink checks, size limits, empty sandbox toolset, no subagents/delegation

---

*Architecture analysis: 2026-08-04*
