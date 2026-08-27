import type { FactoryProgressPublisher } from './intake.ts';
import type { FactoryOrchestrator } from './orchestrator.ts';
import type { FactoryRun, ImplementationPlan, TaskClassification } from './types.ts';

export type FactoryPlannerInput = {
  task: FactoryRun['task'];
  classification: TaskClassification;
};

/** Read-only analyst boundary. Implementations must not mutate a repository. */
export type FactoryPlanner = {
  plan(input: FactoryPlannerInput): Promise<ImplementationPlan>;
};

const PLANNING_WAIT_INTERVAL_MS = 10;

type PlanDependencies = {
  orchestrator: FactoryOrchestrator;
  planner: FactoryPlanner;
  progress: FactoryProgressPublisher;
};

/**
 * Records a repository-grounded plan for a classified factory run. Concurrent
 * callers wait for the claim owner; only that owner plans and publishes.
 * Stale `planning` leases are reclaimed in {@link FactoryOrchestrator.beginPlanning}.
 */
export async function planFactoryIssue(
  classifiedRun: FactoryRun,
  dependencies: PlanDependencies,
): Promise<FactoryRun> {
  for (;;) {
    const { run, claimed } = await dependencies.orchestrator.beginPlanning(classifiedRun.id);
    if (claimed) {
      if (!run.classification) {
        throw new Error(`Factory run ${run.id} is ${run.state}; expected classified.`);
      }
      return planAndPublish(run, run.classification, dependencies);
    }
    if (run.state === 'planned') return run;
    await new Promise((resolve) => setTimeout(resolve, PLANNING_WAIT_INTERVAL_MS));
  }
}

async function planAndPublish(
  run: FactoryRun,
  classification: TaskClassification,
  dependencies: PlanDependencies,
): Promise<FactoryRun> {
  await dependencies.progress.publish(
    run.task,
    'Factory planning started: inspecting the repository.',
  );
  const localPlan = await dependencies.planner.plan({
    task: run.task,
    classification,
  });
  const planned = await dependencies.orchestrator.plan(run.id, localPlan);
  await dependencies.progress.publish(planned.task, `Factory plan recorded: ${localPlan.summary}`);
  return planned;
}
