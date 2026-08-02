import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_REVIEW_LIMITS, parseReviewLimits } from '../review/limits.ts';

describe('review limits', () => {
  test('defaults match the proposal', () => {
    assert.deepEqual(DEFAULT_REVIEW_LIMITS, {
      maxFiles: 30,
      maxDiffLines: 4000,
      maxContextReads: 20,
      maxFindings: 10,
    });
  });

  test('parses overrides from env', () => {
    const limits = parseReviewLimits({
      PR_REVIEW_MAX_FILES: '15',
      PR_REVIEW_MAX_DIFF_LINES: '8000',
      PR_REVIEW_MAX_CONTEXT_READS: '40',
      PR_REVIEW_MAX_FINDINGS: '5',
    });
    assert.equal(limits.maxFiles, 15);
    assert.equal(limits.maxDiffLines, 8000);
    assert.equal(limits.maxContextReads, 40);
    assert.equal(limits.maxFindings, 5);
  });

  test('falls back to defaults for missing values', () => {
    const limits = parseReviewLimits({});
    assert.deepEqual(limits, DEFAULT_REVIEW_LIMITS);
  });

  test('throws on out-of-range values', () => {
    assert.throws(() => parseReviewLimits({ PR_REVIEW_MAX_FILES: '0' }));
    assert.throws(() => parseReviewLimits({ PR_REVIEW_MAX_FILES: '200' }));
    assert.throws(() => parseReviewLimits({ PR_REVIEW_MAX_FINDINGS: 'abc' }));
  });

  test('caps PR_REVIEW_MAX_FINDINGS at the schema ceiling (50)', () => {
    assert.throws(() => parseReviewLimits({ PR_REVIEW_MAX_FINDINGS: '51' }));
    assert.equal(parseReviewLimits({ PR_REVIEW_MAX_FINDINGS: '50' }).maxFindings, 50);
  });
});
