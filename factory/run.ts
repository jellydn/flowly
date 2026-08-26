import {
  intakeFactoryIssue,
  type FactoryClassifier,
  type FactoryProgressPublisher,
} from './intake.ts';
import {
  runControlledImplementation,
  type ControlledImplementationDependencies,
  type FactoryImplementer,
  type FactoryGitMutator,
  type FactoryVerifier,
} from './implementation.ts';
import type { FactoryOrchestrator } from './orchestrator.ts';
import { planFactoryIssue, type FactoryPlanner } from './plan.ts';
import {
  runIndependentReviewAndPublish,
  type IndependentReviewPipelineDependencies,
} from './pipeline.ts';
import type { FactoryDraftPrPublisher } from './publisher.ts';
import type { FactoryRun, FactoryTask } from './types.ts';

export type FactoryPipelineDependencies = {
  orchestrator: FactoryOrchestrator;
  classifier: FactoryClassifier;
  planner: FactoryPlanner;
  progress: FactoryProgressPublisher;
  git: FactoryGitMutator;
  implementer: FactoryImplementer;
  verifier: FactoryVerifier;
  reviewer: IndependentReviewPipelineDependencies['reviewer'];
  publisher: FactoryDraftPrPublisher;
  readDiff: IndependentReviewPipelineDependencies['readDiff'];
  judgmentsFrom: IndependentReviewPipelineDependencies['judgmentsFrom'];
  baseRef?: string;
  commitMessage?: string;
};

/**
 * Runs Classifier → Analyst → Implementer → Reviewer → draft PR for one issue.
 * Duplicate deliveries reuse the existing run and continue from its current
 * stage. Non-actionable issues and failed verification stop without a PR.
 */
export async function runFactoryPipeline(
  task: FactoryTask,
  dependencies: FactoryPipelineDependencies,
): Promise<FactoryRun> {
  const { run } = await intakeFactoryIssue(task, {
    orchestrator: dependencies.orchestrator,
    classifier: dependencies.classifier,
    progress: dependencies.progress,
  });
  return advanceFactoryRun(run, dependencies);
}

export async function advanceFactoryRun(
  run: FactoryRun,
  dependencies: FactoryPipelineDependencies,
): Promise<FactoryRun> {
  let current = await dependencies.orchestrator.get(run.id);
  if (
    current.state === 'needs-input' ||
    current.state === 'failed' ||
    current.state === 'completed'
  ) {
    return current;
  }
  if (current.state === 'pr-created') {
    return dependencies.orchestrator.complete(current.id);
  }
  if (current.state === 'classified') {
    current = await planFactoryIssue(current, {
      orchestrator: dependencies.orchestrator,
      planner: dependencies.planner,
      progress: dependencies.progress,
    });
  }
  if (current.state === 'planned') {
    current = await runControlledImplementation(current, implementationDependencies(dependencies));
  }
  if (current.state === 'failed') return current;
  if (current.state === 'reviewing') {
    current = await runIndependentReviewAndPublish(current, {
      orchestrator: dependencies.orchestrator,
      reviewer: dependencies.reviewer,
      publisher: dependencies.publisher,
      readDiff: dependencies.readDiff,
      judgmentsFrom: dependencies.judgmentsFrom,
      progress: dependencies.progress,
    });
  }
  return current;
}

function implementationDependencies(
  dependencies: FactoryPipelineDependencies,
): ControlledImplementationDependencies {
  return {
    orchestrator: dependencies.orchestrator,
    git: dependencies.git,
    implementer: dependencies.implementer,
    verifier: dependencies.verifier,
    baseRef: dependencies.baseRef,
    commitMessage: dependencies.commitMessage,
  };
}
