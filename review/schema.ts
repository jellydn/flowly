import * as v from 'valibot';

/**
 * Structured review output contract. The agent emits this shape through the
 * `submit_review` tool; the trusted GitHub adapter validates it before posting.
 *
 * `verdict` is never `APPROVE` — the reviewer never auto-approves. When no
 * blocking issues are found, the agent uses `COMMENT` with an empty findings
 * array and a summary such as "No blocking issues found."
 */

export const severitySchema = v.picklist(['critical', 'high', 'medium', 'low']);

export const verdictSchema = v.picklist(['COMMENT', 'REQUEST_CHANGES']);

/**
 * Hard ceiling on findings per review. This schema is both the `submit_review`
 * tool input and what the trusted adapter re-validates, so it is the single
 * source of truth for the cap; {@link ./limits.ts} derives its configurable
 * maximum from this constant to keep the two from drifting apart.
 */
export const REVIEW_FINDINGS_CEILING = 50;

export const findingSchema = v.object({
  severity: severitySchema,
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  explanation: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  suggestion: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

/**
 * Classification of a previous finding in an incremental review. The agent
 * assesses whether each prior finding was addressed by the new commits.
 *
 * A finding is identified by its `path` + `line` + `title` triple, which is
 * stable across review runs for the same issue.
 */
export const findingStatusSchema = v.picklist([
  'resolved',
  'still-present',
  'obsolete',
  'uncertain',
]);

export const findingClassificationSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  status: findingStatusSchema,
  note: v.optional(v.pipe(v.string(), v.maxLength(500))),
});

/**
 * Category for a proposed repository learning. The agent suggests learnings
 * it discovered during review; a human reviews and manually adds them to
 * `.flue/repository-learnings.md`. The agent never writes to `.flue/` directly.
 */
export const learningCategorySchema = v.picklist([
  'convention',
  'test-command',
  'architecture',
  'common-issue',
  'documentation',
]);

export const proposedLearningSchema = v.object({
  category: learningCategorySchema,
  content: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  justification: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

/** Hard ceiling on proposed learnings per review. */
export const PROPOSED_LEARNINGS_CEILING = 20;

export const reviewResultSchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  verdict: verdictSchema,
  findings: v.pipe(v.array(findingSchema), v.maxLength(REVIEW_FINDINGS_CEILING)),
  /**
   * Optional in incremental reviews: the agent's assessment of each finding
   * from the previous review. Omitted on first review (no previous state).
   */
  previousFindingClassifications: v.optional(
    v.pipe(v.array(findingClassificationSchema), v.maxLength(REVIEW_FINDINGS_CEILING)),
  ),
  /**
   * Optional: learnings the agent suggests adding to
   * `.flue/repository-learnings.md`. Rendered in the review body for manual
   * approval — the agent never modifies files directly.
   */
  proposedLearnings: v.optional(
    v.pipe(v.array(proposedLearningSchema), v.maxLength(PROPOSED_LEARNINGS_CEILING)),
  ),
});

export type Severity = v.InferOutput<typeof severitySchema>;
export type Verdict = v.InferOutput<typeof verdictSchema>;
export type Finding = v.InferOutput<typeof findingSchema>;
export type FindingStatus = v.InferOutput<typeof findingStatusSchema>;
export type FindingClassification = v.InferOutput<typeof findingClassificationSchema>;
export type LearningCategory = v.InferOutput<typeof learningCategorySchema>;
export type ProposedLearning = v.InferOutput<typeof proposedLearningSchema>;
export type ReviewResult = v.InferOutput<typeof reviewResultSchema>;

/**
 * Parse and validate an unknown value as a {@link ReviewResult}. Throws a
 * Valibot `ValiError` on invalid input so the caller can surface a clear
 * message.
 */
export function parseReviewResult(value: unknown): ReviewResult {
  return v.parse(reviewResultSchema, value);
}

/**
 * Safe validation that never throws. Returns the parsed result or a list of
 * human-readable issues. Used by the trusted adapter to reject malformed
 * agent output without crashing the run.
 */
export function safeParseReviewResult(
  value: unknown,
): { ok: true; value: ReviewResult } | { ok: false; issues: string[] } {
  const result = v.safeParse(reviewResultSchema, value);
  if (result.success) return { ok: true, value: result.output };
  const issues = result.issues.map(
    (issue) =>
      `${issue.path ? issue.path.map((p) => p.key).join('.') : '(root)'}: ${issue.message}`,
  );
  return { ok: false, issues };
}
