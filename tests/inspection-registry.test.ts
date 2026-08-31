import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
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
    const budget = createStepBudget(6);
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
      ['list_files', 'read_file', 'search_code', 'search_docs', 'retrieve', 'related_context'],
    );
    assert.equal(registry.get('read_file'), registry.tools.read_file);
    assert.equal(registry.list.length, 6);

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
    const relatedResult = await runTool<{ relationships: unknown[] }>(
      registry.get('related_context'),
      { path: 'src/auth.ts' },
    );

    assert.ok(listResult.entries.length > 0);
    assert.match(readResult.content, /Sample Repository/);
    assert.ok(codeResult.matches.length > 0);
    assert.ok(docsResult.matches.length > 0);
    assert.ok(retrieveResult.results.length > 0);
    assert.ok(relatedResult.relationships.length > 0);
    assert.equal(budget.used, 6);
  });

  test('searchFallback option composes the search tools with read fallback', async () => {
    const budget = createStepBudget(5);
    const registry = createInspectionRegistry({
      repository: await createRepositoryReader(root),
      budget,
      debug: noDebug(),
      retryConfig,
      reliabilityLog: createReliabilityLogger(false),
      injector: noFailureInjection,
      searchFallback: true,
    });

    // Same names and order; only the search tools' run behaviour changes.
    assert.deepEqual(
      registry.list.map((tool) => tool.name),
      ['list_files', 'read_file', 'search_code', 'search_docs', 'retrieve', 'related_context'],
    );

    const searchTool = registry.get('search_code') as ToolDefinition;
    assert.equal(searchTool.name, 'search_code');
    // A normal search still returns matches and does not invoke the fallback.
    const codeResult = await runTool<{ matches: unknown[]; fallbackUsed?: boolean }>(
      registry.get('search_code'),
      { query: 'authentication', path: '.', caseSensitive: false },
    );
    assert.ok(codeResult.matches.length > 0);
    assert.equal(codeResult.fallbackUsed, undefined);
    assert.equal(budget.used, 1);

    // The read_file tool remains the plain reliable version.
    const readResult = await runTool<{ content: string }>(registry.get('read_file'), {
      path: 'README.md',
      startLine: 1,
    });
    assert.match(readResult.content, /Sample Repository/);
    assert.equal(budget.used, 2);
  });

  test('searchFallback triggers the fallback read on transient search failure', async () => {
    const budget = createStepBudget(5);
    const registry = createInspectionRegistry({
      repository: await createRepositoryReader(root),
      budget,
      debug: noDebug(),
      retryConfig,
      reliabilityLog: createReliabilityLogger(false),
      // Fail the first search_code call, then read_file works normally.
      injector: {
        maybeFail: (operation) =>
          operation === 'search_code' ? new Error('HTTP 503 Service Unavailable') : undefined,
        shouldTimeout: () => false,
        shouldMalform: () => false,
      },
      searchFallback: true,
    });

    const result = await runTool<{ fallbackUsed?: boolean; content?: string; note?: string }>(
      registry.get('search_code'),
      { query: 'auth', path: 'src/auth.ts', caseSensitive: false },
    );
    assert.equal(result.fallbackUsed, true);
    assert.match(result.content ?? '', /issueToken/);
    assert.match(result.note ?? '', /fallback/i);
    // Primary search attempt + fallback read each consume one slot.
    assert.equal(budget.used, 2);
  });
});
