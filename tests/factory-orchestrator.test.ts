import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FactoryAttemptLimitError,
  FactoryLeaseHeldError,
  FactoryOrchestrator,
  IMPLEMENTATION_LEASE_MS,
  FactoryLeaseLostError,
} from '../factory/orchestrator.ts';
import { parseFactoryRun } from '../factory/schema.ts';
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
  test('one process holds the implementation lease until it expires', async () => {
    const store = new MemoryFactoryRunStore();
    let now = 1_000_000;
    const first = new FactoryOrchestrator(store, { holder: 'worker-1', now: () => now });
    const second = new FactoryOrchestrator(store, { holder: 'worker-2', now: () => now });
    const { run } = await first.start(task);
    await first.classify(run.id, classification);
    await first.plan(run.id, plan);

    const claimed = await first.beginImplementation(run.id);
    assert.deepEqual(claimed.implementationLease, {
      holder: 'worker-1',
      attempt: 1,
      startedAt: now,
    });
    assert.equal((await first.beginImplementation(run.id)).version, claimed.version);
    now += IMPLEMENTATION_LEASE_MS - 1;
    await assert.rejects(second.beginImplementation(run.id), FactoryLeaseHeldError);
    await assert.rejects(
      second.recordExecution(run.id, { executor: 'smolvm', baseSha: 'a'.repeat(40) }),
      /without its implementation lease/,
    );

    now += 1;
    const reclaimed = await second.beginImplementation(run.id);
    assert.deepEqual(reclaimed.implementationLease, {
      holder: 'worker-2',
      attempt: 2,
      startedAt: now,
    });
    assert.equal(reclaimed.branch, claimed.branch);
    await assert.rejects(first.beginImplementation(run.id), FactoryLeaseHeldError);
  });

  test('a reclaim beyond the attempt limit fails the run and keeps its branch', async () => {
    const store = new MemoryFactoryRunStore();
    let now = 1_000_000;
    const worker = (holder: string) =>
      new FactoryOrchestrator(store, { holder, now: () => now, maxAttempts: 2 });
    const { run } = await worker('w1').start(task);
    await worker('w1').classify(run.id, classification);
    await worker('w1').plan(run.id, plan);
    const first = await worker('w1').beginImplementation(run.id);
    now += IMPLEMENTATION_LEASE_MS;
    assert.equal((await worker('w2').beginImplementation(run.id)).implementationLease?.attempt, 2);
    now += IMPLEMENTATION_LEASE_MS;

    await assert.rejects(worker('w3').beginImplementation(run.id), FactoryAttemptLimitError);

    const failed = await worker('w3').get(run.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.branch, first.branch);
    assert.match(failed.failure ?? '', /attempt limit \(2\)/);
    assert.ok(
      failed.events?.some(
        (event) => event.type === 'stage.failed' && event.stage === 'implementer',
      ),
    );
  });

  test('a process that lost its lease cannot write results; the new holder can', async () => {
    const store = new MemoryFactoryRunStore();
    let now = 1_000_000;
    const first = new FactoryOrchestrator(store, { holder: 'worker-1', now: () => now });
    const second = new FactoryOrchestrator(store, { holder: 'worker-2', now: () => now });
    const { run } = await first.start(task);
    await first.classify(run.id, classification);
    await first.plan(run.id, plan);
    await first.beginImplementation(run.id);
    now += IMPLEMENTATION_LEASE_MS;
    await second.beginImplementation(run.id);

    await assert.rejects(first.recordImplementation(run.id, implementation), FactoryLeaseLostError);
    await assert.rejects(first.renewImplementationLease(run.id), FactoryLeaseLostError);
    const verifying = await second.recordImplementation(run.id, {
      ...implementation,
      commands: [],
    });
    assert.equal(verifying.state, 'verifying');
    await assert.rejects(first.recordVerification(run.id, true), FactoryLeaseLostError);

    // Verification after a restart may give new results for the same commit.
    now += IMPLEMENTATION_LEASE_MS;
    const third = new FactoryOrchestrator(store, { holder: 'worker-3', now: () => now });
    await third.resumeVerification(run.id);
    await third.recordImplementation(run.id, implementation);
    const rerun = await third.recordImplementation(run.id, {
      ...implementation,
      commands: [{ command: 'npm test', exitCode: 1 }],
    });
    assert.deepEqual(rerun.implementation?.commands, [{ command: 'npm test', exitCode: 1 }]);
    assert.equal(
      (await third.recordVerification(run.id, false, 'npm test failed')).state,
      'failed',
    );
  });

  test('renewing the lease restarts its period for the holder only', async () => {
    const store = new MemoryFactoryRunStore();
    let now = 1_000_000;
    const first = new FactoryOrchestrator(store, { holder: 'worker-1', now: () => now });
    const second = new FactoryOrchestrator(store, { holder: 'worker-2', now: () => now });
    const { run } = await first.start(task);
    await first.classify(run.id, classification);
    await first.plan(run.id, plan);
    await first.beginImplementation(run.id);
    now += IMPLEMENTATION_LEASE_MS - 1;
    const renewed = await first.renewImplementationLease(run.id);
    assert.deepEqual(renewed.implementationLease, {
      holder: 'worker-1',
      attempt: 1,
      startedAt: now,
    });
    now += IMPLEMENTATION_LEASE_MS - 1;
    await assert.rejects(second.beginImplementation(run.id), FactoryLeaseHeldError);
  });

  test('records execution metadata for the current attempt and persists it', async () => {
    const store = new MemoryFactoryRunStore();
    const orchestrator = new FactoryOrchestrator(store, { holder: 'worker-1' });
    const { run } = await orchestrator.start(task);
    await orchestrator.classify(run.id, classification);
    await orchestrator.plan(run.id, plan);
    await orchestrator.beginImplementation(run.id);
    const execution = {
      executor: 'smolvm' as const,
      vmName: `flowly-${run.id}-a1`,
      baseSha: 'b'.repeat(40),
    };

    const recorded = await orchestrator.recordExecution(run.id, execution);

    assert.deepEqual(recorded.execution, { ...execution, attempt: 1 });
    assert.equal((await orchestrator.recordExecution(run.id, execution)).version, recorded.version);
    assert.deepEqual(parseFactoryRun(structuredClone(recorded)).execution, recorded.execution);
    assert.throws(() =>
      parseFactoryRun({ ...recorded, execution: { ...recorded.execution, baseSha: 'HEAD' } }),
    );
  });

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
