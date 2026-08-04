# 0003. Tool composition seam for the inspection tool set

Date: 2026-08-04

## Status

Accepted

## Context

The agent had grown to five inspection tools (`list_files`, `read_file`,
`search_code`, `search_docs`, `retrieve`) plus three budget-free planning
meta-tools, and each raw tool was composed slightly differently:

1. **Three competing budget mechanisms.** Some raw tools consumed the shared
   `StepBudget` inside their own `run`, some were marked budget-free through a
   `markBudgetFreeTool` WeakSet, and the reliability wrapper consumed budget on
   top — three different shapes for the same "one step per logical call" rule.
2. **Search was duplicated.** `search_code` and `search_docs` were twin
   implementations — same input schema, run loop, and result shape — differing
   only in the file scope they searched.
3. **Logging was duplicated.** The debug logger and the reliability logger each
   owned its own enabled-check and stderr write.
4. **Tool sets could drift.** The live agent, the PR reviewer, the capstone
   demo, the doc-aware demo, and the eval runners each composed tools by hand,
   so no single place defined "the tool set".
5. **The planner executor was split.** A shallow `planner/executor.ts`
   duplicated lifecycle state that `plan-run.ts` already owned.

Raw tools were also entangled with cross-cutting concerns (budget accounting,
debug logging, error wrapping, validation), which made them hard to test in
isolation and easy to compose inconsistently.

## Decision

Collapse raw-tool composition onto one seam, landed as a five-PR gh-stack
(#51–#55) in dependency order:

- **Tool budget seam (#51).** `tools/` factories become pure
  `(repository) => ToolDefinition` operations with no budget, logging, or error
  concerns. Those concerns move to `reliability/resilient-tool.ts`, which owns
  `withInspectionBudget` (standalone composition for deterministic callers) and
  `wrapToolWithReliability` (retry, timeout, validation for live composition).
  A `sealedTools` WeakSet rejects double-wrapping at construction time; the old
  `markBudgetFreeTool` mechanism is gone.
- **Search seam (#52).** One scope-parameterized `createSearchTool` in
  `tools/search.ts`; `search_code` and `search_docs` become thin adapters over
  it, and the twin input validators collapse.
- **Logging seam (#53).** Both safe stderr loggers reconcile onto one shared
  env-gated `createLineLogger` sink owned by the `tools/repository.ts` leaf, so
  the reliability layer can use it without a tools→reliability edge.
- **Eval registry (#54).** `tools/inspection-registry.ts` becomes the single
  source of truth for the five-tool set: `rawToolFactories` (pure factories),
  `createInspectionRegistry` (reliable tools for the live agent), and
  `createBudgetedInspectionTools` (standalone budget seam for deterministic
  eval runners and demos). Eval runners and the capstone demo compose through
  the registry instead of hand-building tool maps.
- **Planner executor (#55).** The dual executor folds into `plan-run.ts`:
  `executePlan`, `shouldReplan`, and `replan` become stateless conveniences
  over `createPlanRun`, and the shallow `planner/executor.ts` is deleted.

## Consequences

### 📋 Positive

- Raw tools are pure repository operations: testable in isolation, and every
  cross-cutting concern lives in exactly one seam.
- The registry is the single composition point — live agent, PR reviewer,
  demos, and eval runners all see the same five-tool set, so they cannot drift.
- Search is one implementation; adding a scope is a one-line option.
- Double-wrapping is rejected at construction time by the sealed-tool guard.
- The planner lifecycle has one owner (`plan-run.ts`) shared by the
  model-facing tools and deterministic tests.
- Net ~35 lines removed across the stack while adding the search seam and the
  registry.

### 📋 Negative

- Two composition wrappers exist (standalone vs. reliable) with subtly
  different budgets; callers must pick the right seam.
- The sealed-tool guard is a runtime WeakSet check, so a composition mistake
  throws at construction rather than failing a type check.
- The registry couples every tool to the reliability contract
  (`retryConfig`, `reliabilityLog`, `injector`) — heavier than a purely local
  tool like `retrieve` strictly needs.
- The dependency direction (reliability imports its logger sink from the tools
  leaf) inverts a naive "reliability sits below tools" mental model.
