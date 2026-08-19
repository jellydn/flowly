import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { intakeFactoryIssue } from '../factory/intake.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';

const task = {
  issueNumber: 94,
  title: 'Add factory pipeline',
  body: 'Implement it.',
  repository: 'jellydn/flowly',
};

describe('factory issue intake', () => {
  test('classifies an issue and publishes bounded progress through the trusted boundary', async () => {
    const messages: string[] = [];
    const result = await intakeFactoryIssue(task, {
      orchestrator: new FactoryOrchestrator(new MemoryFactoryRunStore()),
      classifier: {
        async classify() {
          return {
            actionable: true,
            type: 'feature',
            priority: 'high',
            complexity: 'large',
            missingInformation: [],
          };
        },
      },
      progress: {
        async publish(_task, body) {
          messages.push(body);
        },
      },
    });

    assert.equal(result.run.state, 'classified');
    assert.deepEqual(messages, [
      'Factory run started: classifying the issue.',
      'Factory classification complete: ready for planning.',
    ]);
  });

  test('stops non-actionable issues and does not classify duplicate deliveries twice', async () => {
    let classifications = 0;
    const messages: string[] = [];
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const dependencies = {
      orchestrator,
      classifier: {
        async classify() {
          classifications += 1;
          return {
            actionable: false,
            type: 'feature' as const,
            priority: 'medium' as const,
            complexity: 'small' as const,
            missingInformation: ['Describe the expected behavior.'],
          };
        },
      },
      progress: {
        async publish(_task: typeof task, body: string) {
          messages.push(body);
        },
      },
    };

    const first = await intakeFactoryIssue(task, dependencies);
    const duplicate = await intakeFactoryIssue(task, dependencies);

    assert.equal(first.run.state, 'needs-input');
    assert.equal(duplicate.duplicate, true);
    assert.equal(classifications, 1);
    assert.match(messages.at(-1) ?? '', /Describe the expected behavior/);
  });
});
