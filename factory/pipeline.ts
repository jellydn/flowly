/**
 * Independent review + draft-PR stage. Runs only after verification has
 * passed, feeds isolated evidence to the reviewer, then publishes a draft
 * PR through the trusted GitHub adapter.
 */

import type { FactoryProgressPublisher } from './intake.ts';
import type { FactoryOrchestrator } from './orchestrator.ts';
import type { FactoryDraftPrPublisher } from './publisher.ts';
import {
  type CriterionJudgment,
  type FactoryIndependentReviewer,
  type IndependentReviewOutput,
  type IsolatedFactoryReviewEvidence,
  reviewFactoryImplementation,
} from './review.ts';
import type { FactoryAutonomyPolicy, FactoryManualConfirmation, FactoryRun } from './types.ts';
import { assertFactoryAutonomyGate, factoryAutonomyGateAllowed } from './autonomy.ts';

export type IndependentReviewPipelineDependencies = {
  orchestrator: FactoryOrchestrator;
  reviewer: FactoryIndependentReviewer;
  publisher: FactoryDraftPrPublisher;
  readDiff: (run: FactoryRun) => Promise<string>;
  judgmentsFrom: (
    evidence: IsolatedFactoryReviewEvidence,
    output: IndependentReviewOutput,
  ) => CriterionJudgment[];
  autonomyPolicy?: FactoryAutonomyPolicy;
  manualConfirmation?: FactoryManualConfirmation;
  progress?: FactoryProgressPublisher;
  repositoryInstincts?: string;
};

/**
 * Record an independent review and open (or reuse) the draft PR. Already
 * published runs complete without creating another PR. A persisted verdict
 * is reused so a later publish failure can retry without re-reviewing.
 */
export async function runIndependentReviewAndPublish(
  reviewingRun: FactoryRun,
  dependencies: IndependentReviewPipelineDependencies,
): Promise<FactoryRun> {
  const current = await dependencies.orchestrator.get(reviewingRun.id);
  if (current.state === 'completed') return current;
  if (current.state === 'pr-created') {
    return dependencies.orchestrator.complete(current.id);
  }
  if (current.state !== 'reviewing') {
    throw new Error(`Factory run ${current.id} is ${current.state}; expected reviewing.`);
  }
  assertFactoryAutonomyGate(current, 'publication');

  let reviewed = current.review ? current : await recordIndependentReview(current, dependencies);
  if (!reviewed.review?.readyForHumanReview) {
    reviewed = await dependencies.orchestrator.applyAutonomyEvent(
      reviewed.id,
      'review-failure',
      dependencies.autonomyPolicy,
      undefined,
      'publication',
    );
    if (!factoryAutonomyGateAllowed(reviewed, 'publication')) return reviewed;
  }
  let pullRequest;
  try {
    pullRequest = await dependencies.publisher.publish(reviewed);
  } catch (error) {
    await dependencies.orchestrator.applyAutonomyEvent(
      reviewed.id,
      'publication-failure',
      dependencies.autonomyPolicy,
      undefined,
      'publication',
    );
    throw error;
  }
  if (pullRequest.state !== 'open' || !pullRequest.draft) {
    throw new Error('Factory publisher refused a non-draft pull request.');
  }
  const published = await dependencies.orchestrator.recordDraftPr(reviewed.id, pullRequest.number);
  await dependencies.progress?.publish(
    published.task,
    `Factory draft PR #${pullRequest.number} created. Flowly will not merge or approve it.`,
  );
  return dependencies.orchestrator.complete(published.id);
}

async function recordIndependentReview(
  reviewingRun: FactoryRun,
  dependencies: IndependentReviewPipelineDependencies,
): Promise<FactoryRun> {
  const diff = await dependencies.readDiff(reviewingRun);
  const verdict = await reviewFactoryImplementation(
    reviewingRun,
    diff,
    dependencies.reviewer,
    dependencies.judgmentsFrom,
    dependencies.repositoryInstincts,
  );
  const reviewed = await dependencies.orchestrator.recordReview(reviewingRun.id, verdict);
  await dependencies.progress?.publish(
    reviewed.task,
    `Factory independent review recorded: ${verdict.summary}`,
  );
  return reviewed;
}
