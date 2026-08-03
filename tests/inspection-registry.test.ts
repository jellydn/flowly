import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createInspectionRegistry } from '../tools/inspection-registry.ts';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createReliabilityLogger } from '../reliability/observability.ts';
import { noFailureInjection } from '../reliability/failure-injection.ts';
import { createSampleRepo, removeRepo, runTool } from './helpers.ts';
import type { RetryConfig } from '../reliability/retry.ts';

const retryConfig: RetryConfig = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 1,
  timeoutMs: 1_000,
};

const noDebug = () => createDebugLogger(false);

let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

describe('inspection registry', () => {
  test('builds one reliable tool per inspection contract in stable order', async () => {
    const budget = createStepBudget(5);
    const registry = createInspectionRegistry({
      repository: await createRepositoryReader(root),
      budget,
      debug: noDebug(),
      retryConfig,
      reliabilityLog: createReliabilityLogger(false),
      injector: noFailureInjection,
    });

    assert.deepEqual(
      registry.list.map((tool) => tool.name),
      ['list_files', 'read_file', 'search_code', 'search_docs', 'retrieve'],
    );
    assert.equal(registry.get('read_file'), registry.tools.read_file);
    assert.equal(registry.list.length, 5);

    const listResult = await runTool<{ entries: unknown[] }>(registry.get('list_files'), {
      path: '.',
      depth: 1,
    });
    const readResult = await runTool<{ content: string }>(registry.get('read_file'), {
      path: 'README.md',
      startLine: 1,
    });
    const codeResult = await runTool<{ matches: unknown[] }>(registry.get('search_code'), {
      query: 'authentication',
      path: '.',
      caseSensitive: false,
    });
    const docsResult = await runTool<{ matches: unknown[] }>(registry.get('search_docs'), {
      query: 'authentication',
      path: '.',
      caseSensitive: false,
    });
    const retrieveResult = await runTool<{ results: unknown[] }>(registry.get('retrieve'), {
      query: 'authentication',
    });

    assert.ok(listResult.entries.length > 0);
    assert.match(readResult.content, /Sample Repository/);
    assert.ok(codeResult.matches.length > 0);
    assert.ok(docsResult.matches.length > 0);
    assert.ok(retrieveResult.results.length > 0);
    assert.equal(budget.used, 5);
  });
});
