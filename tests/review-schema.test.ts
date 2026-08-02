import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseReviewResult, reviewResultSchema, safeParseReviewResult } from '../review/schema.ts';
import * as v from 'valibot';

const validResult = {
  summary: 'Looks good overall with one concern.',
  verdict: 'COMMENT',
  findings: [
    {
      severity: 'medium',
      path: 'src/auth.ts',
      line: 42,
      title: 'Unhandled error in login',
      explanation: 'The catch block swallows the error silently.',
      suggestion: 'return Result.err(error)',
      confidence: 0.7,
    },
  ],
};

describe('review schema', () => {
  test('parses a valid review result', () => {
    const result = parseReviewResult(validResult);
    assert.equal(result.verdict, 'COMMENT');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'medium');
  });

  test('accepts an empty findings array', () => {
    const result = parseReviewResult({
      summary: 'No blocking issues found.',
      verdict: 'COMMENT',
      findings: [],
    });
    assert.deepEqual(result.findings, []);
  });

  test('rejects an APPROVE verdict', () => {
    const parsed = safeParseReviewResult({
      summary: 'lgtm',
      verdict: 'APPROVE',
      findings: [],
    });
    assert.equal(parsed.ok, false);
  });

  test('rejects findings over the max count', () => {
    const tooMany = {
      summary: 's',
      verdict: 'COMMENT',
      findings: Array.from({ length: 51 }, () => ({
        severity: 'low',
        path: 'a.ts',
        line: 1,
        title: 't',
        explanation: 'e',
        confidence: 0.1,
      })),
    };
    const parsed = safeParseReviewResult(tooMany);
    assert.equal(parsed.ok, false);
  });

  test('rejects a confidence outside [0,1]', () => {
    const parsed = safeParseReviewResult({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        { severity: 'low', path: 'a.ts', line: 1, title: 't', explanation: 'e', confidence: 1.5 },
      ],
    });
    assert.equal(parsed.ok, false);
  });

  test('rejects an unknown severity', () => {
    const parsed = safeParseReviewResult({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'blocker',
          path: 'a.ts',
          line: 1,
          title: 't',
          explanation: 'e',
          confidence: 0.5,
        },
      ],
    });
    assert.equal(parsed.ok, false);
  });

  test('safeParse returns issues list on failure', () => {
    const parsed = safeParseReviewResult({ verdict: 'COMMENT' });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.ok(parsed.issues.length > 0);
    }
  });

  test('schema is a valibot object schema', () => {
    assert.equal(v.is(reviewResultSchema, validResult), true);
  });

  test('accepts a valid previousFindingClassifications array', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      previousFindingClassifications: [
        { path: 'src/auth.ts', line: 42, title: 'SQL injection', status: 'resolved' },
        { path: 'src/utils.ts', line: 10, title: 'Unused import', status: 'still-present', note: 'Still there' },
      ],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.previousFindingClassifications?.length, 2);
      assert.equal(parsed.value.previousFindingClassifications?.[0].status, 'resolved');
    }
  });

  test('accepts a review result without previousFindingClassifications', () => {
    const parsed = safeParseReviewResult(validResult);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.previousFindingClassifications, undefined);
    }
  });

  test('rejects an invalid finding status', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      previousFindingClassifications: [
        { path: 'src/auth.ts', line: 42, title: 'SQL injection', status: 'fixed' },
      ],
    });
    assert.equal(parsed.ok, false);
  });

  test('rejects a classification missing required fields', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      previousFindingClassifications: [
        { path: 'src/auth.ts', line: 42, status: 'resolved' },
      ],
    });
    assert.equal(parsed.ok, false);
  });
});
