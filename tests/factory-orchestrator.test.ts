import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';

const task = {
  issueNumber: 94,
  title: 'Add factory pipeline',
  body: 'Implement it.',
  repository: 'jellydn/flowly',
};
const classification = {
  actionable: true,
  type: 'feature' as const,
  priority: 'high' as const,
  complexity: 'large' as const,
  missingInformation: [],
};
const plan = {
  summary: 'Build foundation',
  steps: ['Add state'],
  acceptanceCriteria: [{ description: 'A run is persisted.' }],
  verificationCommands: ['npm test'],
};
const implementation = {
  workspaceId: 'factory-run-94',
  commitSha: 'abc123',
  changedFiles: ['factory/orchestrator.ts'],
  commands: [{ command: 'npm test', exitCode: 0 }],
};
const review = {
  readyForHumanReview: true,
  acceptanceCriteria: [
    { description: 'A run is persisted.', satisfied: true, evidence: 'FactoryRun exists.' },
  ],
  summary: 'Ready for human review.',
  unresolvedFindings: [],
};

describe('FactoryOrchestrator', () => {
  test('deduplicates issue deliveries and assigns only a factory-owned branch', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const first = await orchestrator.start(task);
    const duplicate = await orchestrator.start(task);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.run.id, first.run.id);

    await orchestrator.classify(first.run.id, classification);
    await orchestrator.plan(first.run.id, plan);
    const implementing = await orchestrator.beginImplementation(first.run.id);
    assert.equal(implementing.state, 'implementing');
    assert.equal(implementing.branch, 'factory/94-add-factory-pipeline');
  });

  test('creates one run for concurrent deliveries and retries completed stages safely', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const [first, second] = await Promise.all([orchestrator.start(task), orchestrator.start(task)]);
    assert.equal(first.run.id, second.run.id);
    assert.notEqual(first.duplicate, second.duplicate);

    const classified = await orchestrator.classify(first.run.id, classification);
    assert.equal(
      (await orchestrator.classify(first.run.id, classification)).version,
      classified.version,
    );
  });

  test('stops non-actionable tasks before planning', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const { run } = await orchestrator.start(task);
    const needsInput = await orchestrator.classify(run.id, {
      ...classification,
      actionable: false,
      missingInformation: ['Describe expected behavior.'],
    });
    assert.equal(needsInput.state, 'needs-input');
    await assert.rejects(() => orchestrator.plan(run.id, plan), /needs-input; expected classified/);
  });

  test('rejects writes that do not advance the optimistic version', async () => {
    const store = new MemoryFactoryRunStore();
    const { run } = await new FactoryOrchestrator(store).start(task);
    await assert.rejects(() => store.save(run, run.version), /must advance to version/);
  });

  test('records implementation, verification, review, and one draft PR without merging', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const { run } = await orchestrator.start(task);
    await orchestrator.classify(run.id, classification);
    await orchestrator.plan(run.id, plan);
    await orchestrator.beginImplementation(run.id);

    const verifying = await orchestrator.recordImplementation(run.id, implementation);
    assert.equal(verifying.state, 'verifying');
    assert.equal(verifying.implementation?.workspaceId, 'factory-run-94');
    assert.equal(
      (await orchestrator.recordImplementation(run.id, structuredClone(implementation))).version,
      verifying.version,
    );
    await assert.rejects(
      () => orchestrator.recordImplementation(run.id, { ...implementation, commitSha: 'def456' }),
      /already has an implementation result/,
    );

    const reviewing = await orchestrator.recordVerification(run.id, true);
    assert.equal(reviewing.state, 'reviewing');
    assert.equal((await orchestrator.recordVerification(run.id, true)).version, reviewing.version);
    await assert.rejects(
      () => orchestrator.recordVerification(run.id, false, 'npm test failed'),
      /already has a verification result/,
    );
    await assert.rejects(
      () => orchestrator.recordDraftPr(run.id, 96),
      /independently reviewed first/,
    );

    const reviewed = await orchestrator.recordReview(run.id, review);
    assert.equal(reviewed.review?.readyForHumanReview, true);
    const reorderedReview = {
      summary: review.summary,
      unresolvedFindings: review.unresolvedFindings,
      acceptanceCriteria: review.acceptanceCriteria,
      readyForHumanReview: review.readyForHumanReview,
    };
    assert.equal(
      (await orchestrator.recordReview(run.id, reorderedReview)).version,
      reviewed.version,
    );
    const prCreated = await orchestrator.recordDraftPr(run.id, 96);
    assert.equal(prCreated.state, 'pr-created');
    assert.equal(prCreated.prNumber, 96);
    assert.equal((await orchestrator.recordDraftPr(run.id, 96)).version, prCreated.version);
    await assert.rejects(
      () => orchestrator.recordReview(run.id, { ...review, summary: 'Conflicting verdict.' }),
      /already has an independent review verdict/,
    );

    const completed = await orchestrator.complete(run.id);
    assert.equal(completed.state, 'completed');
  });

  test('records failed verification without entering independent review', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const { run } = await orchestrator.start(task);
    await orchestrator.classify(run.id, classification);
    await orchestrator.plan(run.id, plan);
    await orchestrator.beginImplementation(run.id);
    await orchestrator.recordImplementation(run.id, implementation);

    const failed = await orchestrator.recordVerification(run.id, false, 'npm test failed');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure, 'npm test failed');
    assert.equal(
      (await orchestrator.recordVerification(run.id, false, 'npm test failed')).version,
      failed.version,
    );
    await assert.rejects(
      () => orchestrator.recordVerification(run.id, true),
      /already has a verification result/,
    );
    await assert.rejects(
      () => orchestrator.recordReview(run.id, review),
      /failed; expected reviewing/,
    );
  });
});
