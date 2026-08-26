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

/**
 * Records a repository-grounded plan for a classified factory run. Already
 * planned runs return without invoking the planner or emitting another comment.
 */
export async function planFactoryIssue(
  classifiedRun: FactoryRun,
  dependencies: {
    orchestrator: FactoryOrchestrator;
    planner: FactoryPlanner;
    progress: FactoryProgressPublisher;
  },
): Promise<FactoryRun> {
  const current = await dependencies.orchestrator.get(classifiedRun.id);
  if (current.state === 'planned') return current;
  if (current.state !== 'classified' || !current.classification) {
    throw new Error(`Factory run ${current.id} is ${current.state}; expected classified.`);
  }

  await dependencies.progress.publish(
    current.task,
    'Factory planning started: inspecting the repository.',
  );
  const plan = await dependencies.planner.plan({
    task: current.task,
    classification: current.classification,
  });
  const planned = await dependencies.orchestrator.plan(current.id, plan);
  await dependencies.progress.publish(planned.task, `Factory plan recorded: ${plan.summary}`);
  return planned;
}
