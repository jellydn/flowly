import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createReviewPublisher } from '../github/adapter.ts';
import type { GitHubClient, GitHubReviewPayload } from '../github/client.ts';
import type { ReviewLimits } from '../review/limits.ts';
import { DEFAULT_REVIEW_LIMITS } from '../review/limits.ts';

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

const limits: ReviewLimits = DEFAULT_REVIEW_LIMITS;

function createFakeClient(): GitHubClient & {
  submitted: { prNumber: number; payload: GitHubReviewPayload }[];
} {
  const submitted: { prNumber: number; payload: GitHubReviewPayload }[] = [];
  const client = {
    owner: 'o',
    repo: 'r',
    token: 'secret',
    apiUrl: 'https://api.github.com',
    async getPr() {
      return {
        number: 1,
        title: 't',
        body: 'b',
        user: { login: 'alice' },
        head: { sha: 'h', ref: 'feature' },
        base: { sha: 'b', ref: 'main' },
        draft: false,
      };
    },
    async submitReview(prNumber: number, payload: GitHubReviewPayload) {
      submitted.push({ prNumber, payload });
      return { id: 42, html_url: 'https://github.com/o/r/pulls/1#review-42' };
    },
  } as unknown as GitHubClient & { submitted: typeof submitted };
  client.submitted = submitted;
  return client;
}

describe('review publisher', () => {
  test('posts a COMMENT review with inline comments', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 'One medium issue.',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'medium',
          path: 'src/auth.ts',
          line: 11,
          title: 'Silent error',
          explanation: 'The error is swallowed.',
          suggestion: 'return Result.err(e)',
          confidence: 0.8,
        },
      ],
    });

    assert.equal(result.reviewId, 42);
    assert.equal(result.submittedFindings, 1);
    assert.equal(result.skippedFindings, 0);
    assert.equal(client.submitted[0].payload.event, 'COMMENT');
    assert.equal(client.submitted[0].payload.comments.length, 1);
    const comment = client.submitted[0].payload.comments[0];
    assert.equal(comment.path, 'src/auth.ts');
    assert.equal(comment.side, 'RIGHT');
    assert.match(comment.body, /MEDIUM\] Silent error/);
    assert.match(comment.body, /Suggestion/);
  });

  test('uses REQUEST_CHANGES when verdict is REQUEST_CHANGES', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 'Blocking issue.',
      verdict: 'REQUEST_CHANGES',
      findings: [
        {
          severity: 'critical',
          path: 'src/auth.ts',
          line: 11,
          title: 'SQL injection',
          explanation: 'User input concatenated into query.',
          confidence: 0.9,
        },
      ],
    });

    assert.equal(client.submitted[0].payload.event, 'REQUEST_CHANGES');
  });

  test('drops findings whose path is not in the diff', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'low',
          path: 'not-in-diff.ts',
          line: 1,
          title: 'x',
          explanation: 'y',
          confidence: 0.5,
        },
      ],
    });

    assert.equal(result.submittedFindings, 0);
    assert.equal(result.skippedFindings, 1);
    assert.equal(client.submitted[0].payload.comments.length, 0);
    // Still summarized in the body
    assert.match(client.submitted[0].payload.body, /not posted inline/);
  });

  test('clamps an out-of-range line to the nearest hunk', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'low',
          path: 'src/auth.ts',
          line: 9999,
          title: 'x',
          explanation: 'y',
          confidence: 0.5,
        },
      ],
    });

    // Hunk new range is 10..14; 9999 clamps to 14.
    assert.equal(client.submitted[0].payload.comments[0].line, 14);
  });

  test('caps findings to maxFindings', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits: { ...limits, maxFindings: 2 },
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: Array.from({ length: 5 }, (_, i) => ({
        severity: 'low' as const,
        path: 'src/auth.ts',
        line: 10 + i,
        title: `t${i}`,
        explanation: 'e',
        confidence: 0.5,
      })),
    });

    assert.equal(result.submittedFindings, 2);
    assert.equal(result.skippedFindings, 3);
  });

  test('rejects an invalid review result', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits,
    });

    await assert.rejects(
      () => publisher.publish({ verdict: 'COMMENT' }),
      /invalid review result/,
    );
    assert.equal(client.submitted.length, 0);
  });

  test('handles an empty findings array (no blocking issues)', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 'No blocking issues found.',
      verdict: 'COMMENT',
      findings: [],
    });

    assert.equal(result.submittedFindings, 0);
    assert.equal(client.submitted[0].payload.comments.length, 0);
    assert.match(client.submitted[0].payload.body, /No blocking issues found/);
  });
});
