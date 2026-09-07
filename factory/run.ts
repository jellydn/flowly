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
import type { FactoryAutonomyPolicy, FactoryManualConfirmation } from './types.ts';
import type { RepositoryLearningService } from '../memory/service.ts';
import type { RepositoryLearningStage } from '../memory/types.ts';
import {
  decideFactoryAutonomyGate,
  evaluateFactoryAutonomy,
  factoryAutonomyGateAllowed,
} from './autonomy.ts';

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
  autonomyPolicy?: FactoryAutonomyPolicy;
  manualConfirmation?: FactoryManualConfirmation;
  learning?: RepositoryLearningService;
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
  const result = await advanceFactoryRun(run, dependencies);
  if (dependencies.learning) {
    try {
      await dependencies.learning.observeFactoryRuns(
        await dependencies.orchestrator.history(task.repository),
      );
    } catch (error) {
      await publishLearningFailure(dependencies, task, error);
    }
  }
  return result;
}

export async function advanceFactoryRun(
  run: FactoryRun,
  dependencies: FactoryPipelineDependencies,
): Promise<FactoryRun> {
  let current = await dependencies.orchestrator.get(run.id);
  if (!current.autonomy) {
    const history = await dependencies.orchestrator.history(current.task.repository, current.id);
    current = await dependencies.orchestrator.recordAutonomyAudit(
      current.id,
      evaluateFactoryAutonomy(dependencies.autonomyPolicy, history),
    );
  }
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
  if (current.state === 'classified' || current.state === 'planning') {
    current = await planFactoryIssue(current, {
      orchestrator: dependencies.orchestrator,
      planner: dependencies.planner,
      progress: dependencies.progress,
      repositoryInstincts: dependencies.learning
        ? async (paths) =>
            (await learningContext(dependencies, current.task, 'planning', paths)) ?? ''
        : undefined,
    });
  }
  if (
    current.state === 'planned' ||
    current.state === 'implementing' ||
    current.state === 'verifying'
  ) {
    current = await decideAndRecordGate(current, 'implementation', dependencies);
    if (!factoryAutonomyGateAllowed(current, 'implementation')) return current;
    const paths = current.plan?.relevantFiles ?? [];
    current = await runControlledImplementation(current, {
      ...implementationDependencies(dependencies),
      repositoryInstincts: await learningContext(
        dependencies,
        current.task,
        'implementation',
        paths,
      ),
      additionalVerificationCommands: await learningVerificationCommands(
        dependencies,
        current.task,
        paths,
      ),
    });
  }
  if (current.state === 'failed') {
    return dependencies.orchestrator.applyAutonomyEvent(
      current.id,
      'verification-failure',
      dependencies.autonomyPolicy,
      undefined,
      'implementation',
    );
  }
  if (current.state === 'reviewing') {
    current = await decideAndRecordGate(current, 'publication', dependencies);
    if (!factoryAutonomyGateAllowed(current, 'publication')) return current;
    current = await runIndependentReviewAndPublish(current, {
      orchestrator: dependencies.orchestrator,
      reviewer: dependencies.reviewer,
      publisher: dependencies.publisher,
      readDiff: dependencies.readDiff,
      judgmentsFrom: dependencies.judgmentsFrom,
      autonomyPolicy: dependencies.autonomyPolicy,
      manualConfirmation: dependencies.manualConfirmation,
      progress: dependencies.progress,
      repositoryInstincts: await learningContext(
        dependencies,
        current.task,
        'review',
        current.implementation?.changedFiles ?? [],
      ),
    });
  }
  return current;
}

async function learningContext(
  dependencies: FactoryPipelineDependencies,
  task: FactoryTask,
  stage: RepositoryLearningStage,
  paths: string[],
): Promise<string | undefined> {
  if (!dependencies.learning) return undefined;
  try {
    return await dependencies.learning.contextFor(stage, paths);
  } catch (error) {
    await publishLearningFailure(dependencies, task, error);
    return undefined;
  }
}

async function learningVerificationCommands(
  dependencies: FactoryPipelineDependencies,
  task: FactoryTask,
  paths: string[],
): Promise<string[] | undefined> {
  if (!dependencies.learning) return undefined;
  try {
    return await dependencies.learning.verificationCommandsFor(paths);
  } catch (error) {
    await publishLearningFailure(dependencies, task, error);
    return undefined;
  }
}

async function publishLearningFailure(
  dependencies: FactoryPipelineDependencies,
  task: FactoryTask,
  error: unknown,
): Promise<void> {
  try {
    await dependencies.progress.publish(
      task,
      `Repository learning was skipped without changing the factory run: ${error instanceof Error ? error.message : String(error)}`,
    );
  } catch {
    // An optional learning diagnostic must not change the factory outcome.
  }
}

async function decideAndRecordGate(
  run: FactoryRun,
  boundary: 'implementation' | 'publication',
  dependencies: FactoryPipelineDependencies,
): Promise<FactoryRun> {
  if (!run.autonomy) throw new Error(`Factory run ${run.id} has no autonomy audit.`);
  const updated = await dependencies.orchestrator.recordAutonomyGate(
    run.id,
    boundary,
    decideFactoryAutonomyGate(
      run.autonomy,
      boundary,
      run.autonomyEvents?.length ? undefined : dependencies.manualConfirmation,
    ),
  );
  const decision = updated.autonomy?.gateDecisions.find((item) => item.boundary === boundary);
  if (decision && !decision.allowed) {
    await dependencies.progress.publish(
      updated.task,
      `Factory autonomy gate stopped before ${boundary}: ${decision.reason} Human confirmation may advance this run by one boundary.`,
    );
  }
  return updated;
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
