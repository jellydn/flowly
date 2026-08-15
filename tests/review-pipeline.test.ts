import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runReviewPipeline } from '../review/pipeline.ts';

const finding = { severity: 'P1' as const, path: 'src/a.ts', line: 1, title: 'Handle error', explanation: 'It is swallowed.', confidence: 0.9 };

describe('review pipeline', () => {
  test('runs specialists then publishes only advisor-approved findings', async () => {
    const report = await runReviewPipeline({
      specialist: {
        config: { enabledRoles: ['correctness', 'security'], timeoutMs: 100 },
        context: { diff: '', changedFiles: ['src/a.ts'] },
        runner: async (role) => [role === 'security' ? { ...finding, title: 'Security concern' } : finding],
      },
      advisor: {
        timeoutMs: 100,
        runner: async (candidate) => candidate.title === 'Security concern'
          ? { decision: 'reject', reason: 'Unsupported.' }
          : { decision: 'accept', reason: 'Supported.' },
      },
    });
    assert.deepEqual(report.findings, [finding]);
    assert.deepEqual(report.reviewerSources['src/a.ts:Handle error'], ['correctness']);
  });
});
