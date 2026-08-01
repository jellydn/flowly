# Coding Conventions

**Analysis Date:** 2026-08-01

## Naming Patterns

**Files:**
- Lowercase descriptive TypeScript filenames; tool modules use kebab-case (`tools/search-code.ts`), and tests use `.test.ts` (`tests/reliability.test.ts`).
- One responsibility per directory/module: `planner/`, `investigation/`, and `reliability/` group related contracts and implementations.

**Functions:**
- Descriptive verb-first camelCase (`createStepBudget`, `createRepositoryReaderSync`, `runInvestigation`, `validateSearchResult`). See `tools/repository.ts`, `investigation/loop.ts`, and `reliability/validation.ts`.
- Factory functions create configured tools/stores/loggers (`createListFilesTool`, `createPlanStore`, `createReliabilityLogger`).

**Variables:**
- camelCase for local values and parameters; `UPPER_SNAKE_CASE` for module constants such as `MAX_FILE_BYTES` and `DEFAULT_MAX_ITERATIONS`. See `tools/repository.ts` and `investigation/loop.ts`.
- Environment variable keys remain uppercase with the `REPO_ASSISTANT_` prefix. See `.env.example`.

**Types:**
- PascalCase for exported types/classes (`RepositoryReader`, `StepBudget`, `Plan`, `Evidence`, `ReliabilityError`). See `tools/repository.ts`, `planner/types.ts`, and `reliability/errors.ts`.
- String unions model finite states (`Confidence`, `ExecutionStatus`, `ErrorCategory`). See `investigation/types.ts`, `planner/types.ts`, and `reliability/errors.ts`.

## Code Style

**Formatting:**
- No formatter configuration is committed; style is enforced by consistent manual formatting and TypeScript compiler settings. See `package.json` and `tsconfig.json`.
- Two-space indentation, semicolons, single-quoted imports/strings in TypeScript, trailing commas in multiline structures, and explicit `.ts` import extensions are prevalent. See `agents/repo-assistant.ts` and `tools/*.ts`.

**Linting:**
- No ESLint, Prettier, or Biome script/configuration is present. The code uses occasional lint suppression comments where direct Flue typing requires an escape hatch. See `planner/executor.ts`, `investigation/loop.ts`, and `tests/helpers.ts`.

## Import Organization

**Order:**
1. Runtime/framework imports (`@flue/runtime`, `valibot`, Node built-ins).
2. Local value imports.
3. Local type-only imports, commonly grouped near the relevant module. See `tools/repository.ts`, `planner/executor.ts`, and `agents/repo-assistant.ts`.

**Path Aliases:**
- No path aliases are configured. Relative imports use explicit `.ts` extensions. See `tsconfig.json` and the source tree.

## Error Handling

**Patterns:**
- Validate model-facing input with Valibot schemas in tool definitions. See `tools/*.ts` and `planner/*.ts`.
- Consume the shared budget before repository work so failures still account for an attempted inspection. Attach the snapshot to success/error context. See `tools/repository.ts` and `tools/list-files.ts`.
- Wrap filesystem/tool errors with repository-relative safe messages and inspection metadata. See `tools/repository.ts`.
- Classify reliability errors into stable categories and retry only transient failures. See `reliability/errors.ts` and `reliability/retry.ts`.
- Deterministic loops catch errors into result state rather than throwing through the whole investigation. See `investigation/loop.ts`.
- Final answer generation uses explicit insufficient-evidence output rather than speculation. See `investigation/answer.ts`.

## Logging

**Framework:** Console stderr logging through small injected logger interfaces; no logging framework dependency. See `tools/repository.ts` and `reliability/observability.ts`.

**Patterns:**
- Logs are opt-in via `REPO_ASSISTANT_DEBUG`.
- Tool logs include tool name, sanitized input summary, outcome, result count, and budget state.
- Reliability logs include operation, attempt, duration, retry/fallback flags, category, and outcome, excluding secrets, file contents, absolute paths, and model reasoning. See `reliability/observability.ts`.

## Comments

**When to Comment:**
- Comments explain safety boundaries, Flue v2 compatibility, retry/budget semantics, deterministic-test intent, and why a layer exists. See `agents/repo-assistant.ts`, `tools/repository.ts`, and `reliability/resilient-tool.ts`.
- Avoid comments that merely restate straightforward code; most modules use focused JSDoc for exported abstractions.

**JSDoc/TSDoc:**
- Exported factories, types, and non-obvious algorithms commonly have JSDoc describing contracts and limits. See `investigation/evidence.ts`, `reliability/retry.ts`, and `planner/planner.ts`.

## Function Design

**Size:**
- Prefer focused functions, but some orchestration modules are intentionally larger: `agents/repo-assistant.ts`, `tools/repository.ts`, `planner/planner.ts`, and `reliability/validation.ts`.

**Parameters:**
- Pass explicit dependencies (repository, budget, logger, retry config) into factories rather than using module globals. See tool factories and `wrapToolWithReliability`.
- Use options objects for extensible behavior (`InvestigationOptions`, retry config). See `investigation/loop.ts` and `reliability/retry.ts`.

**Return Values:**
- Flue tools return v2 envelopes `{ output: value }`; tests use `runTool()` to unwrap them. See `tools/*.ts` and `tests/helpers.ts`.
- Domain functions return structured objects with discriminated status/category fields rather than untyped strings. See `planner/types.ts`, `investigation/types.ts`, and `reliability/errors.ts`.
- Errors are thrown for invalid capability access; expected investigation failures are captured in `errors`/result statuses. See `tools/repository.ts` and `investigation/loop.ts`.

## Module Design

**Exports:**
- Modules export focused named factories, types, and pure helpers. The only agent export is `RepoAssistant()` plus `description` in `agents/repo-assistant.ts`.
- Tool creation is explicit and compositional; avoid hidden registration or side effects. See `agents/repo-assistant.ts`.

**Barrel Files:**
- No barrel/index files are used. Consumers import directly from responsibility-specific modules. See imports throughout `tests/` and `agents/repo-assistant.ts`.

---

*Convention analysis: 2026-08-01*
