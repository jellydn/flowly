import { runAdvisor, type AdvisorConfig, type AdvisorRunner } from './advisor.ts';
import {
  runSpecialistReview,
  type SpecialistConfig,
  type SpecialistContext,
  type SpecialistRunner,
} from './specialists.ts';
import type { Finding } from './schema.ts';

export type ReviewPipelineReport = {
  findings: Finding[];
  specialistErrors: string[];
  advisorErrors: string[];
  reviewerSources: Record<string, string[]>;
};

/**
 * Trusted aggregation boundary for parallel review. Model runners receive only
 * their role-scoped input; publication receives only advisor-approved findings.
 */
export async function runReviewPipeline(options: {
  specialist: { config: SpecialistConfig; context: SpecialistContext; runner: SpecialistRunner };
  advisor: { config: AdvisorConfig; runner: AdvisorRunner; repositoryContext?: string };
}): Promise<ReviewPipelineReport> {
  const specialist = await runSpecialistReview(options.specialist);
  const reviewerSources = Object.fromEntries(
    specialist.findings.map((finding) => [`${finding.path}:${finding.title}`, finding.sources]),
  );
  const advised = await runAdvisor({
    config: options.advisor.config,
    candidates: specialist.findings,
    diff: options.specialist.context.diff,
    repositoryContext: options.advisor.repositoryContext,
    runner: options.advisor.runner,
  });
  return {
    findings: advised.findings.map((finding) => {
      const { advisor: _advisor, sources: _sources, ...published } = finding;
      return published;
    }),
    specialistErrors: specialist.errors,
    advisorErrors: advised.errors,
    reviewerSources,
  };
}
