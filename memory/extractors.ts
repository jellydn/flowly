import { createHash } from 'node:crypto';
import type { FactoryRun } from '../factory/types.ts';
import type { ReviewResult } from '../review/schema.ts';
import type { RepositoryLearningObservation } from './types.ts';

export function extractFactoryLearningObservations(
  runs: FactoryRun[],
): RepositoryLearningObservation[] {
  const ordered = runs.toSorted((left, right) => left.updatedAt - right.updatedAt);
  const observations: RepositoryLearningObservation[] = [];
  const laterSuccessfulCommands = new Set<string>();

  for (const run of ordered.toReversed()) {
    for (const result of run.implementation?.commands ?? []) {
      const statement = `Run \`${result.command}\` to verify repository changes.`;
      const common = {
        kind: 'verification' as const,
        source: 'factory-verification' as const,
        statement,
        paths: scopeFromPaths(run.implementation?.changedFiles ?? []),
        observedAt: run.updatedAt,
        runId: run.id,
        issueNumber: run.task.issueNumber,
        command: result.command,
      };
      if (result.exitCode === 0 && run.state !== 'failed') {
        laterSuccessfulCommands.add(result.command);
        observations.push({
          ...common,
          outcome: 'supporting',
          artifactId: `factory-run:${run.id}:verification:${result.command}:success`,
        });
      } else if (result.exitCode !== 0 && laterSuccessfulCommands.has(result.command)) {
        observations.push({
          ...common,
          outcome: 'contradicting',
          artifactId: `factory-run:${run.id}:verification:${result.command}:failure-before-fix`,
        });
      }
    }
  }

  for (const run of ordered) {
    for (const finding of run.review?.unresolvedFindings ?? []) {
      observations.push({
        kind: 'review-rule',
        source: 'factory-review',
        artifactId: `factory-run:${run.id}:review:${digest(finding)}`,
        statement: normalizeReviewRule(finding),
        paths: scopeFromPaths(run.implementation?.changedFiles ?? []),
        observedAt: run.updatedAt,
        runId: run.id,
        issueNumber: run.task.issueNumber,
      });
    }
  }
  return observations;
}

export function extractPrReviewLearningObservations(
  review: ReviewResult,
  prNumber: number,
  observedAt = Date.now(),
): RepositoryLearningObservation[] {
  return review.findings.map((finding) => ({
    kind: 'review-rule',
    source: 'pr-review',
    artifactId: `pr:${prNumber}:finding:${digest(`${finding.path}:${finding.title}`)}`,
    statement: normalizeReviewRule(finding.title),
    paths: scopeFromPaths([finding.path]),
    observedAt,
    prNumber,
  }));
}

function normalizeReviewRule(finding: string): string {
  const [title] = finding.trim().replace(/\s+/g, ' ').split(':', 1);
  return `Review changes for: ${title}.`;
}

function scopeFromPaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths.map((file) => {
        const separator = file.lastIndexOf('/');
        return separator < 0 ? file : `${file.slice(0, separator)}/**`;
      }),
    ),
  ].sort();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
