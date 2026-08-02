import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findFileDiff, hunkForLine, parseUnifiedDiff, truncateDiff } from '../review/diff.ts';

const SAMPLE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 111..222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,7 +10,9 @@',
  ' context line',
  ' context line',
  '-old line',
  '+new line one',
  '+new line two',
  ' context line',
  ' context line',
  ' context line',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 000..333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,3 @@',
  '+export const x = 1;',
  '+export const y = 2;',
  '+export const z = 3;',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  'index 444..000',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const gone = 1;',
  '-export const also = 2;',
].join('\n');

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);

  test('parses one entry per file', () => {
    assert.equal(files.length, 3);
  });

  test('detects modified status', () => {
    const auth = findFileDiff(files, 'src/auth.ts');
    assert.equal(auth?.status, 'modified');
    assert.equal(auth?.additions, 2);
    assert.equal(auth?.deletions, 1);
  });

  test('detects added status from new file mode', () => {
    const added = findFileDiff(files, 'src/new.ts');
    assert.equal(added?.status, 'added');
    assert.equal(added?.additions, 3);
    assert.equal(added?.deletions, 0);
    assert.equal(added?.oldPath, undefined);
  });

  test('detects deleted status', () => {
    const deleted = findFileDiff(files, 'src/old.ts');
    assert.equal(deleted?.status, 'deleted');
    assert.equal(deleted?.deletions, 2);
  });

  test('extracts hunk line ranges', () => {
    const auth = findFileDiff(files, 'src/auth.ts');
    assert.deepEqual(auth?.hunks, [{ oldStart: 10, oldEnd: 16, newStart: 10, newEnd: 18 }]);
  });

  test('handles single-line hunk headers (no count)', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -5 +5 @@', '+x'].join(
      '\n',
    );
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed[0].hunks[0].oldEnd, 5);
    assert.equal(parsed[0].hunks[0].newEnd, 5);
  });

  test('returns empty array for empty input', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
  });

  test('handles rename', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed[0].status, 'renamed');
    assert.equal(parsed[0].path, 'new.ts');
    assert.equal(parsed[0].oldPath, 'old.ts');
  });

  test('counts added/deleted lines whose content starts with ++/--', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '---i;',
      '-plain',
      '+++i;',
      '+plain',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed[0].additions, 2);
    assert.equal(parsed[0].deletions, 2);
  });

  test('ignores diff entries without resolved path (mode-only / binary without markers)', () => {
    const diff = [
      'diff --git a/bin.dat b/bin.dat',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/valid.ts b/valid.ts',
      '--- a/valid.ts',
      '+++ b/valid.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].path, 'valid.ts');
  });
});

describe('hunkForLine', () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);

  test('returns the containing hunk', () => {
    const auth = findFileDiff(files, 'src/auth.ts')!;
    const hunk = hunkForLine(auth, 12);
    assert.equal(hunk?.newStart, 10);
    assert.equal(hunk?.newEnd, 18);
  });

  test('returns the nearest hunk for out-of-range lines', () => {
    const auth = findFileDiff(files, 'src/auth.ts')!;
    const hunk = hunkForLine(auth, 100);
    assert.equal(hunk?.newEnd, 18);
  });

  test('returns null for a file with no hunks', () => {
    const file = {
      path: 'x',
      status: 'modified' as const,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    assert.equal(hunkForLine(file, 1), null);
  });
});

describe('truncateDiff', () => {
  test('does not truncate under the limit', () => {
    const result = truncateDiff('a\nb\nc', 10);
    assert.equal(result.truncated, false);
    assert.equal(result.totalLines, 3);
  });

  test('truncates and appends a marker', () => {
    const result = truncateDiff('a\nb\nc\nd\ne', 2);
    assert.equal(result.truncated, true);
    assert.equal(result.totalLines, 5);
    assert.match(result.content, /truncated/);
  });
});
