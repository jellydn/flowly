/**
 * Independent factory review boundary. The reviewer sees the issue, structured
 * plan, real git diff, and recorded verification outcomes — never implementer
 * chain-of-thought, conversation history, or workspace scratch.
 */

import { assertFactoryBranch } from './git.ts';
import type { AcceptanceCriterion, FactoryRun, ReviewVerdict } from './types.ts';

/** Evidence the independent reviewer is allowed to see. */
export type IsolatedFactoryReviewEvidence = {
  issueNumber: number;
  title: string;
  body: string;
  repository: string;
  branch: string;
  commitSha: string;
  changedFiles: string[];
  diff: string;
  planSummary: string;
  acceptanceCriteria: AcceptanceCriterion[];
  verification: Array<{ command: string; exitCode: number }>;
};

/** Reviewer-owned judgment for one acceptance criterion. */
export type CriterionJudgment = {
  description: string;
  satisfied: boolean;
  evidence: string;
};

/**
 * Structured output from the existing review system (or a deterministic
 * stand-in). `verdict` cannot be APPROVE — the factory never auto-approves.
 */
export type IndependentReviewOutput = {
  summary: string;
  verdict: 'COMMENT' | 'REQUEST_CHANGES';
  findings: Array<{ title: string; explanation: string }>;
};

export type FactoryIndependentReviewer = {
  review(evidence: IsolatedFactoryReviewEvidence): Promise<IndependentReviewOutput>;
};

const SHA = /^[a-f0-9]{40}$/;

/**
 * Project a factory run plus its git diff onto the isolated evidence shape.
 * Extra implementer fields are dropped rather than forwarded.
 */
export function isolateReviewEvidence(
  run: FactoryRun,
  diff: string,
): IsolatedFactoryReviewEvidence {
  if (run.state !== 'reviewing') {
    throw new Error(`Factory run ${run.id} is ${run.state}; expected reviewing.`);
  }
  if (!run.plan) throw new Error(`Factory run ${run.id} has no implementation plan.`);
  if (!run.implementation) {
    throw new Error(`Factory run ${run.id} has no implementation result.`);
  }
  if (!run.branch) throw new Error(`Factory run ${run.id} has no factory-owned branch.`);
  assertFactoryBranch(run.branch);
  if (!SHA.test(run.implementation.commitSha)) {
    throw new Error('Independent review requires a full 40-character commit SHA.');
  }
  const trimmedDiff = diff.trim();
  if (!trimmedDiff) throw new Error('Independent review requires a non-empty git diff.');

  return {
    issueNumber: run.task.issueNumber,
    title: run.task.title,
    body: run.task.body,
    repository: run.task.repository,
    branch: run.branch,
    commitSha: run.implementation.commitSha,
    changedFiles: [...run.implementation.changedFiles],
    diff: trimmedDiff,
    planSummary: run.plan.summary,
    acceptanceCriteria: run.plan.acceptanceCriteria.map((criterion) => ({
      description: criterion.description,
    })),
    verification: run.implementation.commands.map(({ command, exitCode }) => ({
      command,
      exitCode,
    })),
  };
}

/**
 * Map isolated evidence, reviewer judgments, and review-system output onto a
 * persisted verdict. Missing criteria are unsatisfied rather than inferred from
 * implementer claims.
 */
export function buildReviewVerdict(
  evidence: IsolatedFactoryReviewEvidence,
  output: IndependentReviewOutput,
  judgments: CriterionJudgment[],
): ReviewVerdict {
  const byDescription = new Map(judgments.map((judgment) => [judgment.description, judgment]));
  const acceptanceCriteria = evidence.acceptanceCriteria.map((criterion) => {
    const judgment = byDescription.get(criterion.description);
    if (!judgment) {
      return {
        description: criterion.description,
        satisfied: false,
        evidence: 'Independent review did not assess this criterion.',
      };
    }
    return {
      description: judgment.description,
      satisfied: judgment.satisfied,
      evidence: judgment.evidence,
    };
  });
  const unresolvedFindings = output.findings.map(
    (finding) => `${finding.title}: ${finding.explanation}`,
  );
  const allCriteriaSatisfied = acceptanceCriteria.every((criterion) => criterion.satisfied);
  return {
    readyForHumanReview: output.verdict === 'COMMENT' && allCriteriaSatisfied,
    acceptanceCriteria,
    summary: output.summary,
    unresolvedFindings,
  };
}

/**
 * Run the independent reviewer against isolated evidence and return the
 * persisted verdict. Callers must not pass implementer scratch into `reviewer`.
 */
export async function reviewFactoryImplementation(
  run: FactoryRun,
  diff: string,
  reviewer: FactoryIndependentReviewer,
  judgmentsFrom: (
    evidence: IsolatedFactoryReviewEvidence,
    output: IndependentReviewOutput,
  ) => CriterionJudgment[],
): Promise<ReviewVerdict> {
  const evidence = isolateReviewEvidence(run, diff);
  const output = await reviewer.review(evidence);
  return buildReviewVerdict(evidence, output, judgmentsFrom(evidence, output));
}
