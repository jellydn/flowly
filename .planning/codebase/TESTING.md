# Testing Patterns

**Analysis Date:** 2026-08-02

## Test Framework

**Runner:**
- Node.js native `node:test` (Node >=22.19.0), launched through `tsx` 4.20.6
- Config: `package.json` (no separate test-runner config)

**Assertion Library:**
- Node's strict built-in assertions via `node:assert/strict`; tests use `equal`, `deepEqual`, `ok`, `match`, `doesNotMatch`, `throws`, and `rejects`.

**Run Commands:**
```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode (forward Node test-runner option through tsx)
# No coverage command is configured
```

## Test File Organization

**Location:**
- Tests are separate from production code under `tests/`; shared fixture helpers are in `tests/helpers.ts`. Deterministic evaluation behavior is tested in `tests/eval-scenarios.test.ts`, while `eval/run-eval.sh` performs optional live model-driven scenarios against `eval/fixtures/sample-repo/`.

**Naming:**
- Files use `<concern>.test.ts`, such as `tests/repository.test.ts`, `tests/review-state-store.test.ts`, and `tests/github-adapter.test.ts`. Suite and test names describe observable behavior in plain language.

**Structure:**
```
tests/
├── helpers.ts
├── repository.test.ts
├── tools.test.ts
├── planner.test.ts
├── reliability.test.ts
├── review-*.test.ts
├── github-adapter.test.ts
└── eval-scenarios.test.ts
eval/
├── run-eval.sh
└── fixtures/sample-repo/
```

## Test Structure

**Suite Organization:**
```typescript
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

describe('repository search', () => {
  test('searches only the requested source scope', async () => {
    const result = await searchRepository(await createRepositoryReader(root), {
      scope: 'source',
      path: '.',
      query: 'login',
      caseSensitive: false,
    });
    assert.ok(result.filesSearched > 0);
    assert.ok(result.matches.some((match) => match.path === 'src/auth.ts'));
  });
});
```

**Patterns:**
- Setup creates fresh repositories, budgets, tools, publishers, and in-memory fakes per test; suites that share a temporary repository use async `before`/`after` hooks from `node:test`.
- Teardown removes temporary repositories/files/symlinks in `after` or `finally`, and restores monkey-patched globals such as `console.error` in `finally`.
- Assertions check both positive output and guardrails: exact values/shapes with `equal`/`deepEqual`, partial text with `match`, invariants with `ok`, and failure behavior with `throws`/`rejects`. Tests commonly assert side effects and non-effects (call counts, no leaked paths, no state saved after failure).

## Mocking

**Framework:** Hand-written fakes and dependency injection; no mocking library is installed.

**Patterns:**
```typescript
function createFakeDataSource(): PrDataSource {
  return {
    async getMetadata() {
      return {
        number: 7,
        title: 'Fix auth',
        body: 'Improves error handling',
        author: 'alice',
        baseSha: 'aaa',
        headSha: 'hhh',
        changedFiles: [],
      };
    },
    async getDiff() {
      return { content: DIFF, truncated: false, totalLines: DIFF.split('\n').length };
    },
    async listChangedFiles() {
      return [];
    },
    async getDiffHunks() {
      return [];
    },
    async readChangedFile(path) {
      return {
        path,
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        content: '1: content',
        truncated: false,
      };
    },
    async getReviewState() {
      return null;
    },
    async getIncrementalDiff() {
      return {
        isFirstReview: true,
        previousReviewedSha: null,
        content: '',
        truncated: false,
        totalLines: 0,
      };
    },
  };
}
```

**What to Mock:**
- External or nondeterministic boundaries: `GitHubClient`, PR data/state stores, Git command execution, Flue tool implementations, sleep/timeouts, failure injection, decision functions, and log sinks. Fakes retain submitted payloads or saved states for assertions.

**What NOT to Mock:**
- Repository filesystem behavior, path traversal, symlinks, file-size limits, source/documentation search, diff parsing, schemas, and budget accounting are exercised with real implementations and temporary files. Deterministic tests do not mock an LLM; they simulate expected tool sequences instead.

## Fixtures and Factories

**Test Data:**
```typescript
const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,3 +10,5 @@',
  ' context',
  '-old',
  '+new one',
  '+new two',
  ' context',
].join('\n');

before(async () => {
  root = await createSampleRepo();
});
```

**Location:**
- `tests/helpers.ts` creates disposable sample repositories for normal tests. Unified diffs, review states, and fake clients/data sources are generally declared near the tests that consume them. The committed, deliberately unformatted scenario repository is under `eval/fixtures/sample-repo/` and is excluded from oxfmt/oxlint by `prek.toml`.

## Coverage

**Requirements:** None enforced; no coverage provider, script, report directory, or numeric threshold is configured.

**View Coverage:**
```bash
# Not available: add and configure a coverage provider before generating a report
```

## Test Types

**Unit Tests:**
- Pure parsing, filtering, schemas, limits, retry/error classification, state encoding, planner logic, answer formatting, and budget behavior are tested directly with compact inputs and strict assertions.

**Integration Tests:**
- Tool/repository tests combine real temporary filesystems with actual readers and Flue tool definitions; review tests integrate schemas, diff parsing, trusted publishing, and fake GitHub/state boundaries. `tests/eval-scenarios.test.ts` deterministically exercises expected observe → act → reflect tool sequences without a provider key.

**E2E Tests:**
- No automated E2E framework is used. `eval/run-eval.sh` is a manual live-agent evaluation requiring an LLM provider key; it runs five prompts, enables safe debug logging, and tolerates individual scenario failures with `|| true` for inspection rather than CI gating.

## Common Patterns

**Async Testing:**
```typescript
test('rejects traversal and absolute paths', async () => {
  const repository = await createRepositoryReader(root);
  const tool = createReadFileTool(repository, createStepBudget(8), noDebug());
  await assert.rejects(
    async () =>
      tool.run({
        toolCallId: 'test',
        log: { info() {}, warn() {}, error() {} },
        data: { path: '../outside.ts', startLine: 1 },
      }),
    /read_file failed.*escapes/,
  );
});
```

**Error Testing:**
```typescript
test('rejects an invalid review result', async () => {
  const client = createFakeClient();
  const publisher = createReviewPublisher({
    client,
    prNumber: 1,
    headSha: 'head123',
    diffProvider: async () => DIFF,
    limits: DEFAULT_REVIEW_LIMITS,
  });

  await assert.rejects(
    () => publisher.publish({ verdict: 'COMMENT' }),
    /invalid review result/,
  );
  assert.equal(client.submitted.length, 0);
});
```

---

*Testing analysis: 2026-08-02*
