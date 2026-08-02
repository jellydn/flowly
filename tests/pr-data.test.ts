import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GitHubClient } from '../github/client.ts';
import { createGitDataSource } from '../review/pr-data.ts';

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

function createFakeGitHub(): GitHubClient {
  return {
    owner: 'o',
    repo: 'r',
    token: 'secret',
    apiUrl: 'https://api.github.com',
    async getPr() {
      return {
        number: 3,
        title: 'Fix login',
        body: 'Handle errors',
        user: { login: 'bob' },
        head: { sha: 'head', ref: 'feat' },
        base: { sha: 'base', ref: 'main' },
        draft: false,
      };
    },
    async submitReview() {
      return { id: 1, html_url: 'u' };
    },
  } as unknown as GitHubClient;
}

describe('git data source', () => {
  function createSource(diffOutput = DIFF, showOutput = 'line1\nline2\nline3') {
    return createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'head',
      prNumber: 3,
      github: createFakeGitHub(),
      execGit: async (args) => {
        if (args[0] === 'diff') return { stdout: diffOutput, stderr: '' };
        if (args[0] === 'show') return { stdout: showOutput, stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });
  }

  test('getMetadata combines GitHub API and parsed diff', async () => {
    const ds = createSource();
    const meta = await ds.getMetadata();
    assert.equal(meta.number, 3);
    assert.equal(meta.title, 'Fix login');
    assert.equal(meta.author, 'bob');
    assert.equal(meta.changedFiles.length, 1);
    assert.equal(meta.changedFiles[0].path, 'src/auth.ts');
    assert.equal(meta.changedFiles[0].additions, 2);
    assert.equal(meta.changedFiles[0].deletions, 1);
  });

  test('getDiff returns truncated content', async () => {
    const ds = createSource();
    const result = await ds.getDiff(3);
    assert.equal(result.truncated, true);
    assert.match(result.content, /truncated/);
  });

  test('listChangedFiles reflects skip flags', async () => {
    const ds = createSource(
      [
        'diff --git a/src/index.ts b/src/index.ts',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
        'diff --git a/yarn.lock b/yarn.lock',
        '--- a/yarn.lock',
        '+++ b/yarn.lock',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
      ].join('\n'),
    );
    const files = await ds.listChangedFiles();
    assert.equal(files.length, 2);
    assert.equal(files[0].skip, false);
    assert.equal(files[1].skip, true);
    assert.equal(files[1].skipReason, 'lockfile');
  });

  test('getDiffHunks returns ranges for a known file', async () => {
    const ds = createSource();
    const hunks = await ds.getDiffHunks('src/auth.ts');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 10);
  });

  test('getDiffHunks returns empty for an unknown file', async () => {
    const ds = createSource();
    const hunks = await ds.getDiffHunks('nope.ts');
    assert.deepEqual(hunks, []);
  });

  test('readChangedFile returns numbered lines from git show', async () => {
    const ds = createSource();
    const result = await ds.readChangedFile('src/auth.ts', 1, 2);
    assert.match(result.content, /^1: line1/);
    assert.equal(result.totalLines, 3);
    assert.equal(result.endLine, 2);
  });

  test('readChangedFile rejects path traversal', async () => {
    const ds = createSource();
    await assert.rejects(() => ds.readChangedFile('../etc/passwd'));
  });

  test('readChangedFile rejects a path not among the changed files', async () => {
    const ds = createSource();
    await assert.rejects(
      () => ds.readChangedFile('src/untouched.ts', 1, 2),
      /not among the PR's changed files/,
    );
  });

  test('readChangedFile reports truncated only when the range is cut short', async () => {
    const ds = createSource(DIFF, 'l1\nl2\nl3\nl4\nl5');
    const exact = await ds.readChangedFile('src/auth.ts', 1, 3);
    assert.equal(exact.truncated, false);
    assert.equal(exact.endLine, 3);
    const beyond = await ds.readChangedFile('src/auth.ts', 4, 99);
    assert.equal(beyond.truncated, true);
    assert.equal(beyond.endLine, 5);
  });

  test('getMetadata reports the reviewed (env) SHAs, not the API SHAs', async () => {
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'env-base',
      headSha: 'env-head',
      prNumber: 3,
      github: {
        async getPr() {
          return {
            number: 3,
            title: 't',
            body: 'b',
            user: { login: 'x' },
            head: { sha: 'api-head', ref: 'feat' },
            base: { sha: 'api-base', ref: 'main' },
            draft: false,
          };
        },
      } as unknown as GitHubClient,
      execGit: async () => ({ stdout: DIFF, stderr: '' }),
    });
    const meta = await ds.getMetadata();
    assert.equal(meta.baseSha, 'env-base');
    assert.equal(meta.headSha, 'env-head');
  });

  test('caches the diff across calls', async () => {
    let calls = 0;
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'head',
      prNumber: 3,
      github: createFakeGitHub(),
      execGit: async (args) => {
        if (args[0] === 'diff') {
          calls += 1;
          return { stdout: DIFF, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });
    await ds.getDiff(10_000);
    await ds.getDiff(10_000);
    await ds.listChangedFiles();
    assert.equal(calls, 1);
  });

  test('getIncrementalDiff returns isFirstReview when no state store', async () => {
    const ds = createSource();
    const result = await ds.getIncrementalDiff(1000);
    assert.equal(result.isFirstReview, true);
    assert.equal(result.previousReviewedSha, null);
    assert.equal(result.content, '');
    assert.equal(result.totalLines, 0);
  });

  test('getIncrementalDiff returns isFirstReview when state is null', async () => {
    const store = {
      async load() {
        return null;
      },
      async save() {},
    };
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'head',
      prNumber: 3,
      github: createFakeGitHub(),
      stateStore: store,
      execGit: async () => ({ stdout: DIFF, stderr: '' }),
    });
    const result = await ds.getIncrementalDiff(1000);
    assert.equal(result.isFirstReview, true);
    assert.equal(result.previousReviewedSha, null);
  });

  test('getIncrementalDiff runs git diff with three-dot notation from previous SHA', async () => {
    const capturedArgs: string[][] = [];
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'newhead',
      prNumber: 3,
      github: createFakeGitHub(),
      stateStore: {
        async load() {
          return {
            reviewedHeadSha: 'prevsha',
            findings: [],
            reviewedAt: 1000,
          };
        },
        async save() {},
      },
      execGit: async (args) => {
        capturedArgs.push(args);
        if (args[0] === 'diff' && args[1] === '--no-color' && args[2]?.includes('...')) {
          return { stdout: 'incremental diff content', stderr: '' };
        }
        return { stdout: DIFF, stderr: '' };
      },
    });
    const result = await ds.getIncrementalDiff(1000);
    assert.equal(result.isFirstReview, false);
    assert.equal(result.previousReviewedSha, 'prevsha');
    assert.equal(result.content, 'incremental diff content');
    // Verify the three-dot notation was used
    const incrementalCall = capturedArgs.find((a) => a[0] === 'diff' && a[2]?.includes('...'));
    assert.ok(incrementalCall, 'expected a diff call with three-dot notation');
    assert.equal(incrementalCall![2], 'prevsha...newhead');
  });

  test('getIncrementalDiff truncates long diffs', async () => {
    const longDiff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n');
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'head',
      prNumber: 3,
      github: createFakeGitHub(),
      stateStore: {
        async load() {
          return { reviewedHeadSha: 'prev', findings: [], reviewedAt: 1 };
        },
        async save() {},
      },
      execGit: async (args) => {
        if (args[0] === 'diff' && args[2]?.includes('...')) {
          return { stdout: longDiff, stderr: '' };
        }
        return { stdout: DIFF, stderr: '' };
      },
    });
    const result = await ds.getIncrementalDiff(10);
    assert.equal(result.truncated, true);
    assert.match(result.content, /truncated/);
  });

  test('getReviewState caches the state across calls', async () => {
    let loadCalls = 0;
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'head',
      prNumber: 3,
      github: createFakeGitHub(),
      stateStore: {
        async load() {
          loadCalls += 1;
          return { reviewedHeadSha: 'cached', findings: [], reviewedAt: 1 };
        },
        async save() {},
      },
      execGit: async () => ({ stdout: DIFF, stderr: '' }),
    });
    await ds.getReviewState();
    await ds.getReviewState();
    await ds.getIncrementalDiff(1000);
    assert.equal(loadCalls, 1);
  });

  test('getIncrementalDiff falls back gracefully when execGit throws (e.g. force-push)', async () => {
    const ds = createGitDataSource({
      repositoryPath: '/repo',
      baseSha: 'base',
      headSha: 'head',
      prNumber: 3,
      github: createFakeGitHub(),
      stateStore: {
        async load() {
          return { reviewedHeadSha: 'oldsha', findings: [], reviewedAt: 1 };
        },
        async save() {},
      },
      execGit: async (args) => {
        if (args[0] === 'diff' && args[2]?.includes('...')) {
          throw new Error('fatal: bad object oldsha');
        }
        return { stdout: DIFF, stderr: '' };
      },
    });
    const result = await ds.getIncrementalDiff(1000);
    assert.equal(result.isFirstReview, true);
    assert.equal(result.previousReviewedSha, 'oldsha');
    assert.equal(result.content, '');
    assert.equal(result.truncated, false);
    assert.equal(result.totalLines, 0);
  });
});
