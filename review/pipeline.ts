import type { ReviewPublishResult, ReviewPublisher } from '../github/adapter.ts';
import {
  runAdvisor,
  type AdvisorConfig,
  type AdvisorDecisionRecord,
  type AdvisorRunner,
} from './advisor.ts';
import type { PrDataSource } from './pr-data.ts';
import type { ReviewResult } from './schema.ts';
import {
  adjudicateFindings,
  runSpecialistReview,
  type FindingProvenance,
  type SpecialistConfig,
  type SpecialistContext,
  type SpecialistRunner,
} from './specialists.ts';

export type ReviewPipelineMetadata = {
  provenance: FindingProvenance[];
  advisorDecisions: AdvisorDecisionRecord[];
  specialistErrors: string[];
  advisorErrors: string[];
  validationIssues: string[];
};

export type ReviewPipelineReport = {
  review: ReviewResult;
  metadata: ReviewPipelineMetadata;
};

/**
 * Trusted pre-publication boundary. Findings keep the canonical Finding shape;
 * specialist provenance and advisor decisions travel beside the review.
 */
export async function runReviewPipeline(options: {
  review: ReviewResult;
  specialist: { config: SpecialistConfig; context: SpecialistContext; runner: SpecialistRunner };
  advisor: { config: AdvisorConfig; runner?: AdvisorRunner; repositoryContext?: string };
}): Promise<ReviewPipelineReport> {
  const specialist = await runSpecialistReview(options.specialist);
  const adjudicated = adjudicateFindings([
    ...options.review.findings.map((finding) => ({
      finding,
      sources: ['generalist' as const],
    })),
    ...specialist.provenance,
  ]);
  const advised = await runAdvisor({
    config: options.advisor.config,
    candidates: adjudicated.map(({ finding }) => finding),
    diff: options.specialist.context.diff,
    repositoryContext: options.advisor.repositoryContext,
    runner: options.advisor.runner,
  });

  return {
    review: {
      ...options.review,
      verdict: advised.findings.some(
        (finding) => finding.severity === 'P0' || finding.severity === 'P1',
      )
        ? 'REQUEST_CHANGES'
        : 'COMMENT',
      findings: advised.findings,
    },
    metadata: {
      provenance: alignProvenance(adjudicated, advised.findings, advised.decisions),
      advisorDecisions: options.advisor.config.enabled ? advised.decisions : [],
      specialistErrors: specialist.errors,
      advisorErrors: advised.errors,
      validationIssues: specialist.validationIssues,
    },
  };
}

/**
 * Compose model review stages in front of the narrow GitHub publisher. This is
 * the sole production path from the agent's validated output to publication.
 */
export function createReviewPipelinePublisher(options: {
  publisher: ReviewPublisher;
  dataSource: PrDataSource;
  maxDiffLines: number;
  specialist: { config: SpecialistConfig; runner: SpecialistRunner };
  advisor: { config: AdvisorConfig; runner?: AdvisorRunner };
}): ReviewPublisher {
  return {
    async publish(review: ReviewResult): Promise<ReviewPublishResult> {
      const [metadata, diff, context] = await Promise.all([
        options.dataSource.getMetadata(),
        options.dataSource.getDiff(options.maxDiffLines),
        options.dataSource.getReviewContext(),
      ]);
      const repositoryContext = context.files
        .map((file) => `## ${file.path}\n${file.content}`)
        .join('\n\n');
      const report = await runReviewPipeline({
        review,
        specialist: {
          config: options.specialist.config,
          context: {
            prNumber: metadata.number,
            title: metadata.title,
            body: metadata.body,
            diff: diff.content,
            changedFiles: metadata.changedFiles
              .filter((file) => !file.skip)
              .map((file) => file.path),
            repositoryContext,
          },
          runner: options.specialist.runner,
        },
        advisor: {
          config: options.advisor.config,
          runner: options.advisor.runner,
          repositoryContext,
        },
      });
      const published = await options.publisher.publish(report.review, report.metadata);
      return {
        ...published,
        validationIssues: [
          ...report.metadata.validationIssues,
          ...report.metadata.specialistErrors,
          ...report.metadata.advisorErrors,
          ...published.validationIssues,
        ],
      };
    },
  };
}

function alignProvenance(
  candidates: FindingProvenance[],
  retainedFindings: ReviewResult['findings'],
  decisions: AdvisorDecisionRecord[],
): FindingProvenance[] {
  let retainedIndex = 0;
  return decisions.flatMap((decision, candidateIndex) => {
    if (decision.decision === 'reject') return [];
    const finding = retainedFindings[retainedIndex++];
    return [{ finding, sources: candidates[candidateIndex].sources }];
  });
}
