# Coding Conventions

**Analysis Date:** 2026-08-01

## Naming and Files

- Use lowercase descriptive filenames; tool modules use kebab-case and tests use `.test.ts`.
- Group modules by responsibility: `tools/`, `planner/`, `investigation/`, and `reliability/`.
- Use descriptive verb-first camelCase functions (`createStepBudget`, `searchRepository`, `runExecutionLoop`).
- Use `create*` factories for configured tools, stores, loggers, readers, and registries.
- Use PascalCase exported types and string unions for finite states/categories.
- Use `UPPER_SNAKE_CASE` for shared limits and defaults.

## TypeScript Style

- Strict TypeScript, ES modules, explicit `.ts` import extensions, and no emit.
- Two-space indentation, semicolons, single-quoted strings/imports, trailing commas in multiline structures.
- Prefer `import type` for type-only dependencies and direct relative imports; no barrel files or path aliases.
- Use options objects for extensible behavior and explicit dependency injection for repositories, budgets, loggers, retry config, and failure injectors.
- No ESLint, Prettier, or Biome configuration is present; `tsc`, tests, and manual consistency are the enforced quality gates.

## Module Design

- Keep the agent composition layer declarative: construct dependencies once, then register tools.
- `InspectionRegistry` is the single construction and registration list for inspection tools; adding a tool should update its typed names/factory list and focused tests.
- `PlanRun` owns plan lifecycle state. `PlanStore` is intentionally a narrow compatibility surface and should not accumulate new lifecycle logic.
- `runExecutionLoop` owns shared iteration, cancellation, tool invocation, and outcome handling. Planner and investigation code should interpret outcomes rather than duplicate invocation mechanics.
- `reliability/tool-invocation.ts` owns Flue v2 context and `{ output }` envelope normalization. Compatibility exports are retained where older callers import the investigation path.
- `repository-search.ts` owns source/documentation scope selection; `search-utils.ts` owns bounded matching and cancellation. Keep indexing or concurrency behind this seam until measured evidence justifies it.

## Validation and Error Handling

- Validate model-facing inputs with Valibot schemas.
- Consume one shared budget slot per logical inspection call; retry attempts use pass-through budget behavior.
- Attach inspection metadata to tool results and safe errors.
- Reject repository-relative path violations, escaping symlinks, binary/oversized files, and invalid ranges.
- Classify reliability failures into stable categories and retry only transient failures.
- Preserve cancellation as an exception; do not convert an aborted operation into a normal tool error.
- Deterministic loops record expected failures in result state, while invalid capability access and cancellation remain exceptional.
- Final answers must report insufficient evidence rather than speculate.

## Logging

- Logging is opt-in via `REPO_ASSISTANT_DEBUG`.
- Tool logs include sanitized inputs, outcome, result count, and budget state.
- Reliability logs include operation, attempt, duration, retry/fallback flags, category, and outcome.
- Never log provider keys, file contents, absolute repository paths, raw errors, or model reasoning.

## Comments and Documentation

- Comment the why for safety boundaries, Flue v2 compatibility, budget/retry semantics, and non-obvious deterministic-test behavior.
- Prefer focused JSDoc on exported abstractions and public factories.
- Avoid comments that restate straightforward code.
- Keep `README.md`, `AGENTS.md`, the analysis skill, and tool descriptions synchronized when user-visible tool names, limits, or workflows change.

## Testing Conventions

- Use Node's `node:test` with `node:assert/strict` through `tsx`.
- Use real temporary repositories for filesystem/path/symlink behavior; use dependency injection for sleep, failure injection, log capture, and decision functions.
- Keep mutable budgets/readers/tools fresh per test.
- Cover both raw tool behavior and higher-level planner/investigation flows.
- Run `npm run typecheck`, `npm test`, and `npm run build`; `npm run check` runs them in that order.

---

*Convention analysis: 2026-08-01*
