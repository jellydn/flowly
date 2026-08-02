import type { GitHubClient, IssueComment } from '../github/client.ts';
import {
  encodeReviewState,
  isReviewStateComment,
  parseReviewState,
  type ReviewState,
} from './review-state.ts';

/**
 * Trusted store for the persistent review state. The state is kept in a hidden
 * HTML-comment inside a PR-level (issue) comment, updated in place across
 * review runs so the thread doesn't accumulate state comments.
 *
 * The agent never calls this directly — the data source reads through
 * {@link load} (via `get_previous_review_state`) and the trusted publisher
 * writes through {@link save} after posting a review.
 */

/**
 * Check whether an issue comment was authored by a bot account. The default
 * `GITHUB_TOKEN` in GitHub Actions posts as `github-actions[bot]`; custom
 * apps post as `{app-name}[bot]`. This prevents untrusted PR participants
 * from spoofing review state with a crafted hidden comment.
 */
function isBotComment(comment: IssueComment): boolean {
  return comment.user?.login?.endsWith('[bot]') ?? false;
}

export interface ReviewStateStore {
  load(): Promise<ReviewState | null>;
  save(state: ReviewState): Promise<void>;
}

export function createGitHubReviewStateStore(
  client: GitHubClient,
  prNumber: number,
): ReviewStateStore {
  // Cache the comment id: undefined = not yet looked up, null = none exists,
  // number = the id of the existing state comment.
  let stateCommentId: number | null | undefined = undefined;

  async function findStateComment(): Promise<IssueComment | null> {
    const comments = await client.listIssueComments(prNumber);
    // Search from the most recent backwards — the state comment is updated
    // in place, so it's typically the last one we posted. Only trust state
    // comments from bot accounts to prevent untrusted PR participants from
    // spoofing state with a crafted hidden comment.
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const comment = comments[i];
      if (isReviewStateComment(comment.body) && isBotComment(comment)) {
        stateCommentId = comment.id;
        return comment;
      }
    }
    stateCommentId = null;
    return null;
  }

  return {
    async load(): Promise<ReviewState | null> {
      const comment = await findStateComment();
      if (!comment) return null;
      return parseReviewState(comment.body);
    },

    async save(state: ReviewState): Promise<void> {
      const body = encodeReviewState(state);
      // Ensure we know whether a state comment already exists.
      if (stateCommentId === undefined) {
        await findStateComment();
      }
      if (stateCommentId !== null && stateCommentId !== undefined) {
        await client.updateIssueComment(stateCommentId, body);
      } else {
        const created = await client.createIssueComment(prNumber, body);
        stateCommentId = created.id;
      }
    },
  };
}
