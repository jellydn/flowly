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
import { decideFactoryAutonomyGate, evaluateFactoryAutonomy } from './autonomy.ts';

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
    });
  }
  if (
    current.state === 'planned' ||
    current.state === 'implementing' ||
    current.state === 'verifying'
  ) {
    current = await decideAndRecordGate(current, 'implementation', dependencies);
    const implementationAllowed = current.autonomy?.gateDecisions.some(
      (decision) => decision.boundary === 'implementation' && decision.allowed,
    );
    if (!implementationAllowed) return current;
    current = await runControlledImplementation(current, implementationDependencies(dependencies));
  }
  if (current.state === 'failed') return current;
  if (current.state === 'reviewing') {
    current = await decideAndRecordGate(current, 'publication', dependencies);
    const publicationAllowed = current.autonomy?.gateDecisions.some(
      (decision) => decision.boundary === 'publication' && decision.allowed,
    );
    if (!publicationAllowed) return current;
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

async function decideAndRecordGate(
  run: FactoryRun,
  boundary: 'implementation' | 'publication',
  dependencies: FactoryPipelineDependencies,
): Promise<FactoryRun> {
  if (!run.autonomy) throw new Error(`Factory run ${run.id} has no autonomy audit.`);
  const updated = await dependencies.orchestrator.recordAutonomyGate(
    run.id,
    boundary,
    decideFactoryAutonomyGate(run.autonomy, boundary, dependencies.manualConfirmation),
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
