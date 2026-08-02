/**
 * Trusted review publisher — the narrow boundary between the agent's
 * structured output and the GitHub mutation API.
 *
 * The agent never holds the GitHub token or a generic shell. It calls
 * `submit_review` with a {@link ReviewResult}; this adapter:
 *   1. Re-validates the result against the Valibot schema.
 *   2. Confirms every finding's `path` is among the PR's changed files.
 *   3. Clamps each finding's `line` to a valid diff hunk for that file so
 *      GitHub accepts the inline comment.
 *   4. Caps the number of findings to the configured limit.
 *   5. Posts exactly one review (COMMENT or REQUEST_CHANGES, never APPROVE)
 *      with inline comments via {@link GitHubClient}.
 *
 * Findings whose path is not in the diff are dropped from inline comments but
 * still summarized in the review body so no analysis is silently lost.
 */

import type { GitHubClient, GitHubReviewComment, GitHubReviewPayload } from './client.ts';
import {
  findFileDiff,
  hunkForLine,
  parseUnifiedDiff,
  type FileDiff,
} from '../review/diff.ts';
import { safeParseReviewResult, type Finding, type ReviewResult } from '../review/schema.ts';
import type { ReviewLimits } from '../review/limits.ts';

export type ReviewPublishResult = {
  reviewId: number;
  htmlUrl: string;
  submittedFindings: number;
  skippedFindings: number;
  /** Issues that prevented posting (never includes raw agent output). */
  validationIssues: string[];
};

export type ReviewPublisherOptions = {
  client: GitHubClient;
  prNumber: number;
  /** Provider for the full unified diff, used to validate inline-comment line numbers. Resolved once and cached. */
  diffProvider: () => Promise<string>;
  limits: ReviewLimits;
};

export type ReviewPublisher = {
  publish(result: unknown): Promise<ReviewPublishResult>;
};

export function createReviewPublisher(
  options: ReviewPublisherOptions,
): ReviewPublisher {
  let cachedDiff: string | null = null;
  let cachedFileDiffs: FileDiff[] | null = null;
  let cachedChangedPaths: Set<string> | null = null;

  async function resolveDiff(): Promise<{
    fileDiffs: FileDiff[];
    changedPaths: Set<string>;
  }> {
    if (cachedDiff === null) {
      cachedDiff = await options.diffProvider();
      cachedFileDiffs = parseUnifiedDiff(cachedDiff);
      cachedChangedPaths = new Set(cachedFileDiffs.map((f) => f.path));
    }
    return {
      fileDiffs: cachedFileDiffs!,
      changedPaths: cachedChangedPaths!,
    };
  }

  return {
    async publish(result: unknown): Promise<ReviewPublishResult> {
      const parsed = safeParseReviewResult(result);
      if (!parsed.ok) {
        throw new Error(
          `submit_review received an invalid review result:\n- ${parsed.issues.join('\n- ')}`,
        );
      }

      const { fileDiffs, changedPaths } = await resolveDiff();
      return publishValidatedReview(
        parsed.value,
        options.client,
        options.prNumber,
        fileDiffs,
        changedPaths,
        options.limits,
      );
    },
  };
}

async function publishValidatedReview(
  result: ReviewResult,
  client: GitHubClient,
  prNumber: number,
  fileDiffs: FileDiff[],
  changedPaths: Set<string>,
  limits: ReviewLimits,
): Promise<ReviewPublishResult> {
  const capped = result.findings.slice(0, limits.maxFindings);
  const skippedFindings = result.findings.length - capped.length;

  const inlineComments: GitHubReviewComment[] = [];
  const droppedFindings: { finding: Finding; reason: string }[] = [];

  for (const finding of capped) {
    if (!changedPaths.has(finding.path)) {
      droppedFindings.push({
        finding,
        reason: `path "${finding.path}" is not in the PR diff`,
      });
      continue;
    }

    const fileDiff = findFileDiff(fileDiffs, finding.path);
    const hunk = fileDiff ? hunkForLine(fileDiff, finding.line) : null;
    const clampedLine = hunk ? clampToHunk(hunk.newStart, hunk.newEnd, finding.line) : finding.line;

    inlineComments.push({
      path: finding.path,
      line: clampedLine,
      side: 'RIGHT',
      body: formatFindingBody(finding),
    });
  }

  const event: GitHubReviewPayload['event'] =
    result.verdict === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT';

  const payload: GitHubReviewPayload = {
    event,
    body: formatReviewBody(result.summary, capped, droppedFindings, skippedFindings),
    comments: inlineComments,
  };

  const submitted = await client.submitReview(prNumber, payload);

  return {
    reviewId: submitted.id,
    htmlUrl: submitted.html_url,
    submittedFindings: inlineComments.length,
    skippedFindings: skippedFindings + droppedFindings.length,
    validationIssues: droppedFindings.map((d) => d.reason),
  };
}

function clampToHunk(newStart: number, newEnd: number, line: number): number {
  if (line < newStart) return newStart;
  if (line > newEnd) return newEnd;
  return line;
}

function formatFindingBody(finding: Finding): string {
  const parts = [
    `**[${finding.severity.toUpperCase()}] ${finding.title}**`,
    '',
    finding.explanation,
  ];
  if (finding.suggestion) {
    parts.push('', '**Suggestion:**', '```', finding.suggestion, '```');
  }
  parts.push('', `_confidence: ${finding.confidence}_`);
  return parts.join('\n');
}

function formatReviewBody(
  summary: string,
  findings: Finding[],
  droppedFindings: { finding: Finding; reason: string }[],
  skippedFindings: number,
): string {
  const lines = ['## Flue PR Review', '', summary, ''];

  if (findings.length === 0) {
    lines.push('No blocking issues found.');
  } else {
    lines.push('### Findings', '');
    for (const f of findings) {
      lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title} — \`${f.path}:${f.line}\``);
    }
  }

  if (droppedFindings.length > 0) {
    lines.push('', '### Findings not posted inline (path not in diff)', '');
    for (const d of droppedFindings) {
      lines.push(`- ${d.finding.title} — ${d.reason}`);
    }
  }

  if (skippedFindings > 0) {
    lines.push('', `_(${skippedFindings} finding(s) skipped over the ${findings.length} reviewed limit.)_`);
  }

  lines.push('', '---', '_Automated review by the Flue PR Review Agent._');
  return lines.join('\n');
}
