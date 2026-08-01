# Testing Patterns

**Analysis Date:** 2026-08-01

## Test Framework

**Runner:**
- Node.js native `node:test`, executed through `tsx`. See `package.json` and imports in `tests/*.test.ts`.
- No Jest, Vitest, Playwright, or separate assertion framework is configured.
- Config: `package.json` scripts and `tsconfig.json`; no dedicated test config file.

**Assertion Library:**
- Node's `node:assert/strict`. See `tests/tools.test.ts`, `tests/planner.test.ts`, and `tests/reliability.test.ts`.

**Run Commands:**
```bash
npm test                 # Run all suites in tests/*.test.ts
npm run typecheck        # Strict TypeScript check
npm run check            # typecheck, tests, then Vite build
npx tsx --test tests/doc-aware.test.ts  # Run one focused suite
```

Coverage is not configured or required by CI. See `package.json`, `.gitignore`, and `.github/workflows/ci.yml`.

## Test File Organization

**Location:**
- Separate top-level `tests/` directory, not co-located with implementation. See `tests/`.

**Naming:**
- `<area>.test.ts`: `tools.test.ts`, `repository.test.ts`, `planner.test.ts`, `doc-aware.test.ts`, `reliability.test.ts`, and `eval-scenarios.test.ts`.

**Structure:**
```text
tests/
├── helpers.ts
├── repository.test.ts       # reader, path confinement, budget parsing
├── tools.test.ts            # list/read/code-search contracts
├── planner.test.ts          # plans, executor, replanning, reflection
├── doc-aware.test.ts        # docs search, evidence, citations, loop
├── reliability.test.ts      # failures, retries, validation, fallback
└── eval-scenarios.test.ts   # deterministic evaluation sequences
```

## Test Structure

**Suite Organization:**
```typescript
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

describe('feature', () => {
  test('behaves as expected', async () => {
    const result = await runTool(tool, input);
    assert.equal(result.inspection.used, 1);
  });
});
```

See `tests/tools.test.ts`, `tests/planner.test.ts`, and `tests/doc-aware.test.ts`.

**Patterns:**
- Use `before` to create one temporary fixture and `after` to remove it. See `tests/helpers.ts` and `tests/tools.test.ts`.
- Use `createSampleRepo()` for a deterministic repository containing docs, source, ignored dependency noise, and misleading negative-search content. See `tests/helpers.ts`.
- Create fresh readers, budgets, and tools inside individual tests to isolate mutable state. See `tests/repository.test.ts` and `tests/planner.test.ts`.
- Exercise both direct raw tool calls and higher-level planner/investigation flows. See `tests/tools.test.ts`, `tests/planner.test.ts`, and `tests/doc-aware.test.ts`.

## Mocking

**Framework:** Node primitives and dependency injection; no mocking library.

**Patterns:**
```typescript
const noDebug = () => createDebugLogger(false);
const lines: string[] = [];
const original = console.error;
console.error = (...args: unknown[]) => lines.push(args.join(' '));
try {
  // exercise the logger
} finally {
  console.error = original;
}
```

Reliability tests inject fake sleep functions, failure injectors, and mock operations rather than mocking modules. See `tests/reliability.test.ts` and `reliability/retry.ts`.

**What to Mock:**
- Provider-independent tool inputs/outputs, sleep/backoff, failure injection, console logging, and decision functions. See `tests/reliability.test.ts`, `tests/doc-aware.test.ts`, and `tests/tools.test.ts`.

**What NOT to Mock:**
- RepositoryReader filesystem behavior and path confinement; tests use real temporary directories to verify actual limits. See `tests/repository.test.ts` and `tests/tools.test.ts`.
- Deterministic planner, evidence, and answer functions; tests exercise their real pure implementations. See `tests/planner.test.ts` and `tests/doc-aware.test.ts`.

## Fixtures and Factories

**Test Data:**
```typescript
const root = await createSampleRepo();
const repository = await createRepositoryReader(root);
const budget = createStepBudget(8);
const tool = createSearchCodeTool(repository, budget, noDebug());
const result = await runTool(tool, { query: 'login', path: '.', caseSensitive: false });
```

**Location:**
- `tests/helpers.ts` creates temporary fixture repositories and supplies `toolContext()` / `runTool()` helpers for Flue v2 contexts and `{ output: value }` envelopes.
- `eval/fixtures/sample-repo/` is a committed, smaller live-evaluation fixture.

## Coverage

**Requirements:** None enforced by configuration or CI. The suite is broad but there is no numeric coverage threshold. See `.github/workflows/ci.yml`.

**View Coverage:**
```bash
# No coverage script is configured; use npm test for behavioral coverage.
npm test
```

## Test Types

**Unit Tests:**
- Pure planner, reflection, call-tracker, evidence, answer, error classification, retry, validation, and parsing behavior. See `tests/planner.test.ts`, `tests/doc-aware.test.ts`, and `tests/reliability.test.ts`.

**Integration Tests:**
- Tool factories against real temporary repositories; planner/executor against the fixture; resilient wrapper and fallback flows. See `tests/tools.test.ts`, `tests/repository.test.ts`, `tests/planner.test.ts`, and `tests/reliability.test.ts`.

**E2E Tests:**
- No automated end-to-end browser or live-provider suite. `eval/run-eval.sh` supports manual/live model observation and explicitly avoids fake deterministic LLM assertions. See `eval/README.md`.

## Common Patterns

**Async Testing:**
```typescript
await assert.rejects(
  async () => tool.run(toolContext({ path: '../outside' })),
  /escapes/,
);
```

See `tests/tools.test.ts` and `tests/repository.test.ts`.

**Error Testing:**
```typescript
assert.throws(() => budget.consume('search_code'), /budget exhausted/);
assert.equal(classified.retryable, false);
```

See `tests/repository.test.ts` and `tests/reliability.test.ts`.

---

*Testing analysis: 2026-08-01*
