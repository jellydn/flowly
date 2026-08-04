import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createReliabilityLogger } from '../reliability/observability.ts';
import { noFailureInjection } from '../reliability/failure-injection.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import { createSearchCodeTool } from '../tools/search-code.ts';
import { createSearchDocsTool } from '../tools/search-docs.ts';
import {
  deriveKnownPath,
  withSearchReadFallback,
} from '../reliability/fallback-tool.ts';
import { wrapToolWithReliability } from '../reliability/resilient-tool.ts';
import type { RetryConfig, SleepFn } from '../reliability/retry.ts';
import { createSampleRepo, removeRepo, runTool } from './helpers.ts';

const retryConfig: RetryConfig = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 1,
  timeoutMs: 1_000,
};

const noDebug = () => createDebugLogger(false);
const noReliabilityLog = () => createReliabilityLogger(false);
const instantSleep: SleepFn = () => Promise.resolve();

let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

describe('deriveKnownPath', () => {
  test('treats a concrete file path as the known path', () => {
    assert.equal(deriveKnownPath({ path: 'src/auth.ts' }), 'src/auth.ts');
  });

  test('rejects the default, empty, and directory-scoped paths', () => {
    assert.equal(deriveKnownPath({ path: '.' }), undefined);
    assert.equal(deriveKnownPath({ path: '' }), undefined);
    assert.equal(deriveKnownPath({ path: 'src/' }), undefined);
    assert.equal(deriveKnownPath({}), undefined);
    assert.equal(deriveKnownPath({ path: 42 }), undefined);
  });
});

describe('withSearchReadFallback', () => {
  test('primary success passes the search result through unchanged', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = withSearchReadFallback(
      createSearchCodeTool(repository),
      createReadFileTool(repository),
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{
      matches: unknown[];
      fallbackUsed?: boolean;
      inspection: { used: number };
    }>(tool, { query: 'authentication', path: '.', caseSensitive: false });
    assert.ok(result.matches.length > 0);
    assert.equal(result.fallbackUsed, undefined);
    assert.equal(result.inspection.used, 1);
    assert.equal(budget.used, 1);
  });

  test('transient search failure falls back to read_file with the known path', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const failingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test search',
      input: undefined,
      output: undefined,
      async run() {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };
    const readFile = createReadFileTool(repository);
    const tool = withSearchReadFallback(
      failingSearch,
      readFile,
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{
      content?: string;
      fallbackUsed?: boolean;
      note?: string;
    }>(tool, { query: 'x', path: 'src/auth.ts', caseSensitive: false });
    assert.equal(result.fallbackUsed, true);
    assert.match(result.content ?? '', /issueToken/);
    assert.match(result.note ?? '', /fallback/i);
    assert.equal(budget.used, 2);
  });

  test('search_docs also falls back', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const failingSearch: ToolDefinition = {
      name: 'search_docs',
      description: 'test docs search',
      input: undefined,
      output: undefined,
      async run() {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };
    const tool = withSearchReadFallback(
      failingSearch,
      createReadFileTool(repository),
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{ fallbackUsed?: boolean; content?: string }>(tool, {
      query: 'architecture',
      path: 'docs/architecture.md',
      caseSensitive: false,
    });
    assert.equal(result.fallbackUsed, true);
    assert.match(result.content ?? '', /layered design/);
  });

  test('no known path means no fallback; partial message returned', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const failingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test search',
      input: undefined,
      output: undefined,
      async run() {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };
    const tool = withSearchReadFallback(
      failingSearch,
      createReadFileTool(repository),
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{
      fallbackUsed?: boolean;
      partialMessage?: string;
      inspection: { used: number };
    }>(tool, { query: 'x', path: '.', caseSensitive: false });
    // No known path means the fallback never ran; the partial message explains why.
    assert.equal(result.fallbackUsed, false);
    assert.ok(result.partialMessage);
    assert.equal(result.inspection.used, 1);
    assert.equal(budget.used, 1);
  });

  test('the composed tool is sealed against re-wrapping', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const composed = withSearchReadFallback(
      createSearchCodeTool(repository),
      createReadFileTool(repository),
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    assert.throws(
      () =>
        wrapToolWithReliability(
          composed,
          budget,
          noDebug(),
          retryConfig,
          noReliabilityLog(),
          noFailureInjection,
        ),
      /already composed/i,
    );
  });

  test('rejects a non-search primary tool', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    assert.throws(
      () =>
        withSearchReadFallback(
          createReadFileTool(repository),
          createReadFileTool(repository),
          budget,
          noDebug(),
          retryConfig,
          noReliabilityLog(),
          { sleep: instantSleep },
        ),
      /search tool/i,
    );
  });

  test('budget exhaustion before the fallback is reported as a partial message', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(1);
    const failingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test search',
      input: undefined,
      output: undefined,
      async run() {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };
    const tool = withSearchReadFallback(
      failingSearch,
      createReadFileTool(repository),
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{ fallbackUsed?: boolean; partialMessage?: string }>(tool, {
      query: 'x',
      path: 'src/auth.ts',
      caseSensitive: false,
    });
    assert.equal(result.fallbackUsed, false);
    assert.match(result.partialMessage ?? '', /budget/i);
    assert.equal(budget.used, 1);
  });

  test('permanent search failure does not trigger the fallback', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const authFailingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test search',
      input: undefined,
      output: undefined,
      async run() {
        throw new Error('HTTP 401 Unauthorized');
      },
    };
    const tool = withSearchReadFallback(
      authFailingSearch,
      createReadFileTool(repository),
      budget,
      noDebug(),
      retryConfig,
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{ fallbackUsed?: boolean; partialMessage?: string }>(tool, {
      query: 'x',
      path: 'src/auth.ts',
      caseSensitive: false,
    });
    assert.equal(result.fallbackUsed, false);
    assert.ok(result.partialMessage);
  });
});

describe('withSearchReadFallback with reliability semantics', () => {
  test('retries happen inside the seam but consume only one budget slot per primary attempt', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    let calls = 0;
    const flakySearch: ToolDefinition = {
      name: 'search_code',
      description: 'test search',
      input: undefined,
      output: undefined,
      async run() {
        calls += 1;
        if (calls < 3) throw new Error('HTTP 503 Service Unavailable');
        return {
          output: {
            matches: [{ path: 'src/auth.ts', line: 1, excerpt: 'login' }],
            filesSearched: 1,
            query: 'x',
            path: '.',
            truncated: false,
          },
        };
      },
    };
    const tool = withSearchReadFallback(
      flakySearch,
      createReadFileTool(repository),
      budget,
      noDebug(),
      { ...retryConfig, maxAttempts: 3 },
      noReliabilityLog(),
      { sleep: instantSleep },
    );
    const result = await runTool<{ matches: unknown[]; inspection: { used: number } }>(tool, {
      query: 'x',
      path: '.',
      caseSensitive: false,
    });
    assert.equal(calls, 3);
    assert.ok(result.matches.length > 0);
    assert.equal(result.inspection.used, 1);
    assert.equal(budget.used, 1);
  });
});
