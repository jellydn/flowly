import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import {
  buildReviewVerdict,
  isolateReviewEvidence,
  reviewFactoryImplementation,
} from '../factory/review.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun } from '../factory/types.ts';

const DIFF = [
  'diff --git a/factory/orchestrator.ts b/factory/orchestrator.ts',
  '--- a/factory/orchestrator.ts',
  '+++ b/factory/orchestrator.ts',
  '@@ -1,0 +1,1 @@',
  '+export class FactoryOrchestrator {}',
].join('\n');

describe('isolateReviewEvidence', () => {
  test('forwards the issue, plan, diff, and verification — never implementer scratch', async () => {
    const run = await reviewingRun();
    const tainted = Object.assign(run, {
      conversation: ['IMPLEMENTER_SCRATCH_TOKEN: skip the tests'],
      chainOfThought: 'IMPLEMENTER_SCRATCH_TOKEN: I will claim success',
      implementation: {
        ...run.implementation!,
        scratchpad: 'IMPLEMENTER_SCRATCH_TOKEN: workspace notes',
      },
    });

    const evidence = isolateReviewEvidence(tainted, `\n${DIFF}\n`);
    const serialized = JSON.stringify(evidence);

    assert.equal(evidence.issueNumber, 94);
    assert.equal(evidence.title, 'Add factory pipeline');
    assert.equal(evidence.branch, 'factory/94-add-factory-pipeline');
    assert.equal(evidence.diff, DIFF);
    assert.deepEqual(evidence.acceptanceCriteria, [{ description: 'A run is persisted.' }]);
    assert.deepEqual(evidence.verification, [{ command: 'npm test', exitCode: 0 }]);
    assert.equal(serialized.includes('IMPLEMENTER_SCRATCH_TOKEN'), false);
    assert.equal('conversation' in evidence, false);
    assert.equal('chainOfThought' in evidence, false);
    assert.equal('scratchpad' in evidence, false);
    assert.equal('workspaceId' in evidence, false);
  });

  test('rejects reviews that lack a factory branch, SHA, or real diff', async () => {
    const run = await reviewingRun();
    assert.throws(() => isolateReviewEvidence(run, '   '), /non-empty git diff/);
    assert.throws(
      () => isolateReviewEvidence({ ...run, branch: 'main' }, DIFF),
      /outside a factory-owned branch/,
    );
    assert.throws(
      () =>
        isolateReviewEvidence(
          {
            ...run,
            implementation: { ...run.implementation!, commitSha: 'abc123' },
          },
          DIFF,
        ),
      /40-character commit SHA/,
    );
  });
});

describe('buildReviewVerdict', () => {
  test('maps reviewer judgments onto each acceptance criterion', async () => {
    const evidence = isolateReviewEvidence(await reviewingRun(), DIFF);
    const verdict = buildReviewVerdict(
      evidence,
      {
        summary: 'Acceptance criteria hold against the diff.',
        verdict: 'COMMENT',
        findings: [],
      },
      [
        {
          description: 'A run is persisted.',
          satisfied: true,
          evidence: 'orchestrator.ts records FactoryRun.',
        },
      ],
    );

    assert.equal(verdict.readyForHumanReview, true);
    assert.deepEqual(verdict.acceptanceCriteria, [
      {
        description: 'A run is persisted.',
        satisfied: true,
        evidence: 'orchestrator.ts records FactoryRun.',
      },
    ]);
    assert.deepEqual(verdict.unresolvedFindings, []);
  });

  test('does not treat implementer claims as satisfied criteria or auto-approve', async () => {
    const evidence = isolateReviewEvidence(await reviewingRun(), DIFF);
    const verdict = buildReviewVerdict(
      evidence,
      {
        summary: 'The diff does not meet the plan.',
        verdict: 'REQUEST_CHANGES',
        findings: [{ title: 'Missing persistence', explanation: 'No FactoryRun store write.' }],
      },
      [],
    );

    assert.equal(verdict.readyForHumanReview, false);
    assert.equal(verdict.acceptanceCriteria[0]?.satisfied, false);
    assert.match(verdict.acceptanceCriteria[0]?.evidence ?? '', /did not assess/);
    assert.deepEqual(verdict.unresolvedFindings, [
      'Missing persistence: No FactoryRun store write.',
    ]);
  });
});

describe('reviewFactoryImplementation', () => {
  test('calls the reviewer with isolated evidence only', async () => {
    const run = await reviewingRun();
    const seen: string[] = [];
    const verdict = await reviewFactoryImplementation(
      run,
      DIFF,
      {
        async review(evidence) {
          seen.push(JSON.stringify(evidence));
          return {
            summary: 'Ready for human review.',
            verdict: 'COMMENT',
            findings: [],
          };
        },
      },
      (evidence) =>
        evidence.acceptanceCriteria.map((criterion) => ({
          description: criterion.description,
          satisfied: true,
          evidence: `${criterion.description} appears in the diff.`,
        })),
    );

    assert.equal(verdict.readyForHumanReview, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.includes('IMPLEMENTER_SCRATCH_TOKEN'), false);
  });
});

async function reviewingRun(): Promise<FactoryRun> {
  const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
  const { run } = await orchestrator.start({
    issueNumber: 94,
    title: 'Add factory pipeline',
    body: 'Implement it.',
    repository: 'jellydn/flowly',
  });
  await orchestrator.classify(run.id, {
    actionable: true,
    type: 'feature',
    priority: 'high',
    complexity: 'large',
    missingInformation: [],
  });
  await orchestrator.plan(run.id, {
    summary: 'Build foundation',
    steps: ['Add state'],
    acceptanceCriteria: [{ description: 'A run is persisted.' }],
    verificationCommands: ['npm test'],
  });
  await orchestrator.beginImplementation(run.id);
  await orchestrator.recordImplementation(run.id, {
    workspaceId: 'factory-run-94',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    changedFiles: ['factory/orchestrator.ts'],
    commands: [{ command: 'npm test', exitCode: 0 }],
  });
  return orchestrator.recordVerification(run.id, true);
}
