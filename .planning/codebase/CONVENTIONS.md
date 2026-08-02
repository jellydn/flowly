# Coding Conventions

**Analysis Date:** 2026-08-02

## Naming Patterns

**Files:**
- TypeScript modules use lowercase kebab-case names such as `tools/repository-search.ts`, `review/review-state-store.ts`, and `github/adapter.ts`; tests live separately under `tests/` and end in `.test.ts`, for example `tests/review-tools.test.ts`.
- Directories group code by responsibility (`agents/`, `tools/`, `review/`, `github/`, `planner/`, `investigation/`, and `reliability/`), while executable scripts live in `scripts/` or `eval/`.

**Functions:**
- Functions use descriptive camelCase, usually verb-first (`searchRepository`, `parseReviewResult`, `classifyFile`, `formatFindingBody`). Configured objects and Flue tools are built by `create*` factories such as `createReviewPublisher`, `createGitDataSource`, and `createReadFileTool`.
- Agent entry functions are PascalCase (`RepoAssistant`, `PrReviewer`) and attach static durability configuration. Private helpers remain unexported and narrowly named (`fetchDiff`, `findStateComment`, `clampToHunk`).

**Variables:**
- Local variables and object properties use camelCase (`cachedReviewState`, `changedPaths`, `inputSummary`); booleans state the predicate (`isFirstReview`, `caseSensitive`, `truncated`).
- Module constants use UPPER_SNAKE_CASE (`TOOL_LIMITS`, `DEFAULT_REVIEW_LIMITS`, `MAX_RETURNED_LINES`), while short callback-local names such as `f`, `c`, and `i` appear only in small maps/loops.

**Types:**
- Types, interfaces, and classes use PascalCase (`RepositoryReader`, `ReviewLimits`, `PrDataSource`, `GitHubApiError`). Interfaces describe behavioral boundaries; object shapes and unions generally use `type`.
- Finite domains use string-literal unions or Valibot picklists (`SkipReason`, `Severity`, `Verdict`), and schema-derived types use `v.InferOutput` in `review/schema.ts`.

## Code Style

**Formatting:**
- `oxfmt`, run directly to rewrite edited files and through `prek run --all-files` for checks; `eval/fixtures/` is intentionally excluded by `prek.toml`.
- `.oxfmtrc.json` requires 2-space indentation without tabs, 100-column print width, semicolons, single quotes, trailing commas everywhere supported, and parentheses around arrow-function parameters.

**Linting:**
- `oxlint` is a PATH-provided system hook managed by `prek.toml`; it is not an npm dependency or npm script. Type correctness is additionally enforced by strict `tsc` through `npm run typecheck`.
- `.oxlintrc.json` enables `typescript`, `unicorn`, and `oxc`, promotes the `correctness` category to errors, and therefore rejects issues including unused imports/variables. `tsconfig.json` uses ES2024, ESNext modules, Bundler resolution, isolated modules, no emit, verbatim module syntax, and strict mode.

## Import Organization

**Order:**
1. Runtime imports from Node built-ins and external packages, with `'use agent'` first in agent modules (for example `agents/pr-reviewer.ts`).
2. `import type` declarations for type-only dependencies, sometimes adjacent to the corresponding value import; type modifiers are also used inline (`import { type FileDiff, ... }`).
3. Relative project imports using explicit `.ts` extensions; same-directory imports use `./` and cross-area dependencies use `../`. Source files show minor order variation, so formatter correctness is relied on rather than a rigid alphabetizer.

**Path Aliases:**
- None. `tsconfig.json` defines no `baseUrl` or `paths`; modules use direct relative paths such as `../review/schema.ts`. Markdown skill imports are allowed by `allowArbitraryExtensions`.

## Error Handling

**Patterns:**
- Validate inputs at boundaries: Flue tools and review payloads use Valibot schemas, environment parsers throw clear `Error` messages, and repository reads reject absolute/traversing paths, escaping symlinks, binary files, oversized files, and invalid ranges.
- Async operations use `try`/`catch`/`finally` intentionally: file handles close in `finally`, tool failures are wrapped with safe budget metadata, cancellation is rethrown, and only known transient/recoverable cases degrade gracefully.
- Expected absence commonly returns `null`, `[]`, or a discriminated result rather than throwing (`parseReviewState`, `getDiffHunks`, safe parsing). Best-effort state persistence records a validation issue after a review is posted, while GitHub 422 inline-comment failures retry once as body-only reviews.

## Logging

**Framework:** console

**Patterns:**
- `createDebugLogger` and reliability observability write structured, opt-in diagnostics with `console.error` only when `REPO_ASSISTANT_DEBUG === 'true'`; normal execution does not log.
- Logs contain sanitized relative inputs, operation/tool name, outcome, counts, attempts, and budget state. They must not expose file contents, absolute paths, credentials, raw model reasoning, or unsafe internal errors; tests capture and restore `console.error` to enforce this.

## Comments

**When to Comment:**
- Explain safety and architectural intent rather than syntax: trusted/sandbox boundaries, budget ownership, caching, cancellation, GitHub API constraints, fallback behavior, and why apparently unusual diff or state handling is necessary.
- Short inline comments clarify non-obvious edge cases in `review/diff.ts`, `review/pr-data.ts`, and `github/adapter.ts`; comments are avoided for straightforward assignments and control flow.

**JSDoc/TSDoc:**
- Exported contracts, factories, constants, classes, and public methods commonly receive `/** ... */` documentation, including `@link` references (for example `RepositoryReader.documentationFiles` and `createReviewPublisher`). Internal helpers receive JSDoc only when their guarantees or security role are important.

## Function Design

**Size:** Most helpers are focused and short; larger factory functions such as `createGitDataSource` and `createReviewPublisher` encapsulate state and private helpers behind a narrow returned interface. Complex concerns are split into dedicated modules rather than duplicated.

**Parameters:** Public factories accept typed dependency/options objects when configuration may grow (`GitDataSourceOptions`, `ReviewPublisherOptions`); small pure helpers use positional typed parameters. Optional dependencies and test seams are explicit (`stateStore?`, `execGit?`, `sleep?`), with defaults applied via `??` or default parameters.

**Return Values:** Async boundaries return explicit `Promise<T>` contracts; Flue tool `run` callbacks return `{ output: value }` envelopes and may add `terminate: true`. Parsing/validation uses typed values, `null`, or discriminated unions, while factories return narrow interfaces that hide mutable caches and credentials.

## Module Design

**Exports:** Modules favor named exports and explicit exported types; implementation helpers and mutable state stay private. Runtime values and type exports are separated with `export type`/`import type`. Agent files export a description and one agent function; no default TypeScript exports are used in the sampled source.

**Barrel Files:** Not used. Callers import directly from concrete modules such as `../review/review-tools.ts`; compatibility forwarding exists only where an older module path must remain stable.

---

*Convention analysis: 2026-08-02*
