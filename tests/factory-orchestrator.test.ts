import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';

const task = { issueNumber: 94, title: 'Add factory pipeline', body: 'Implement it.', repository: 'jellydn/flowly' };
const classification = { actionable: true, type: 'feature' as const, priority: 'high' as const, complexity: 'large' as const, missingInformation: [] };
const plan = { summary: 'Build foundation', steps: ['Add state'], acceptanceCriteria: [{ description: 'A run is persisted.' }], verificationCommands: ['npm test'] };

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

  test('stops non-actionable tasks before planning', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const { run } = await orchestrator.start(task);
    const needsInput = await orchestrator.classify(run.id, { ...classification, actionable: false, missingInformation: ['Describe expected behavior.'] });
    assert.equal(needsInput.state, 'needs-input');
    await assert.rejects(() => orchestrator.plan(run.id, plan), /needs-input; expected classified/);
  });
});
