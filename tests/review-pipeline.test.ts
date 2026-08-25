import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReviewPublisher } from '../github/adapter.ts';
import {
  createReviewPipelinePublisher,
  runReviewPipeline,
  type ReviewPipelineMetadata,
} from '../review/pipeline.ts';
import type { PrDataSource } from '../review/pr-data.ts';

const finding = {
  severity: 'P1' as const,
  path: 'src/a.ts',
  line: 1,
  title: 'Handle error',
  explanation: 'It is swallowed.',
  confidence: 0.9,
};

const review = {
  summary: 'One issue.',
  verdict: 'REQUEST_CHANGES' as const,
  findings: [finding],
};

describe('review pipeline', () => {
  test('keeps canonical findings while retaining specialist and advisor metadata', async () => {
    const report = await runReviewPipeline({
      review,
      specialist: {
        config: { enabledRoles: ['correctness', 'security'], timeoutMs: 100 },
        context: { diff: '', changedFiles: ['src/a.ts'] },
        runner: async (role) => [
          role === 'security' ? { ...finding, title: 'Security concern' } : finding,
        ],
      },
      advisor: {
        config: { enabled: true, model: 'advisor', timeoutMs: 100 },
        runner: async (input) =>
          input.finding.title === 'Security concern'
            ? { decision: 'reject', reason: 'Unsupported.' }
            : { decision: 'accept', reason: 'Supported.' },
      },
    });

    assert.equal(report.review.findings.length, 1);
    assert.equal(report.review.findings[0].title, finding.title);
    assert.deepEqual(report.metadata.provenance[0].sources, ['correctness', 'generalist']);
    assert.equal(report.metadata.advisorDecisions.length, 2);
    assert.equal(report.metadata.advisorDecisions[1].decision, 'reject');
    assert.equal(report.metadata.provenance.length, 1);
    assert.equal('sources' in report.review.findings[0], false);
    assert.equal('advisor' in report.review.findings[0], false);
  });

  test('advisor rejection downgrades a review with no remaining blockers', async () => {
    const report = await runReviewPipeline({
      review,
      specialist: {
        config: { enabledRoles: [], timeoutMs: 100 },
        context: { diff: '', changedFiles: ['src/a.ts'] },
        runner: async () => [],
      },
      advisor: {
        config: { enabled: true, model: 'advisor', timeoutMs: 100 },
        runner: async () => ({ decision: 'reject', reason: 'Unsupported.' }),
      },
    });

    assert.equal(report.review.verdict, 'COMMENT');
    assert.deepEqual(report.review.findings, []);
    assert.deepEqual(report.metadata.provenance, []);
  });

  test('keeps provenance aligned with revised findings', async () => {
    const report = await runReviewPipeline({
      review,
      specialist: {
        config: { enabledRoles: [], timeoutMs: 100 },
        context: { diff: '', changedFiles: ['src/a.ts'] },
        runner: async () => [],
      },
      advisor: {
        config: { enabled: true, model: 'advisor', timeoutMs: 100 },
        runner: async () => ({
          decision: 'revise',
          reason: 'Use a more precise title.',
          finding: { title: 'Handle swallowed error' },
        }),
      },
    });

    assert.equal(report.review.findings[0].title, 'Handle swallowed error');
    assert.equal(report.metadata.provenance[0].finding.title, 'Handle swallowed error');
    assert.deepEqual(report.metadata.provenance[0].sources, ['generalist']);
  });

  test('production publisher runs specialists and advisor before GitHub publication', async () => {
    let publishedMetadata: ReviewPipelineMetadata | undefined;
    let specialistCalls = 0;
    let advisorCalls = 0;
    const githubPublisher: ReviewPublisher = {
      async publish(result, metadata) {
        publishedMetadata = metadata;
        assert.equal(result.findings.length, 2);
        return {
          reviewId: 42,
          htmlUrl: 'https://github.com/o/r/pull/1#review-42',
          submittedFindings: 2,
          skippedFindings: 0,
          validationIssues: [],
        };
      },
    };
    const dataSource = {
      async getMetadata() {
        return {
          number: 1,
          title: 'PR',
          body: 'Body',
          author: 'alice',
          baseSha: 'base',
          headSha: 'head',
          changedFiles: [
            { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, skip: false },
          ],
        };
      },
      async getDiff() {
        return { content: 'diff', truncated: false, totalLines: 1 };
      },
      async getReviewContext() {
        return { files: [], message: 'No context.' };
      },
    } as unknown as PrDataSource;
    const publisher = createReviewPipelinePublisher({
      publisher: githubPublisher,
      dataSource,
      maxDiffLines: 4000,
      specialist: {
        config: { enabledRoles: ['security'], timeoutMs: 100 },
        runner: async () => {
          specialistCalls += 1;
          return [{ ...finding, title: 'Security concern' }];
        },
      },
      advisor: {
        config: { enabled: true, model: 'advisor', timeoutMs: 100 },
        runner: async () => {
          advisorCalls += 1;
          return { decision: 'accept', reason: 'Supported.' };
        },
      },
    });

    const result = await publisher.publish(review);

    assert.equal(result.reviewId, 42);
    assert.equal(specialistCalls, 1);
    assert.equal(advisorCalls, 2);
    assert.equal(publishedMetadata?.provenance.length, 2);
  });
});
