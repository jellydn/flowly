/**
 * Trusted draft-PR publisher for factory runs. It posts structured issue,
 * verification, and independent-review data — never implementer scratch —
 * and it cannot approve or merge.
 */

import type { GitHubClient, GitHubPullRequest } from '../github/client.ts';
import { assertFactoryBranch } from './git.ts';
import type { FactoryRun } from './types.ts';

export type FactoryPullRequestRecord = {
  number: number;
  htmlUrl: string;
  draft: boolean;
  head: string;
  base: string;
  /** GitHub issue-state. Closed/merged PRs must not be reused. */
  state: 'open' | 'closed';
};

export type FactoryPullRequestClient = {
  owner: string;
  repo: string;
  createDraftPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<FactoryPullRequestRecord>;
  findPullRequestsByHead(head: string): Promise<FactoryPullRequestRecord[]>;
};

export type FactoryDraftPrPublisherOptions = {
  baseBranch?: string;
};

/** Map the GitHub REST client onto the factory publisher's record shape. */
export function createGitHubFactoryPullRequestClient(
  client: GitHubClient,
): FactoryPullRequestClient {
  return {
    owner: client.owner,
    repo: client.repo,
    async createDraftPullRequest(input) {
      return toRecord(await client.createDraftPullRequest(input));
    },
    async findPullRequestsByHead(head) {
      return (await client.findPullRequestsByHead(head)).map(toRecord);
    },
  };
}

/**
 * Creates or reuses one draft PR for a reviewed factory run. Duplicate
 * deliveries for the same factory branch return the existing PR.
 */
export class FactoryDraftPrPublisher {
  constructor(
    private readonly client: FactoryPullRequestClient,
    private readonly options: FactoryDraftPrPublisherOptions = {},
  ) {}

  async publish(run: FactoryRun): Promise<FactoryPullRequestRecord> {
    if (!run.review) {
      throw new Error(`Factory run ${run.id} must be independently reviewed first.`);
    }
    if (!run.branch) throw new Error(`Factory run ${run.id} has no factory-owned branch.`);
    assertFactoryBranch(run.branch);
    const expectedRepository = `${this.client.owner}/${this.client.repo}`;
    if (run.task.repository !== expectedRepository) {
      throw new Error(
        `Factory run ${run.id} targets ${run.task.repository}, not ${expectedRepository}.`,
      );
    }

    const existing = (await this.client.findPullRequestsByHead(run.branch))
      .slice()
      .sort((left, right) => left.number - right.number);
    const reusable = existing.filter((pullRequest) => isReusableDraft(pullRequest));
    const openNonDraft = existing.find(
      (pullRequest) => pullRequest.state === 'open' && !pullRequest.draft,
    );
    if (openNonDraft) {
      throw new Error('Factory publisher refused a non-draft pull request.');
    }
    if (reusable[0]) return reusable[0];

    const created = await this.client.createDraftPullRequest({
      title: `[factory] ${run.task.title}`,
      body: renderFactoryPrBody(run),
      head: run.branch,
      base: this.options.baseBranch ?? 'main',
    });
    if (!isReusableDraft(created)) {
      throw new Error('Factory publisher refused a non-draft pull request.');
    }
    return created;
  }
}

/** Render the human-facing draft PR body from persisted factory state. */
export function renderFactoryPrBody(run: FactoryRun): string {
  if (!run.review || !run.implementation || !run.plan) {
    throw new Error(`Factory run ${run.id} is missing review, implementation, or plan data.`);
  }

  const criteria = run.review.acceptanceCriteria
    .map((criterion) => {
      const mark = criterion.satisfied ? 'x' : ' ';
      return `- [${mark}] ${criterion.description} — ${criterion.evidence}`;
    })
    .join('\n');
  const commands = run.implementation.commands
    .map((command) => `- \`${command.command}\` → exit ${command.exitCode}`)
    .join('\n');
  const findings =
    run.review.unresolvedFindings.length === 0
      ? '- none'
      : run.review.unresolvedFindings.map((finding) => `- ${finding}`).join('\n');
  const files = run.implementation.changedFiles.map((file) => `- ${file}`).join('\n');

  return [
    `Closes #${run.task.issueNumber}`,
    '',
    '## Implementation summary',
    '',
    run.plan.summary,
    '',
    'Changed files:',
    files || '- none',
    '',
    '## Acceptance criteria',
    '',
    criteria || '- none',
    '',
    '## Verification',
    '',
    commands || '- none',
    '',
    '## Independent review',
    '',
    `Ready for human review: ${run.review.readyForHumanReview ? 'yes' : 'no'}`,
    '',
    run.review.summary,
    '',
    '### Unresolved findings',
    '',
    findings,
    '',
    '---',
    "This is a **draft** pull request created by Flowly's software factory.",
    'Flowly never auto-merges or auto-approves its own implementation.',
  ].join('\n');
}

function isReusableDraft(pullRequest: FactoryPullRequestRecord): boolean {
  return pullRequest.state === 'open' && pullRequest.draft;
}

function toRecord(pullRequest: GitHubPullRequest): FactoryPullRequestRecord {
  return {
    number: pullRequest.number,
    htmlUrl: pullRequest.html_url,
    draft: pullRequest.draft,
    head: pullRequest.head.ref,
    base: pullRequest.base.ref,
    state: pullRequest.state,
  };
}
