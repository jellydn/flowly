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
import type { FactoryRun } from './types.ts';

export type IndependentReviewPipelineDependencies = {
  orchestrator: FactoryOrchestrator;
  reviewer: FactoryIndependentReviewer;
  publisher: FactoryDraftPrPublisher;
  readDiff: (run: FactoryRun) => Promise<string>;
  judgmentsFrom: (
    evidence: IsolatedFactoryReviewEvidence,
    output: IndependentReviewOutput,
  ) => CriterionJudgment[];
  progress?: FactoryProgressPublisher;
};

/**
 * Record an independent review and open (or reuse) the draft PR. Already
 * published runs complete without creating another PR.
 */
export async function runIndependentReviewAndPublish(
  reviewingRun: FactoryRun,
  dependencies: IndependentReviewPipelineDependencies,
): Promise<FactoryRun> {
  if (reviewingRun.state === 'completed') return reviewingRun;
  if (reviewingRun.state === 'pr-created') {
    return dependencies.orchestrator.complete(reviewingRun.id);
  }

  const diff = await dependencies.readDiff(reviewingRun);
  const verdict = await reviewFactoryImplementation(
    reviewingRun,
    diff,
    dependencies.reviewer,
    dependencies.judgmentsFrom,
  );
  const reviewed = await dependencies.orchestrator.recordReview(reviewingRun.id, verdict);
  await dependencies.progress?.publish(
    reviewed.task,
    `Factory independent review recorded: ${verdict.summary}`,
  );

  const pullRequest = await dependencies.publisher.publish(reviewed);
  const published = await dependencies.orchestrator.recordDraftPr(reviewed.id, pullRequest.number);
  await dependencies.progress?.publish(
    published.task,
    `Factory draft PR #${pullRequest.number} created. Flowly will not merge or approve it.`,
  );
  return dependencies.orchestrator.complete(published.id);
}
