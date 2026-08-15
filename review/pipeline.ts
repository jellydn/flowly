import { adviseFindings, type AdvisorRunner } from './advisor.ts';
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
  advisor: { runner: AdvisorRunner; timeoutMs: number };
}): Promise<ReviewPipelineReport> {
  const specialist = await runSpecialistReview(options.specialist);
  const reviewerSources = Object.fromEntries(
    specialist.findings.map((finding) => [`${finding.path}:${finding.title}`, finding.sources]),
  );
  const advised = await adviseFindings({
    findings: specialist.findings,
    runner: options.advisor.runner,
    timeoutMs: options.advisor.timeoutMs,
  });
  return {
    findings: advised.findings.map((finding) => {
      const { sources: _sources, ...published } = finding as Finding & { sources?: string[] };
      return published;
    }),
    specialistErrors: specialist.errors,
    advisorErrors: advised.errors,
    reviewerSources,
  };
}
