# Architecture

**Analysis Date:** 2026-08-01

## Pattern Overview

**Overall:** Bounded, read-only repository-analysis agent with explicit planning, shared tool execution, evidence-oriented investigation, and reliability wrappers.

The live Flue path is composed in `agents/repo-assistant.ts`. Deterministic modules under `planner/` and `investigation/` provide testable equivalents of planning and execution behavior without requiring a provider key.

## Layers

**Agent composition layer**

- Location: `agents/repo-assistant.ts`, `app.ts`, `sandbox.ts`, `flue.config.ts`, `vite.config.ts`.
- Responsibility: Resolve environment configuration, create the repository reader and shared budget, register planning and inspection tools, select the model, load the skill, restrict the sandbox, and expose the route.
- The `InspectionRegistry` is the composition seam for the four inspection tools and their reliability policy. Its local `TOOL_NAMES` tuple mirrors the canonical names in `tools/contracts.ts` and must remain synchronized.

**Planning layer**

- Location: `planner/plan-run.ts`, `plan-store.ts`, `planner.ts`, `executor.ts`, `reflection.ts`, `types.ts`.
- Responsibility: Define plans, own plan/results/reflection state, execute concrete plan steps, replan after empty results, and compute reflection.
- `PlanRun` is the deep lifecycle module used by deterministic/programmatic execution and lifecycle tests. `PlanStore` remains the narrow state surface used by model-facing planner tools and legacy callers; the live Flue path does not invoke `PlanRun.execute()` directly.

**Tool execution layer**

- Location: `investigation/tool-call.ts`, `investigation/tool-execution.ts`, `reliability/tool-invocation.ts`.
- Responsibility: Resolve tools, invoke Flue v2 contexts using `data`, `toolCallId`, `log`, and `signal`, unwrap `{ output }` envelopes, preserve cancellation, and attach execution metadata.
- `runExecutionLoop` is shared by planner execution and deterministic investigation. `reliability/tool-invocation.ts` owns the framework-specific invocation seam; compatibility exports remain available from the investigation path.

**Repository access and search layer**

- Location: `tools/repository.ts`, `tools/contracts.ts`, `tools/list-files.ts`, `tools/read-file.ts`, `tools/search-code.ts`, `tools/search-docs.ts`, `tools/repository-search.ts`, `tools/search-utils.ts`.
- Responsibility: Enforce path confinement, traversal and symlink rules, file/output bounds, the shared inspection budget, source/documentation candidate selection, and bounded literal matching.
- `repository-search.ts` provides a stable search interface while leaving indexing or streaming as a future optimization behind the reader seam.

**Reliability layer**

- Location: `reliability/resilient-tool.ts`, `retry.ts`, `errors.ts`, `validation.ts`, `fallback.ts`, `observability.ts`, `failure-injection.ts`.
- Responsibility: Consume one budget slot per logical call, retry transient errors, enforce timeouts, validate outputs, classify errors, provide safe messages, log structured events, and support deterministic failure injection.

**Investigation/evidence layer**

- Location: `investigation/loop.ts`, `evidence.ts`, `answer.ts`, `call-tracker.ts`, `types.ts`.
- Responsibility: Provide a bounded observe → act → reflect loop for deterministic tests/demos, block duplicate calls, collect/deduplicate evidence, calculate confidence, and format citations.

## Data Flow

**Live Flue request:**

1. Flue invokes `RepoAssistant()` through the CLI or route.
2. The agent creates a canonical repository reader, shared `StepBudget`, retry configuration, reliability logger, failure injector, and `InspectionRegistry`.
3. Planning tools are registered without consuming inspection budget.
4. The registry registers four reliable inspection tools in explicit order: `list_files`, `read_file`, `search_code`, and `search_docs`.
5. The model creates a plan, executes inspection calls, optionally replans after empty results, reflects, and answers from cited evidence.

**Deterministic execution:**

1. `createPlanRun()` stores a plan and owns lifecycle state.
2. `PlanRun.execute()` or `runInvestigation()` creates an adapter for `runExecutionLoop()`.
3. The shared loop handles iteration limits, skip/stop actions, cancellation, tool resolution, invocation, and metadata-bearing outcomes.
4. Planner/investigation adapters classify outputs, append results, collect evidence, and decide whether to stop.

**Search flow:**

1. `search-code.ts` or `search-docs.ts` validates model input and consumes one logical budget slot.
2. The tool calls `searchRepository()` with a source or documentation scope.
3. The repository reader lists bounded candidate paths.
4. `searchFiles()` reads candidates sequentially, checks cancellation, yields periodically, and stops at the match limit.
5. The tool returns the existing bounded result shape plus `filesSearched` metadata.

## State Management

- `PlanRun` keeps plan, all historical results, current-plan results, and reflection in memory.
- `StepBudget` is an explicitly passed mutable closure. Retry attempts use pass-through budget behavior so one logical call consumes one slot.
- `EvidenceCollector` owns bounded deduplicated evidence for an investigation run.
- No state is persisted across agent invocations.

## Key Abstractions

- **`RepositoryReader`**: canonical path, filesystem, searchable-file, and budget boundary.
- **`InspectionRegistry`**: one construction/registration list for raw tools and reliability wrapping.
- **`PlanRun`**: one lifecycle interface for plan recording, execution results, replanning, reflection, and status.
- **`runExecutionLoop`**: common bounded execution protocol for planner and investigation adapters.
- **`ToolExecutionOutcome`**: normalized success/error result with `toolCallId`, start time, and duration metadata.
- **`EvidenceCollector`**: bounded, deduplicated, source-classified evidence store.
- **`SafeToolError` and validators**: stable user-safe reliability outcomes.

## Error Handling

The system fails closed. Repository violations throw safe repository-relative errors; reliability classifies and retries only transient failures; malformed outputs are rejected; deterministic loops preserve errors as result state; cancellation remains exceptional; and final answer formatting reports insufficient evidence rather than inventing claims.

## Entry Points

- CLI: `npm start -- --input ...` or `npx flue run agents/repo-assistant.ts ...`.
- Route: `/agents/repo-assistant` in `app.ts`.
- Health: `/api/ping`.
- Deterministic demos: `demo/doc-aware-demo.ts` and `demo/reliability-demo.sh`.
- Evaluation: `eval/run-eval.sh` with committed fixture data.

---

_Architecture analysis: 2026-08-01_
