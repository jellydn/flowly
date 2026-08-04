# Coding Conventions

**Analysis Date:** 2026-08-04

## Naming Patterns

**Files:**
- kebab-case, lowercase: `list-files.ts`, `search-code.ts`, `review-tools.ts`, `repository-indexer.ts`
- Tests: `<module>.test.ts` in `tests/` (e.g. `event-router.test.ts`, `bench-runner.test.ts`)

**Functions:**
- Factory functions named `create<Thing>` that return a configured object/tool: `createListFilesTool`, `createRepositoryReader`, `createKeywordJudge`, `createFileBenchmarkStore`
- Verbs for operations: `runInvestigation`, `runBenchmark`, `loadSuiteFromFile`, `parseEventPayload`

**Variables:**
- camelCase; booleans often `is*`/`has*`/`requires*` (`isMerged`, `requiresToolCall`, `needsRebase`)
- Result discriminators: `{ ok: true; value } | { ok: false; issues }` — destructured as `loaded.ok`

**Types:**
- PascalCase; domain nouns: `RepositoryReader`, `StepBudget`, `DecisionFn`, `InvestigationResult`, `BenchmarkReport`, `EventRouterConfig`, `ScenarioResult`
- Type-only imports use `import type` (enforced by `verbatimModuleSyntax`)

## Code Style

**Formatting:**
- oxfmt (oxc): 2-space indent, single quotes, semicolons, trailing commas, 100-col width, always-arrow parens (`.oxfmtrc.json`)
- `oxfmt --check` runs as a pre-commit hook via `prek`; files must be normalized with `oxfmt <paths>` before commit

**Linting:**
- oxlint (oxc) with `typescript`, `unicorn`, `oxc` plugins; `correctness` is error; unused imports/vars fail the hook (`.oxlintrc.json`)
- `prek run --all-files` runs both; hooks exclude `eval/fixtures/` (intentionally unformatted)

## Import Organization

**Order:**
1. Node built-ins (`node:fs/promises`, `node:path`, `node:test`, `node:process`)
2. Third-party (`valibot` as `import * as v`, `@flue/runtime`)
3. Local relative imports with explicit `.ts` extension (e.g. `from './types.ts'`, `from '../../tools/repository.ts'`)

**Path Aliases:**
- None — always relative imports with `.ts` extensions (`allowImportingTsExtensions`)

## Error Handling

**Patterns:**
- Typed errors with a stable `category` and `retryable` flag (`reliability/errors.ts`: `TimeoutError`, `RateLimitError`, `AuthenticationError`, `PermissionError`, `NotFoundError`, `InvalidToolResponseError`, `ExternalServiceError`)
- Retry only transient failures (408/429/5xx/resets/timeouts); never retry auth/permission/not-found
- `{ ok: ... }` result types for config/payload loading; issues arrays carry field paths for actionable messages
- Failed tool calls and decision errors become error entries in the loop — they never crash it
- User-facing errors are safe: no stack traces, provider internals, keys, or raw objects

## Logging

**Framework:** console (stderr), gated behind debug flags

**Patterns:**
- `REPO_ASSISTANT_DEBUG=true` → one safe line per tool call: tool name, sanitized input, status, result count, budget snapshot
- Event router emits structured JSON decision logs when `EVENT_ROUTER_DEBUG=true`
- Reliability logs structured JSON events per retry attempt
- Never log secrets, tokens, file contents, absolute repo paths, or payload content

## Comments

**When to Comment:**
- File-level docblocks explaining the module's purpose, conventions, and constraints (every domain module opens with `/** ... */`)
- Explain the *why* for non-obvious decisions (e.g. is-main guard in `eval/capstone-eval.ts`, live-mode model wiring)
- Budget/safety invariants are documented inline (e.g. "retries do not consume extra budget")

**JSDoc/TSDoc:**
- `/** ... */` docblocks on exported types and functions; include `@param`/`@returns` only where helpful
- Heavy on "what this abstraction is for" prose over mechanical signatures

## Function Design

**Size:** Small, single-purpose; the investigation loop, runner, and adapter orchestrate by composing factories

**Parameters:** Object-argument pattern for functions with 3+ options (`runBenchmark(suite, model, options)`, `runScenario(input)`) — named fields beat positional args

**Return Values:** Explicit envelopes (`{ output: value }` for tool runs, `{ ok }` result unions, structured report objects) rather than bare values where shape matters

## Module Design

**Exports:** Named exports only (no default exports); factory functions exported alongside their types

**Barrel Files:** Yes — domain dirs expose `index.ts` barrels (`github/events/index.ts`, `eval/bench/index.ts`) re-exporting the module's public surface

**Dependency direction:** Domain modules import from lower layers (tools → investigation); agents and scripts import everything; the sandbox isolates the model from FS/shell

---

*Convention analysis: 2026-08-04*
