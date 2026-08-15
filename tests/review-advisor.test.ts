import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adviseFindings } from '../review/advisor.ts';

const finding = { severity: 'P1' as const, path: 'src/a.ts', line: 3, title: 'Handle failure', explanation: 'The error is lost.', confidence: 0.9 };

describe('advisor gate', () => {
  test('accepts, revises, and rejects findings before publication', async () => {
    const result = await adviseFindings({
      findings: [finding, { ...finding, title: 'Weak claim' }, { ...finding, title: 'Revise me' }], timeoutMs: 100,
      runner: async (candidate) => candidate.title === 'Weak claim'
        ? { decision: 'reject', reason: 'Not introduced by the diff.' }
        : candidate.title === 'Revise me'
          ? { decision: 'revise', reason: 'Calibrate severity.', finding: { ...candidate, severity: 'P2' } }
          : { decision: 'accept', reason: 'Evidence supports the claim.' },
    });
    assert.equal(result.findings.length, 2);
    assert.equal(result.findings[1].severity, 'P2');
    assert.equal(result.decisions.length, 3);
  });

  test('fails closed on timeout or malformed advice', async () => {
    const result = await adviseFindings({ findings: [finding], timeoutMs: 1, runner: async () => new Promise(() => {}) });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.errors, ['advisor failed or timed out']);
  });
});
