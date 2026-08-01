# Architecture

**Analysis Date:** 2026-08-01

## Pattern Overview

**Overall:** Bounded, read-only agent pipeline with explicit planning, evidence collection, and reliability wrappers.

**Key Characteristics:**
- `agents/repo-assistant.ts` composes Flue v2 hooks synchronously and is the single agent entrypoint.
- The inspection capabilities defined by `INSPECTION_TOOL_NAMES` are the only repository data capabilities. See `tools/contracts.ts`, `agents/repo-assistant.ts`, and `tools/`.
- Planning meta-tools (`create_plan`, `replan`, `reflect_plan`) separate intent from inspection. Canonical plan-tool names are derived from the shared contract module. See `planner/` and `tools/contracts.ts`.
- Reliability is applied around each inspection tool before registration with Flue. See `reliability/resilient-tool.ts` and `agents/repo-assistant.ts`.
- The deterministic investigation module mirrors the observe → act → reflect loop for tests and demos without requiring an LLM. See `investigation/loop.ts` and `tests/doc-aware.test.ts`.

## Layers

**Flue composition and entry layer:**
- Purpose: Construct one configured agent and expose it through the runtime.
- Location: `agents/repo-assistant.ts`, `app.ts`, `vite.config.ts`, `flue.config.ts`.
- Contains: Flue v2 hooks, environment parsing, model selection, tool registration, sandbox/skill registration, and route mounting.
- Depends on: All lower layers and `@flue/runtime`.
- Used by: `npm start`, Vite build output, and the `/agents/repo-assistant` route.

**Planning layer:**
- Purpose: Record a 3–5 step plan, execute concrete steps in deterministic tests, replan after empty search/list results, and reflect on outcomes.
- Location: `planner/types.ts`, `planner/plan-store.ts`, `planner/planner.ts`, `planner/executor.ts`, `planner/reflection.ts`.
- Contains: Plan schemas, in-memory `PlanStore`, rule-based planner, programmatic executor, replanning, and model-facing meta-tools.
- Depends on: Flue tool definitions, shared budget snapshots, and the canonical plan-tool contract in `tools/contracts.ts`.
- Used by: `agents/repo-assistant.ts`, `tests/planner.test.ts`, and the agent prompt.

**Repository access layer:**
- Purpose: Inspect one local repository under strict path and output constraints.
- Location: `tools/repository.ts` and `tools/*.ts`.
- Contains: `RepositoryReader`, `StepBudget`, shared inspection limits, canonical tool-name contracts, path confinement, ignored-directory filtering, bounded reads, source/documentation file discovery, and four typed tool factories.
- Depends on: Node filesystem APIs, Valibot, and Flue's `defineTool`.
- Used by: The agent, deterministic investigation loop, demos, and tests.

**Reliability layer:**
- Purpose: Make each logical inspection call retryable, time-bounded, validated, observable, and optionally failure-injectable.
- Location: `reliability/`.
- Contains: Error classification, exponential backoff with jitter, abort-based timeout, output validation, fallback behavior, safe logging, and test/demo injection.
- Depends on: Raw Flue tool definitions and the shared budget.
- Used by: `agents/repo-assistant.ts` and reliability tests.

**Investigation/evidence layer:**
- Purpose: Run a bounded deterministic tool loop and turn retrieved evidence into cited answers with confidence.
- Location: `investigation/`.
- Contains: Call deduplication, evidence extraction/collection, answer formatting, confidence heuristics, and result types.
- Depends on: Tool definitions and `StepBudget`.
- Used by: Demos and doc-aware/evaluation tests; the live Flue agent follows the same policy through its prompt and tools.

**Capability boundary layer:**
- Purpose: Remove Flue's default filesystem and shell tools while preserving a minimal in-memory session environment.
- Location: `sandbox.ts`.
- Contains: `restrictedSandbox` backed by `just-bash`, with an empty model-facing tool list.
- Depends on: `@flue/runtime` and `just-bash`.
- Used by: `agents/repo-assistant.ts`.

## Data Flow

**Live Flue request:**
1. The CLI or route invokes `RepoAssistant()` in `agents/repo-assistant.ts`.
2. The agent resolves `REPOSITORY_PATH`, creates the shared `StepBudget`, parses reliability settings, and builds the raw tools.
3. Each raw inspection tool is wrapped by `wrapToolWithReliability`; the wrapper consumes one logical budget slot, runs retries through `runWithRetry`, validates output, and returns the v2 `{ output: value }` envelope.
4. Flue receives the user question and prompt instructions, calls `create_plan`, then calls inspection tools with concrete inputs.
5. The model may call `replan` after empty results and `reflect_plan` before answering.
6. The final response must cite repository-relative file paths and line ranges and state confidence/uncertainty. See `agents/repo-assistant.ts`.

**Deterministic investigation:**
1. `runInvestigation()` asks a `DecisionFn` for a call or stop action. See `investigation/loop.ts`.
2. `CallTracker` blocks duplicate tool/input pairs.
3. The loop checks tool existence, budget, and max iterations before execution.
4. `extractEvidence()` converts search matches and bounded reads into deduplicated evidence. See `investigation/evidence.ts`.
5. `formatAnswer()` emits citations, sources, tools used, confidence, and an explicit insufficient-evidence response. See `investigation/answer.ts`.

**State Management:**
- Per-run mutable plan state lives in `PlanStore`; it is not persisted. See `planner/plan-store.ts`.
- Per-run budget state is held by `StepBudget`. Reliability retries use `createPassThroughBudget` internally so attempts do not multiply consumption. See `tools/repository.ts` and `reliability/resilient-tool.ts`.
- Per-run evidence is held by `EvidenceCollector` and capped/deduplicated. See `investigation/evidence.ts`.

## Key Abstractions

**`RepositoryReader`:**
- Purpose: Canonicalize and confine paths, enforce shared inspection limits, list entries, read bounded text, and identify searchable/documentation files.
- Examples: `tools/repository.ts`, `tests/repository.test.ts`.
- Pattern: Application-controlled capability object; all tool factories receive it explicitly.

**`tools/contracts.ts`:**
- Purpose: Single source of truth for inspection tool names, planner tool targets, and repository/evidence limits.
- Pattern: Pure constants and derived literal-union types imported by tools, planner, and evidence layers.

**`StepBudget`:**
- Purpose: Shared inspection-call quota with `{ used, remaining, limit }` snapshots.
- Examples: `tools/repository.ts`, `agents/repo-assistant.ts`.
- Pattern: Stateful closure with a pass-through decorator for retry internals.

**`PlanStore`:**
- Purpose: Keep current plan, execution results, and reflection for one agent run.
- Examples: `planner/plan-store.ts`, `tests/planner.test.ts`.
- Pattern: Encapsulated mutable store exposed through getters and mutation methods.

**`EvidenceCollector`:**
- Purpose: Deduplicate, cap, classify, and relevance-sort retrieved evidence.
- Examples: `investigation/evidence.ts`, `tests/doc-aware.test.ts`.
- Pattern: Closure-backed collection with derived getters.

**`SafeToolError` and reliability validators:**
- Purpose: Convert internal failures into user-safe, typed outcomes without exposing provider internals or secrets.
- Examples: `reliability/errors.ts`, `reliability/validation.ts`, `reliability/resilient-tool.ts`.
- Pattern: Classify → retry if transient → validate → wrap with safe message and budget snapshot.

## Entry Points

**CLI agent:**
- Location: `agents/repo-assistant.ts`.
- Triggers: `npm start -- --input ...` or `npx flue run agents/repo-assistant.ts ...`. See `package.json` and `AGENTS.md`.
- Responsibilities: Compose model, tools, sandbox, skill, instructions, and durability settings.

**HTTP route map:**
- Location: `app.ts`.
- Triggers: Flue/Vite runtime requests to `/agents/repo-assistant`; `/api/ping` provides a simple health response.
- Responsibilities: Mount the agent with `createAgentRouter`.

**Deterministic demos:**
- Location: `demo/doc-aware-demo.ts`, `demo/doc-aware-demo.sh`, and `demo/reliability-demo.sh`.
- Triggers: Shell demo commands.
- Responsibilities: Exercise investigation and reliability behavior without changing the inspected repository.

## Error Handling

**Strategy:** Fail closed, preserve partial evidence, and expose safe messages.

**Patterns:**
- Repository path, symlink, file-size, binary, and budget violations throw before or during the tool call. See `tools/repository.ts`.
- The investigation loop catches tool/decision failures, records errors, and continues or stops without crashing. See `investigation/loop.ts`.
- Reliability classifies timeout, rate-limit, authentication, permission, not-found, validation, and external-service failures. See `reliability/errors.ts`.
- Only transient failures retry; permanent failures fail fast. See `reliability/retry.ts`.
- Malformed/oversized tool outputs are rejected by shape/content validators. See `reliability/validation.ts`.
- Final answers explicitly report insufficient evidence rather than inventing architecture. See `investigation/answer.ts` and `skills/analyzing-repositories/SKILL.md`.

## Cross-Cutting Concerns

**Logging:** Safe human-readable tool logs and structured reliability JSON logs are opt-in through `REPO_ASSISTANT_DEBUG`. See `tools/repository.ts` and `reliability/observability.ts`.

**Validation:** Valibot validates model-facing inputs; repository and reliability layers validate filesystem paths and returned tool shapes. See `tools/*.ts` and `reliability/validation.ts`.

**Authentication:** No application authentication exists. Provider credentials are supplied through `OPENROUTER_API_KEY`; the repository tools are local read-only capabilities. See `.env.example`, `app.ts`, and `agents/repo-assistant.ts`.

---

*Architecture analysis: 2026-08-01*
