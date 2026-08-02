import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyFile, shouldSkipFile } from '../review/filters.ts';

describe('review filters', () => {
  test('skips lockfiles', () => {
    assert.equal(shouldSkipFile('package-lock.json'), true);
    assert.equal(shouldSkipFile('apps/web/yarn.lock'), true);
    assert.equal(classifyFile('pnpm-lock.yaml').reason, 'lockfile');
  });

  test('skips vendored paths', () => {
    assert.equal(shouldSkipFile('vendor/lib.go'), true);
    assert.equal(shouldSkipFile('src/third_party/foo.c'), true);
    assert.equal(classifyFile('vendor/x.ts').reason, 'vendored');
  });

  test('skips snapshots', () => {
    assert.equal(shouldSkipFile('test/__snapshots__/foo.test.ts.snap'), true);
    assert.equal(shouldSkipFile('foo.test.ts.snap'), true);
    assert.equal(classifyFile('a.snap').reason, 'snapshot');
  });

  test('skips generated/minified files', () => {
    assert.equal(shouldSkipFile('dist/bundle.min.js'), true);
    assert.equal(shouldSkipFile('src/proto.gen.ts'), true);
    assert.equal(classifyFile('x.min.js').reason, 'generated');
  });

  test('skips binary files', () => {
    assert.equal(shouldSkipFile('assets/logo.png'), true);
    assert.equal(classifyFile('a.pdf').reason, 'binary');
  });

  test('does not skip hand-written source', () => {
    assert.equal(shouldSkipFile('src/auth.ts'), false);
    assert.equal(shouldSkipFile('lib/index.js'), false);
    assert.equal(shouldSkipFile('README.md'), false);
    assert.equal(shouldSkipFile('agents/repo-assistant.ts'), false);
  });
});
