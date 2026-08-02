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
      throw new Error(
        'GITHUB_REPOSITORY must be set to "owner/repo" for the PR reviewer.',
      );
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
  async submitReview(
    prNumber: number,
    payload: GitHubReviewPayload,
  ): Promise<SubmitReviewResult> {
    return this.requestJson<SubmitReviewResult>(
      'POST',
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`,
      payload,
    );
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
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
