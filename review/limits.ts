/**
 * File-aware review limits. The repository QA agent shares a strict per-call
 * inspection budget (default 8) which is too small for medium PRs. The PR
 * reviewer instead bounds files, diff lines, context reads, and findings.
 *
 * All values are configurable through environment variables parsed by
 * {@link parseReviewLimits}.
 */

export type ReviewLimits = {
  /** Maximum number of changed files to review. */
  maxFiles: number;
  /** Maximum unified-diff lines returned by get_pr_diff. */
  maxDiffLines: number;
  /** Maximum read_file / search_code context calls. */
  maxContextReads: number;
  /** Maximum findings accepted by submit_review. */
  maxFindings: number;
};

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = {
  maxFiles: 30,
  maxDiffLines: 4000,
  maxContextReads: 20,
  maxFindings: 10,
};

function parseNum(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      `${raw} is not an integer in [${min}, ${max}]; using default ${fallback}.`,
    );
  }
  return n;
}

/** Parse review limits from environment variables. */
export function parseReviewLimits(
  env: Record<string, string | undefined>,
): ReviewLimits {
  return {
    maxFiles: parseNum(env['PR_REVIEW_MAX_FILES'], DEFAULT_REVIEW_LIMITS.maxFiles, 1, 100),
    maxDiffLines: parseNum(
      env['PR_REVIEW_MAX_DIFF_LINES'],
      DEFAULT_REVIEW_LIMITS.maxDiffLines,
      100,
      50_000,
    ),
    maxContextReads: parseNum(
      env['PR_REVIEW_MAX_CONTEXT_READS'],
      DEFAULT_REVIEW_LIMITS.maxContextReads,
      1,
      100,
    ),
    maxFindings: parseNum(
      env['PR_REVIEW_MAX_FINDINGS'],
      DEFAULT_REVIEW_LIMITS.maxFindings,
      0,
      50,
    ),
  };
}
