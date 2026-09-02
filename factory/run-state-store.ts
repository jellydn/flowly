/**
 * Trusted factory-run persistence on the source GitHub issue. The snapshot
 * lives in a hidden HTML comment so Actions retries (new runners) reuse the
 * same run instead of a disk path that checkout wipes.
 */

import type { IssueComment, IssueCommentResult } from '../github/client.ts';
import { parseFactoryRun } from './schema.ts';
import { assertRunVersion, type FactoryRunStore } from './store.ts';
import type { FactoryRun } from './types.ts';

const STATE_MARKER = 'flue-factory-run';

export type FactoryRunCommentClient = {
  owner: string;
  repo: string;
  listIssueComments(issueNumber: number): Promise<IssueComment[]>;
  listRepositoryIssueComments?(): Promise<IssueComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<IssueCommentResult>;
  updateIssueComment(commentId: number, body: string): Promise<IssueCommentResult>;
};

export function encodeFactoryRunComment(run: FactoryRun): string {
  return `<!-- ${STATE_MARKER}\n${JSON.stringify(run)}\n-->\n\n_Flue factory run (automated; do not edit)._`;
}

export function isFactoryRunComment(body: string): boolean {
  return body.startsWith(`<!-- ${STATE_MARKER}\n`);
}

export function parseFactoryRunComment(body: string): FactoryRun | null {
  if (!isFactoryRunComment(body)) return null;
  const commentEnd = body.indexOf('\n-->');
  if (commentEnd < 0) return null;
  const snapshot = body.slice(`<!-- ${STATE_MARKER}\n`.length, commentEnd);
  try {
    return parseFactoryRun(JSON.parse(snapshot));
  } catch {
    return null;
  }
}

function isBotComment(comment: IssueComment, expectedBotLogin: string): boolean {
  return comment.user?.login === expectedBotLogin;
}

/**
 * Issue-comment store for one factory issue. Duplicate deliveries load the
 * oldest bot-authored snapshot so a second comment cannot steal the run.
 */
export function createGitHubFactoryRunStore(
  client: FactoryRunCommentClient,
  issueNumber: number,
  expectedBotLogin = 'github-actions[bot]',
): FactoryRunStore {
  const expectedRepository = `${client.owner}/${client.repo}`;
  let stateCommentId: number | null | undefined;

  async function findStateRun(): Promise<FactoryRun | null> {
    const comments = (await client.listIssueComments(issueNumber)).toSorted(
      (left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id,
    );
    for (const comment of comments) {
      if (!isFactoryRunComment(comment.body) || !isBotComment(comment, expectedBotLogin)) continue;
      const run = parseFactoryRunComment(comment.body);
      if (!run) continue;
      try {
        assertIssue(run);
      } catch {
        continue;
      }
      stateCommentId = comment.id;
      return run;
    }
    stateCommentId = null;
    return null;
  }

  async function loadFromIssue(): Promise<FactoryRun | null> {
    return findStateRun();
  }

  function assertIssue(run: FactoryRun): void {
    if (run.task.issueNumber !== issueNumber) {
      throw new Error(
        `Factory run ${run.id} is for issue #${run.task.issueNumber}, not #${issueNumber}.`,
      );
    }
    if (run.task.repository !== expectedRepository) {
      throw new Error(
        `Factory run ${run.id} targets ${run.task.repository}, not ${expectedRepository}.`,
      );
    }
  }

  return {
    async load(id: string): Promise<FactoryRun | null> {
      const run = await loadFromIssue();
      return run?.id === id ? run : null;
    },

    async findByIssue(repository: string, number: number): Promise<FactoryRun | null> {
      if (number !== issueNumber || repository !== expectedRepository) return null;
      return loadFromIssue();
    },

    async listByRepository(repository: string): Promise<FactoryRun[]> {
      if (repository !== expectedRepository) return [];
      if (!client.listRepositoryIssueComments) {
        const run = await loadFromIssue();
        return run ? [run] : [];
      }
      const runs = new Map<string, FactoryRun>();
      for (const comment of await client.listRepositoryIssueComments()) {
        if (!isBotComment(comment, expectedBotLogin)) continue;
        const run = parseFactoryRunComment(comment.body);
        if (run?.task.repository === expectedRepository) runs.set(run.id, run);
      }
      return [...runs.values()];
    },

    async createOrGet(run: FactoryRun): Promise<{ run: FactoryRun; created: boolean }> {
      assertIssue(run);
      const existing = await loadFromIssue();
      if (existing) return { run: existing, created: false };
      const created = await client.createIssueComment(issueNumber, encodeFactoryRunComment(run));
      stateCommentId = created.id;
      return { run: structuredClone(run), created: true };
    },

    async save(run: FactoryRun, expectedVersion: number): Promise<void> {
      assertIssue(run);
      const current = await loadFromIssue();
      assertRunVersion(run, expectedVersion, current?.version ?? 0);
      if (current && current.id !== run.id) {
        throw new Error(`Factory run ${run.id} does not own issue #${issueNumber}.`);
      }
      const body = encodeFactoryRunComment(run);
      if (stateCommentId === undefined) await findStateRun();
      if (stateCommentId !== null && stateCommentId !== undefined) {
        await client.updateIssueComment(stateCommentId, body);
        return;
      }
      const created = await client.createIssueComment(issueNumber, body);
      stateCommentId = created.id;
    },
  };
}
