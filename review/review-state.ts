import * as v from 'valibot';
import {
  findingSchema,
  type Finding,
} from './schema.ts';

/**
 * Persistent review state stored in a hidden PR comment between review runs.
 *
 * The state is encoded as an HTML comment in the issue (PR) comment body so it
 * is invisible in the GitHub UI but readable via the API:
 *
 * ```
 * <!-- flue-review-state
 * {"reviewedHeadSha":"abc123","findings":[...],"reviewedAt":1700000000}
 * -->
 * ```
 *
 * On `synchronize`, the reviewer reads this state, computes the incremental
 * diff from `reviewedHeadSha` to the new head, and asks the agent to classify
 * each previous finding as resolved / still-present / obsolete / uncertain.
 */

const STATE_MARKER = 'flue-review-state';

export const reviewStateSchema = v.object({
  reviewedHeadSha: v.pipe(v.string(), v.minLength(1)),
  findings: v.pipe(v.array(findingSchema), v.maxLength(50)),
  reviewedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type ReviewState = v.InferOutput<typeof reviewStateSchema>;

/**
 * Encode a {@link ReviewState} as a hidden HTML-comment body suitable for a
 * GitHub issue comment. The JSON is compact to keep the comment small.
 */
export function encodeReviewState(state: ReviewState): string {
  return `<!-- ${STATE_MARKER}\n${JSON.stringify(state)}\n-->`;
}

/**
 * Parse a comment body and return the embedded {@link ReviewState}, or `null`
 * when the body does not contain a state comment or the JSON is malformed.
 * Never throws — a corrupt state comment is treated as "no previous state".
 */
export function parseReviewState(body: string): ReviewState | null {
  if (!body.includes(STATE_MARKER)) return null;
  const match = body.match(/<!--\s*flue-review-state\s*:?[\s]*([\s\S]*?)\s*-->/);
  if (!match) return null;
  try {
    const json = JSON.parse(match[1]);
    return v.parse(reviewStateSchema, json);
  } catch {
    return null;
  }
}

/**
 * Check whether a comment body contains a review-state marker. Used to find
 * the state comment among all PR comments without parsing each one fully.
 */
export function isReviewStateComment(body: string): boolean {
  return body.includes(STATE_MARKER);
}
