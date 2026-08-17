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
    assert.equal((await orchestrator.classify(first.run.id, classification)).version, classified.version);
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
});
