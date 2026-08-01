import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRepositoryReader } from '../tools/repository.ts';
import { searchRepository } from '../tools/repository-search.ts';
import { createSampleRepo, removeRepo } from './helpers.ts';

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
    // Code search intentionally includes Markdown as searchable text so that
    // repository notes can provide leads; search_docs narrows to documentation.
    assert.ok(result.matches.some((match) => match.path === 'README.md'));
  });

  test('searches only the requested documentation scope', async () => {
    const result = await searchRepository(await createRepositoryReader(root), {
      scope: 'documentation',
      path: '.',
      query: 'authentication',
      caseSensitive: false,
    });
    assert.ok(result.filesSearched > 0);
    assert.ok(result.matches.some((match) => match.path === 'README.md'));
    assert.ok(!result.matches.some((match) => match.path === 'src/auth.ts'));
  });

  test('honours cancellation before scanning candidates', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(
      searchRepository(await createRepositoryReader(root), {
        scope: 'source',
        path: '.',
        query: 'login',
        caseSensitive: false,
        signal: controller.signal,
      }),
      /cancel/i,
    );
  });
});
