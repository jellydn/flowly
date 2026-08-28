import { FactoryOrchestrator } from './orchestrator.ts';
import type { FactoryRun, FactoryTask, TaskClassification } from './types.ts';

/** Read-only classifier boundary. Implementations must not mutate a repository. */
export type FactoryClassifier = {
  classify(task: FactoryTask): Promise<TaskClassification>;
};

/** Trusted GitHub-comment boundary; stage code cannot call GitHub directly. */
export type FactoryProgressPublisher = {
  publish(task: FactoryTask, body: string): Promise<void>;
};

export type FactoryIntakeResult = {
  run: FactoryRun;
  duplicate: boolean;
};

/**
 * Ensures a factory issue is classified. Runs already past `queued` return as-is.
 * A leftover `queued` snapshot continues classification.
 */
export async function intakeFactoryIssue(
  task: FactoryTask,
  dependencies: {
    orchestrator: FactoryOrchestrator;
    classifier: FactoryClassifier;
    progress: FactoryProgressPublisher;
  },
): Promise<FactoryIntakeResult> {
  const started = await dependencies.orchestrator.start(task);
  if (started.run.state !== 'queued') return started;

  if (!started.duplicate) {
    await dependencies.progress.publish(task, 'Factory run started: classifying the issue.');
  }
  const classification = await dependencies.classifier.classify(task);
  const run = await dependencies.orchestrator.classify(started.run.id, classification);

  if (!classification.actionable) {
    const missing = classification.missingInformation.map((item) => `- ${item}`).join('\n');
    await dependencies.progress.publish(
      task,
      `Factory run needs input before planning:\n${missing || '- Clarify the requested change.'}`,
    );
    return { run, duplicate: started.duplicate };
  }

  await dependencies.progress.publish(task, 'Factory classification complete: ready for planning.');
  return { run, duplicate: started.duplicate };
}
