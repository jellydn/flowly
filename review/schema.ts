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

export const reviewResultSchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  verdict: verdictSchema,
  findings: v.pipe(v.array(findingSchema), v.maxLength(REVIEW_FINDINGS_CEILING)),
});

export type Severity = v.InferOutput<typeof severitySchema>;
export type Verdict = v.InferOutput<typeof verdictSchema>;
export type Finding = v.InferOutput<typeof findingSchema>;
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
