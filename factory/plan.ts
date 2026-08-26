import type { FactoryProgressPublisher } from './intake.ts';
import type { FactoryOrchestrator } from './orchestrator.ts';
import type { FactoryRun, FactoryTask, ImplementationPlan, TaskClassification } from './types.ts';

export type FactoryPlannerInput = {
  task: FactoryTask;
  classification: TaskClassification;
};

/** Read-only analyst boundary. Implementations must not mutate a repository. */
export type FactoryPlanner = {
  plan(input: FactoryPlannerInput): Promise<ImplementationPlan>;
};

const PLANNING_WAIT_TIMEOUT_MS = 2000;
const PLANNING_WAIT_INTERVAL_MS = 10;

/**
 * Records a repository-grounded plan for a classified factory run. Concurrent
 * callers wait for the claim owner; only that owner plans and publishes.
 */
export async function planFactoryIssue(
  classifiedRun: FactoryRun,
  dependencies: {
    orchestrator: FactoryOrchestrator;
    planner: FactoryPlanner;
    progress: FactoryProgressPublisher;
  },
): Promise<FactoryRun> {
  const { run, claimed } = await dependencies.orchestrator.beginPlanning(classifiedRun.id);
  if (!claimed) {
    if (run.state === 'planned') return run;
    if (run.state === 'planning') {
      try {
        return await waitForPlannedRun(dependencies.orchestrator, run.id);
      } catch {
        const current = await dependencies.orchestrator.get(run.id);
        if (current.state === 'planned') return current;
        if (current.state !== 'planning' || !current.classification) {
          throw new Error(`Factory run ${current.id} is ${current.state}; expected planned.`);
        }
        return planAndPublish(current, dependencies);
      }
    }
    throw new Error(`Factory run ${run.id} is ${run.state}; expected classified.`);
  }
  if (!run.classification) {
    throw new Error(`Factory run ${run.id} is ${run.state}; expected classified.`);
  }
  return planAndPublish(run, dependencies);
}

async function planAndPublish(
  run: FactoryRun,
  dependencies: {
    orchestrator: FactoryOrchestrator;
    planner: FactoryPlanner;
    progress: FactoryProgressPublisher;
  },
): Promise<FactoryRun> {
  if (!run.classification) {
    throw new Error(`Factory run ${run.id} is ${run.state}; expected classified.`);
  }
  await dependencies.progress.publish(
    run.task,
    'Factory planning started: inspecting the repository.',
  );
  const localPlan = await dependencies.planner.plan({
    task: run.task,
    classification: run.classification,
  });
  const planned = await dependencies.orchestrator.plan(run.id, localPlan);
  await dependencies.progress.publish(planned.task, `Factory plan recorded: ${localPlan.summary}`);
  return planned;
}

async function waitForPlannedRun(
  orchestrator: FactoryOrchestrator,
  id: string,
): Promise<FactoryRun> {
  const deadline = Date.now() + PLANNING_WAIT_TIMEOUT_MS;
  for (;;) {
    const current = await orchestrator.get(id);
    if (current.state === 'planned') return current;
    if (Date.now() >= deadline) {
      throw new Error(`Factory run ${id} is ${current.state}; expected planned.`);
    }
    await new Promise((resolve) => setTimeout(resolve, PLANNING_WAIT_INTERVAL_MS));
  }
}
