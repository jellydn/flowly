/**
 * Thin GitHub REST API client using the global `fetch`. No heavyweight
 * dependency (@octokit) is introduced — only the three endpoints the
 * reviewer needs: GET a pull request, list reviews, and submit a review.
 *
 * The token is held only by this client and the trusted adapter; it is never
 * passed into the agent's sandbox or registered tools' input schemas.
 */

export type PrApiData = {
  number: number;
  title: string;
  body: string;
  user: { login: string };
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  draft: boolean;
};

export type GitHubReviewComment = {
  path: string;
  /** Line in the new (right) side of the diff. */
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
};

export type GitHubReviewPayload = {
  event: 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';
  body: string;
  comments: GitHubReviewComment[];
};

export type SubmitReviewResult = { id: number; html_url: string };

/** A GitHub issue (PR) comment as returned by the REST API. */
export type IssueComment = {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
};

/** Result of creating or updating an issue comment. */
export type IssueCommentResult = { id: number; html_url: string };

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export type GitHubClientOptions = {
  owner: string;
  repo: string;
  token: string;
  /** Override the REST API base URL (GHES / proxy). Defaults to api.github.com. */
  apiUrl?: string;
};

const DEFAULT_API_URL = 'https://api.github.com';

export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  private readonly token: string;
  private readonly apiUrl: string;

  constructor(options: GitHubClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
  }

  /**
   * Build a client from GitHub Actions environment variables. `GITHUB_TOKEN`
   * and `GITHUB_REPOSITORY` (owner/repo) are required. `GITHUB_API_URL` is
   * optional and set automatically on GHES runners.
   */
  static fromEnv(env: Record<string, string | undefined>): GitHubClient {
    const token = env['GITHUB_TOKEN'];
    if (!token) throw new Error('GITHUB_TOKEN is required for the PR reviewer.');
    const repository = env['GITHUB_REPOSITORY'];
    if (!repository || !repository.includes('/')) {
      throw new Error('GITHUB_REPOSITORY must be set to "owner/repo" for the PR reviewer.');
    }
    const [owner, repo] = repository.split('/');
    return new GitHubClient({
      owner,
      repo,
      token,
      apiUrl: env['GITHUB_API_URL'] ?? DEFAULT_API_URL,
    });
  }

  /** GET /repos/{owner}/{repo}/pulls/{prNumber} */
  async getPr(prNumber: number): Promise<PrApiData> {
    return this.requestJson<PrApiData>(
      'GET',
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
    );
  }

  /** POST /repos/{owner}/{repo}/pulls/{prNumber}/reviews */
  async submitReview(prNumber: number, payload: GitHubReviewPayload): Promise<SubmitReviewResult> {
    return this.requestJson<SubmitReviewResult>(
      'POST',
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`,
      payload,
    );
  }

  /**
   * GET /repos/{owner}/{repo}/issues/{prNumber}/comments — list all PR-level
   * (issue) comments. Paginates through all pages (capped at 2000 comments) so
   * the caller can search for a hidden state comment anywhere in the thread.
   */
  async listIssueComments(prNumber: number): Promise<IssueComment[]> {
    const all: IssueComment[] = [];
    let page = 1;
    const perPage = 100;
    // Cap at 20 pages (2000 comments) to bound API usage.
    while (page <= 20) {
      const batch = await this.requestJson<IssueComment[]>(
        'GET',
        `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }
    return all;
  }

  /** POST /repos/{owner}/{repo}/issues/{prNumber}/comments */
  async createIssueComment(prNumber: number, body: string): Promise<IssueCommentResult> {
    return this.requestJson<IssueCommentResult>(
      'POST',
      `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`,
      { body },
    );
  }

  /** PATCH /repos/{owner}/{repo}/issues/comments/{commentId} */
  async updateIssueComment(commentId: number, body: string): Promise<IssueCommentResult> {
    return this.requestJson<IssueCommentResult>(
      'PATCH',
      `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`,
      { body },
    );
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API ${method} ${path} failed with ${response.status}`,
        response.status,
        text,
      );
    }

    return JSON.parse(text) as T;
  }
}
