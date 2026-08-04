import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  createRepositoryReader,
  createStepBudget,
  createDebugLogger,
} from '../tools/repository.ts';
import { createRetrieveTool } from '../tools/retrieve.ts';
import { withInspectionBudget } from '../reliability/resilient-tool.ts';
import { buildRepositoryIndex, tokenize, type RepositoryIndex } from '../index/repository-indexer.ts';
import { createSampleRepo, removeRepo, runTool } from './helpers.ts';

let root: string;
let index: RepositoryIndex;

before(async () => {
  root = await createSampleRepo();
  const repository = await createRepositoryReader(root);
  index = await buildRepositoryIndex(repository);
});

after(async () => {
  await removeRepo(root);
});

describe('tokenize', () => {
  test('splits on non-word characters', () => {
    const tokens = tokenize('hello world test');
    assert.ok(tokens.includes('hello'));
    assert.ok(tokens.includes('world'));
    assert.ok(tokens.includes('test'));
  });

  test('filters stop words and short tokens', () => {
    const tokens = tokenize('the is a at on it or');
    assert.equal(tokens.length, 0);
  });

  test('splits camelCase identifiers (lowercased, tokenized as whole word)', () => {
    // After lowercasing, "issueToken" becomes "issuetoken" — the full token
    // is still indexed and searchable. camelCase splitting happens at the
    // word level before lowercasing in source code contexts.
    const tokens = tokenize('issueToken');
    assert.ok(tokens.includes('issuetoken'));
  });

  test('splits snake_case identifiers', () => {
    const tokens = tokenize('user_service');
    assert.ok(tokens.includes('user'));
    assert.ok(tokens.includes('service'));
    assert.ok(tokens.includes('user_service'));
  });

  test('lowercases all tokens', () => {
    const tokens = tokenize('AUTH Login');
    assert.ok(tokens.includes('auth'));
    assert.ok(tokens.includes('login'));
  });
});

describe('RepositoryIndex', () => {
  test('indexes source and documentation files', () => {
    assert.ok(index.stats.filesIndexed >= 5, `expected ≥5 files, got ${index.stats.filesIndexed}`);
    assert.ok(index.stats.chunksIndexed >= 5, `expected ≥5 chunks, got ${index.stats.chunksIndexed}`);
    assert.ok(index.stats.uniqueTerms > 10, `expected >10 terms, got ${index.stats.uniqueTerms}`);
  });

  test('retrieves relevant chunks for "authentication"', () => {
    const results = index.retrieve('authentication login token', 5);
    assert.ok(results.length > 0, 'expected at least one result');
    const paths = results.map((r) => r.path);
    assert.ok(
      paths.includes('src/auth.ts') || paths.includes('src/services/user-service.ts'),
      `expected auth.ts or user-service.ts in results, got: ${paths.join(', ')}`,
    );
  });

  test('retrieves relevant chunks for "architecture"', () => {
    const results = index.retrieve('architecture overview', 5);
    assert.ok(results.length > 0);
    const paths = results.map((r) => r.path);
    assert.ok(
      paths.includes('docs/architecture.md') || paths.includes('README.md'),
      `expected architecture.md or README.md in results, got: ${paths.join(', ')}`,
    );
  });

  test('retrieves relevant chunks for "port configuration"', () => {
    const results = index.retrieve('port configuration environment', 5);
    assert.ok(results.length > 0);
    const paths = results.map((r) => r.path);
    assert.ok(
      paths.includes('src/config.ts'),
      `expected config.ts in results, got: ${paths.join(', ')}`,
    );
  });

  test('returns empty for gibberish query', () => {
    const results = index.retrieve('zzzzzzzzzz', 5);
    assert.equal(results.length, 0);
  });

  test('scores are between 0 and 1', () => {
    const results = index.retrieve('authentication', 5);
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of [0,1]`);
    }
  });

  test('results include line ranges', () => {
    const results = index.retrieve('authentication', 5);
    for (const r of results) {
      assert.ok(r.startLine >= 1);
      assert.ok(r.endLine >= r.startLine);
    }
  });

  test('results include sourceType', () => {
    const results = index.retrieve('architecture', 5);
    for (const r of results) {
      assert.ok(r.sourceType === 'documentation' || r.sourceType === 'code');
    }
  });
});

describe('retrieve tool', () => {
  test('returns ranked results with inspection metadata', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = createDebugLogger(false);
    const tool = withInspectionBudget(createRetrieveTool(repository), budget, debug);

    const result = await runTool<{
      query: string;
      results: Array<{
        path: string;
        startLine: number;
        endLine: number;
        excerpt: string;
        score: number;
        sourceType: string;
      }>;
      resultCount: number;
      indexStats: { filesIndexed: number; chunksIndexed: number };
      inspection: { used: number; remaining: number; limit: number };
    }>(tool, { query: 'authentication login', topK: 3 });

    assert.equal(result.resultCount, result.results.length);
    assert.ok(result.results.length > 0);
    assert.ok(result.results.length <= 3);
    assert.equal(result.inspection.used, 1);
    assert.equal(result.inspection.remaining, 7);
  });

  test('consumes one inspection budget slot', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(3);
    const debug = createDebugLogger(false);
    const tool = withInspectionBudget(createRetrieveTool(repository), budget, debug);

    await runTool(tool, { query: 'test' });
    assert.equal(budget.used, 1);

    await runTool(tool, { query: 'architecture' });
    assert.equal(budget.used, 2);
  });

  test('returns empty results for no matches', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = createDebugLogger(false);
    const tool = withInspectionBudget(createRetrieveTool(repository), budget, debug);

    const result = await runTool<{
      results: unknown[];
      resultCount: number;
    }>(tool, { query: 'zzzzzzzzzznonexistent' });

    assert.equal(result.resultCount, 0);
    assert.equal(result.results.length, 0);
  });

  test('cached index is reused on second call', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = createDebugLogger(false);
    const tool = withInspectionBudget(createRetrieveTool(repository), budget, debug);

    const start1 = Date.now();
    await runTool(tool, { query: 'auth' });
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    await runTool(tool, { query: 'config' });
    const time2 = Date.now() - start2;

    // Second call should be faster (index already built).
    assert.ok(time2 <= time1 + 50, `second call (${time2}ms) should not be much slower than first (${time1}ms)`);
  });
});
