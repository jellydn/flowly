import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildRepositoryRelationshipIndex } from '../index/repository-relationship-index.ts';
import { withInspectionBudget } from '../reliability/resilient-tool.ts';
import { createRelatedContextTool } from '../tools/related-context.ts';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createSampleRepo, removeRepo, runTool } from './helpers.ts';

let root: string;

before(async () => {
  root = await createSampleRepo();
  await mkdir(path.join(root, '.github'), { recursive: true });
  await writeFile(path.join(root, '.github', 'CODEOWNERS'), 'src/** @platform\n');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { valibot: '^1.0.0' }, devDependencies: { tsx: '^4.0.0' } }),
  );
  await writeFile(
    path.join(root, 'docs', 'relationships.md'),
    'See [auth](../src/auth.ts) and jellydn/flowly#120. Also https://github.com/jellydn/flowly/pull/42.\n',
  );
  await mkdir(path.join(root, 'packages', 'bad'), { recursive: true });
  await writeFile(path.join(root, 'packages', 'bad', 'package.json'), '{not json');
});

after(async () => {
  await removeRepo(root);
});

describe('repository relationship index', () => {
  test('extracts imports, reverse imports, ownership, dependencies, docs, and issue references', async () => {
    const index = await buildRepositoryRelationshipIndex(await createRepositoryReader(root));

    assert.deepEqual(
      index.relationships('file:src/index.ts', 'imports', 20).map((edge) => edge.target.label),
      ['src/auth.ts', 'src/config.ts'],
    );
    assert.equal(
      index.relationships('file:src/auth.ts', 'imported_by', 20)[0]?.target.label,
      'src/index.ts',
    );
    assert.equal(
      index.relationships('file:src/auth.ts', 'owned_by', 20)[0]?.target.label,
      '@platform',
    );
    assert.deepEqual(
      index.relationships('file:package.json', 'depends_on', 20).map((edge) => edge.target.label),
      ['tsx', 'valibot'],
    );
    assert.equal(
      index.relationships('file:src/auth.ts', 'documented_by', 20)[0]?.target.label,
      'docs/relationships.md',
    );
    assert.deepEqual(
      index
        .relationships('file:docs/relationships.md', 'references_issue', 20)
        .map((edge) => `${edge.target.kind}:${edge.target.label}`),
      ['issue:#120', 'pull:#42'],
    );
  });

  test('deduplicates edges and produces stable identifiers and ordering', async () => {
    const repository = await createRepositoryReader(root);
    const first = await buildRepositoryRelationshipIndex(repository);
    const second = await buildRepositoryRelationshipIndex(repository);
    const firstEdges = first.relationships('file:src/index.ts', undefined, 20);
    const secondEdges = second.relationships('file:src/index.ts', undefined, 20);

    assert.deepEqual(firstEdges, secondEdges);
    assert.equal(new Set(firstEdges.map((edge) => edge.id)).size, firstEdges.length);
    assert.ok(firstEdges.every((edge) => edge.citation.path && edge.citation.line >= 1));
  });

  test('skips malformed metadata with diagnostics while preserving valid edges', async () => {
    const index = await buildRepositoryRelationshipIndex(await createRepositoryReader(root));
    assert.ok(index.diagnostics.some((item) => /malformed package manifest/.test(item.message)));
    assert.ok(index.relationships('file:src/auth.ts', 'imports', 20).length > 0);
  });
});

describe('related_context tool', () => {
  test('validates paths, filters and limits results, and consumes one shared step', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(1);
    const tool = withInspectionBudget(
      createRelatedContextTool(repository),
      budget,
      createDebugLogger(false),
    );
    const result = await runTool<{
      path: string;
      relationships: Array<{ relationship: string }>;
      resultCount: number;
    }>(tool, { path: 'src/index.ts', relationship: 'imports', limit: 1 });

    assert.equal(result.path, 'src/index.ts');
    assert.equal(result.resultCount, 1);
    assert.equal(result.relationships[0]?.relationship, 'imports');
    assert.equal(budget.used, 1);
    await assert.rejects(() => runTool(tool, { path: '../escape' }), /budget exhausted/i);
  });

  test('rejects paths outside the repository before returning graph data', async () => {
    const repository = await createRepositoryReader(root);
    const tool = createRelatedContextTool(repository);
    await assert.rejects(() => runTool(tool, { path: '../escape' }), /escapes/);
  });
});
