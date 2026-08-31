import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  createGitHubFactoryRunStore,
  encodeFactoryRunComment,
} from '../factory/run-state-store.ts';
import { FileFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun } from '../factory/types.ts';
import type { IssueComment } from '../github/client.ts';

const task = {
  issueNumber: 94,
  title: 'Add factory pipeline',
  body: 'Implement it.',
  repository: 'jellydn/flowly',
};

describe('FileFactoryRunStore', () => {
  test('round-trips a run across process-style store instances', async () => {
    await withStore(async (directory) => {
      const first = new FileFactoryRunStore(directory);
      const created = await first.createOrGet(queuedRun('run-1'));
      assert.equal(created.created, true);

      const classified: FactoryRun = {
        ...created.run,
        state: 'classified',
        version: 2,
        classification: {
          actionable: true,
          type: 'feature',
          priority: 'high',
          complexity: 'large',
          missingInformation: [],
        },
        updatedAt: created.run.updatedAt + 1,
      };
      await first.save(classified, 1);

      const second = new FileFactoryRunStore(directory);
      const loaded = await second.load('run-1');
      assert.equal(loaded?.state, 'classified');
      assert.equal(loaded?.version, 2);
      assert.equal((await second.findByIssue(task.repository, task.issueNumber))?.id, 'run-1');
    });
  });

  test('reuses one run per issue instead of creating a duplicate', async () => {
    await withStore(async (directory) => {
      const store = new FileFactoryRunStore(directory);
      const first = await store.createOrGet(queuedRun('run-1'));
      const duplicate = await store.createOrGet(queuedRun('run-2'));
      assert.equal(first.created, true);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.run.id, 'run-1');
    });
  });

  test('rejects stale version writes and malformed snapshots', async () => {
    await withStore(async (directory) => {
      const store = new FileFactoryRunStore(directory);
      const { run } = await store.createOrGet(queuedRun('run-1'));
      await assert.rejects(
        () => store.save({ ...run, state: 'classified', version: 2, updatedAt: Date.now() }, 0),
        /expected version 0, found 1/,
      );
      await writeFile(
        path.join(directory, encodeURIComponent('jellydn/flowly:94') + '.json'),
        JSON.stringify({ id: 'run-1', state: 'queued', version: 1 }),
      );
      await assert.rejects(() => store.findByIssue(task.repository, 94), /Invalid type|Expected/i);
    });
  });

  test('serializes parallel saves for one issue', async () => {
    await withStore(async (directory) => {
      const store = new FileFactoryRunStore(directory);
      const { run } = await store.createOrGet(queuedRun('run-1'));
      const first = { ...run, version: 2, updatedAt: run.updatedAt + 1 };
      const second = { ...run, version: 2, updatedAt: run.updatedAt + 2 };

      const results = await Promise.allSettled([store.save(first, 1), store.save(second, 1)]);

      assert.deepEqual(results.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
      assert.equal((await store.load(run.id))?.version, 2);
    });
  });
});

describe('GitHub factory run store', () => {
  test('creates one issue comment and reuses it across store instances', async () => {
    const client = fakeCommentClient();
    const first = createGitHubFactoryRunStore(client, 94);
    const created = await first.createOrGet(queuedRun('run-1'));
    assert.equal(created.created, true);
    assert.equal(client.created.length, 1);
    assert.match(client.created[0] ?? '', /flue-factory-run/);

    const second = createGitHubFactoryRunStore(client, 94);
    const duplicate = await second.createOrGet(queuedRun('run-2'));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.id, 'run-1');
    assert.equal(client.created.length, 1);
  });

  test('saves with compare-and-swap and ignores spoofed comments', async () => {
    const client = fakeCommentClient([
      {
        id: 1,
        body: encodeFactoryRunComment(queuedRun('spoofed')),
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        user: { login: 'attacker' },
      },
    ]);
    const store = createGitHubFactoryRunStore(client, 94);
    const created = await store.createOrGet(queuedRun('run-1'));
    assert.equal(created.created, true);
    const next: FactoryRun = {
      ...created.run,
      state: 'classified',
      version: 2,
      classification: {
        actionable: true,
        type: 'feature',
        priority: 'medium',
        complexity: 'small',
        missingInformation: [],
      },
      updatedAt: created.run.updatedAt + 1,
    };
    await store.save(next, 1);
    assert.equal((await store.load('run-1'))?.state, 'classified');
    await assert.rejects(
      () => store.save({ ...next, version: 3, updatedAt: Date.now() }, 1),
      /expected version 1, found 2/,
    );
  });

  test('skips malformed and mismatched bot snapshots', async () => {
    const malformed = '<!-- flue-factory-run\nnot-json\n-->';
    const wrongIssue = encodeFactoryRunComment({
      ...queuedRun('wrong-issue'),
      task: { ...task, issueNumber: 95 },
    });
    const oldestValid = encodeFactoryRunComment(queuedRun('run-1'));
    const newerValid = encodeFactoryRunComment(queuedRun('run-2'));
    const client = fakeCommentClient([
      botComment(1, malformed),
      botComment(2, wrongIssue),
      botComment(4, newerValid, '2026-01-02T00:00:00Z'),
      botComment(3, oldestValid, '2026-01-01T00:00:00Z'),
    ]);

    const store = createGitHubFactoryRunStore(client, 94);

    assert.equal((await store.findByIssue(task.repository, 94))?.id, 'run-1');
  });

  test('enumerates bot-authored persisted outcomes across the repository', async () => {
    const previous = { ...queuedRun('run-93'), task: { ...task, issueNumber: 93 } };
    const current = queuedRun('run-94');
    const client = fakeCommentClient(
      [botComment(2, encodeFactoryRunComment(current))],
      [
        botComment(1, encodeFactoryRunComment(previous)),
        botComment(2, encodeFactoryRunComment(current)),
        {
          ...botComment(3, encodeFactoryRunComment(queuedRun('spoofed'))),
          user: { login: 'attacker' },
        },
      ],
    );
    const store = createGitHubFactoryRunStore(client, 94);

    assert.deepEqual((await store.listByRepository(task.repository)).map((run) => run.id).sort(), [
      'run-93',
      'run-94',
    ]);
  });
});

function queuedRun(id: string): FactoryRun {
  return {
    id,
    task,
    state: 'queued',
    version: 1,
    updatedAt: 1_700_000_000_000,
  };
}

async function withStore(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowly-factory-runs-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function fakeCommentClient(
  seed: IssueComment[] = [],
  repositorySeed: IssueComment[] = seed,
): FactoryRunCommentClientFake {
  const comments = [...seed];
  let nextId = 1000;
  const created: string[] = [];
  return {
    owner: 'jellydn',
    repo: 'flowly',
    created,
    async listIssueComments() {
      return comments;
    },
    async listRepositoryIssueComments() {
      return repositorySeed;
    },
    async createIssueComment(_issueNumber, body) {
      created.push(body);
      const id = nextId++;
      comments.push({
        id,
        body,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        user: { login: 'github-actions[bot]' },
      });
      return { id, html_url: `https://github.com/jellydn/flowly/issues/94#issuecomment-${id}` };
    },
    async updateIssueComment(commentId, body) {
      const index = comments.findIndex((comment) => comment.id === commentId);
      if (index >= 0) comments[index] = { ...comments[index], body };
      return {
        id: commentId,
        html_url: `https://github.com/jellydn/flowly/issues/94#issuecomment-${commentId}`,
      };
    },
  };
}

function botComment(id: number, body: string, createdAt = '2026-01-01T00:00:00Z'): IssueComment {
  return {
    id,
    body,
    created_at: createdAt,
    updated_at: createdAt,
    user: { login: 'github-actions[bot]' },
  };
}

type FactoryRunCommentClientFake = {
  owner: string;
  repo: string;
  created: string[];
  listIssueComments(issueNumber: number): Promise<IssueComment[]>;
  listRepositoryIssueComments(): Promise<IssueComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<{ id: number; html_url: string }>;
  updateIssueComment(commentId: number, body: string): Promise<{ id: number; html_url: string }>;
};
