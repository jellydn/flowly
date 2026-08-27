import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FactoryOrchestrator, PLANNING_LEASE_MS } from '../factory/orchestrator.ts';
import { planFactoryIssue } from '../factory/plan.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun, ImplementationPlan } from '../factory/types.ts';

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
const plan: ImplementationPlan = {
  summary: 'Add a read-only planner stage.',
  steps: ['Inspect factory types', 'Record structured acceptance criteria'],
  acceptanceCriteria: [{ description: 'A classified run can persist a plan.' }],
  verificationCommands: ['npm test'],
  relevantFiles: ['factory/orchestrator.ts', 'factory/types.ts'],
  risks: ['Planner must not write to the source checkout.'],
};

describe('planFactoryIssue', () => {
  test('records a structured plan and publishes bounded progress through the trusted boundary', async () => {
    const { orchestrator, run } = await classifiedRun();
    const messages: string[] = [];
    let plans = 0;

    const result = await planFactoryIssue(run, {
      orchestrator,
      planner: {
        async plan(input) {
          plans += 1;
          assert.equal(input.task.issueNumber, 94);
          assert.equal(input.classification.actionable, true);
          return plan;
        },
      },
      progress: {
        async publish(_task, body) {
          messages.push(body);
        },
      },
    });

    assert.equal(result.state, 'planned');
    assert.deepEqual(result.plan, plan);
    assert.equal(plans, 1);
    assert.deepEqual(messages, [
      'Factory planning started: inspecting the repository.',
      'Factory plan recorded: Add a read-only planner stage.',
    ]);
  });

  test('does not re-plan an already planned run', async () => {
    const { orchestrator, run } = await classifiedRun();
    let plans = 0;
    const dependencies = {
      orchestrator,
      planner: {
        async plan() {
          plans += 1;
          return plan;
        },
      },
      progress: {
        async publish() {},
      },
    };

    const first = await planFactoryIssue(run, dependencies);
    const second = await planFactoryIssue(first, dependencies);

    assert.equal(first.id, second.id);
    assert.equal(second.state, 'planned');
    assert.equal(plans, 1);
    assert.equal(second.version, first.version);
  });

  test('rejects runs that are not classified', async () => {
    const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
    const { run } = await orchestrator.start(task);
    await assert.rejects(
      () =>
        planFactoryIssue(run, {
          orchestrator,
          planner: {
            async plan() {
              return plan;
            },
          },
          progress: { async publish() {} },
        }),
      /queued; expected classified/,
    );
  });

  test('claims planning so concurrent workers plan and publish once', async () => {
    const { orchestrator, run } = await classifiedRun();
    const messages: string[] = [];
    let plans = 0;
    let entered = 0;
    let releasePlanner = () => {};
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const beginPlanning = orchestrator.beginPlanning.bind(orchestrator);
    orchestrator.beginPlanning = async (id) => {
      const result = await beginPlanning(id);
      entered += 1;
      if (entered >= 2) releasePlanner();
      return result;
    };

    const dependencies = {
      orchestrator,
      planner: {
        async plan() {
          plans += 1;
          await plannerGate;
          return plan;
        },
      },
      progress: {
        async publish(_task: typeof task, body: string) {
          messages.push(body);
        },
      },
    };

    const [first, second] = await Promise.all([
      planFactoryIssue(run, dependencies),
      planFactoryIssue(run, dependencies),
    ]);

    assert.equal(plans, 1);
    assert.deepEqual(messages, [
      'Factory planning started: inspecting the repository.',
      'Factory plan recorded: Add a read-only planner stage.',
    ]);
    assert.equal(first.state, 'planned');
    assert.equal(second.state, 'planned');
    assert.deepEqual(first.plan, plan);
    assert.deepEqual(second.plan, plan);
  });

  test('reclaims planning after the lease expires', async () => {
    const store = new MemoryFactoryRunStore();
    const orchestrator = new FactoryOrchestrator(store);
    const { run } = await orchestrator.start(task);
    const classified = await orchestrator.classify(run.id, classification);
    const held = await orchestrator.beginPlanning(classified.id);
    assert.equal(held.claimed, true);
    await store.save(
      {
        ...held.run,
        planningStartedAt: Date.now() - PLANNING_LEASE_MS - 1,
        version: held.run.version + 1,
        updatedAt: Date.now(),
      },
      held.run.version,
    );
    const reclaimed = await orchestrator.beginPlanning(classified.id);
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.run.state, 'planning');
  });
});

async function classifiedRun(): Promise<{ orchestrator: FactoryOrchestrator; run: FactoryRun }> {
  const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
  const { run } = await orchestrator.start(task);
  return { orchestrator, run: await orchestrator.classify(run.id, classification) };
}
