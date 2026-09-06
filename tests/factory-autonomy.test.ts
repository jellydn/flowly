import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyFactoryAutonomyEvent,
  decideFactoryAutonomyGate,
  evaluateFactoryAutonomy,
  parseFactoryAutonomyPolicy,
} from '../factory/autonomy.ts';
import {
  FACTORY_AUTONOMY_LEVELS,
  type FactoryAutonomyPolicy,
  type FactoryRun,
} from '../factory/types.ts';

const policy: FactoryAutonomyPolicy = {
  version: 'repo-policy-v1',
  promotionEnabled: true,
  defaultLevel: 'plan-only',
  maximumLevel: 'publish-draft-pr',
  minimumSamples: { implementAndVerify: 2, publishDraftPr: 2 },
  promotionThresholds: {
    verificationSuccessRate: 1,
    reviewReadyRate: 1,
    publicationSuccessRate: 1,
  },
  demotions: {
    'verification-failure': 'plan-only',
    'review-failure': 'implement-and-verify',
    'security-failure': 'plan-only',
    'publication-failure': 'implement-and-verify',
  },
};

describe('factory autonomy policy', () => {
  test('validates policy bounds and defaults promotion to disabled', () => {
    const parsed = parseFactoryAutonomyPolicy({
      ...policy,
      promotionEnabled: undefined,
    });
    assert.equal(parsed.promotionEnabled, false);
    assert.throws(
      () =>
        parseFactoryAutonomyPolicy({
          ...policy,
          defaultLevel: 'publish-draft-pr',
          maximumLevel: 'plan-only',
        }),
      /defaultLevel cannot exceed maximumLevel/,
    );
  });

  test('cold starts at plan only and explains missing policy', () => {
    const audit = evaluateFactoryAutonomy(undefined, []);
    assert.equal(audit.effectiveLevel, 'plan-only');
    assert.match(audit.explanation.join(' '), /No autonomy policy/);
    assert.equal(decideFactoryAutonomyGate(audit, 'implementation', undefined).allowed, false);
  });

  test('stays at plan only when promotion history is insufficient', () => {
    const audit = evaluateFactoryAutonomy({ ...policy, defaultLevel: 'publish-draft-pr' }, [
      successfulRun(1),
    ]);

    assert.equal(audit.effectiveLevel, 'plan-only');
    assert.match(audit.explanation.join(' '), /promotion threshold not met/);
  });

  test('promotes deterministically after sufficient successful history', () => {
    const audit = evaluateFactoryAutonomy(policy, [successfulRun(1), successfulRun(2)]);
    assert.equal(audit.effectiveLevel, 'publish-draft-pr');
    assert.equal(audit.evidence.verificationSuccessRate, 1);
    assert.equal(audit.evidence.reviewReadyRate, 1);
    assert.equal(audit.evidence.publicationSuccessRate, 1);
    assert.match(audit.explanation.join(' '), /promotion thresholds passed/);
  });

  test('enforces the cap and immediate configured demotion', () => {
    const capped = evaluateFactoryAutonomy({ ...policy, maximumLevel: 'implement-and-verify' }, [
      successfulRun(1),
      successfulRun(2),
    ]);
    assert.equal(capped.effectiveLevel, 'implement-and-verify');

    const failed = successfulRun(3);
    failed.autonomyEvents = ['security-failure'];
    const demoted = evaluateFactoryAutonomy(policy, [successfulRun(1), successfulRun(2), failed]);
    assert.equal(demoted.effectiveLevel, 'plan-only');
    assert.match(demoted.explanation.join(' '), /security-failure immediately demoted/);

    const currentRun = applyFactoryAutonomyEvent(
      evaluateFactoryAutonomy(
        { ...policy, promotionEnabled: false, defaultLevel: 'publish-draft-pr' },
        [],
      ),
      policy,
      'review-failure',
    );
    assert.equal(currentRun.effectiveLevel, 'implement-and-verify');
    assert.deepEqual(currentRun.evidence.events, ['review-failure']);
  });

  test('validates events and preserves gate decisions across idempotent demotion', () => {
    const audit = {
      ...evaluateFactoryAutonomy(
        { ...policy, promotionEnabled: false, defaultLevel: 'publish-draft-pr' },
        [],
      ),
      gateDecisions: [
        {
          boundary: 'implementation' as const,
          allowed: true,
          manualConfirmation: false,
          reason: 'Policy allows implementation.',
          decidedAt: 1,
        },
      ],
    };

    const demoted = applyFactoryAutonomyEvent(audit, policy, 'review-failure');

    assert.deepEqual(demoted.gateDecisions, audit.gateDecisions);
    assert.strictEqual(applyFactoryAutonomyEvent(demoted, policy, 'review-failure'), demoted);
    assert.throws(
      () => applyFactoryAutonomyEvent(audit, policy, 'invalid-event'),
      /Invalid type|Expected/i,
    );
    assert.throws(
      () =>
        applyFactoryAutonomyEvent(
          audit,
          { ...policy, version: 'repo-policy-v2' },
          'review-failure',
        ),
      /does not match audit policy/,
    );
  });

  test('manual confirmation advances exactly its one requested boundary', () => {
    const audit = evaluateFactoryAutonomy(undefined, []);
    assert.deepEqual(decideFactoryAutonomyGate(audit, 'implementation', 'implementation'), {
      allowed: true,
      manualConfirmation: true,
      reason: 'One-run manual confirmation allows implementation.',
    });
    assert.equal(decideFactoryAutonomyGate(audit, 'publication', 'implementation').allowed, false);
  });

  test('the policy contract exposes no approve, merge, deploy, or production level', () => {
    assert.deepEqual(FACTORY_AUTONOMY_LEVELS, [
      'plan-only',
      'implement-and-verify',
      'publish-draft-pr',
    ]);
    assert.throws(
      () => parseFactoryAutonomyPolicy({ ...policy, maximumLevel: 'merge' }),
      /Invalid type|Expected/i,
    );
  });
});

function successfulRun(issueNumber: number): FactoryRun {
  return {
    id: `run-${issueNumber}`,
    task: {
      issueNumber,
      title: `Issue ${issueNumber}`,
      body: 'Implemented.',
      repository: 'jellydn/flowly',
    },
    state: 'completed',
    version: 10,
    implementation: {
      workspaceId: `workspace-${issueNumber}`,
      commitSha: 'abc123',
      changedFiles: ['factory/run.ts'],
      commands: [{ command: 'npm test', exitCode: 0 }],
    },
    review: {
      readyForHumanReview: true,
      acceptanceCriteria: [],
      summary: 'Ready.',
      unresolvedFindings: [],
    },
    prNumber: 100 + issueNumber,
    updatedAt: 1_700_000_000_000,
  };
}
