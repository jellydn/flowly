import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import {
  FactoryDraftPrPublisher,
  type FactoryPullRequestClient,
  type FactoryPullRequestRecord,
  renderFactoryPrBody,
} from '../factory/publisher.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun } from '../factory/types.ts';

describe('FactoryDraftPrPublisher', () => {
  test('creates one draft PR from structured review evidence', async () => {
    const run = await reviewedRun();
    const client = fakeClient();
    const publisher = new FactoryDraftPrPublisher(client);
    const created = await publisher.publish(run);

    assert.equal(created.draft, true);
    assert.equal(created.number, 110);
    assert.equal(created.head, 'factory/94-add-factory-pipeline');
    assert.equal(client.created.length, 1);
    assert.equal(client.created[0]?.head, 'factory/94-add-factory-pipeline');
    assert.equal(client.created[0]?.base, 'main');
    assert.match(client.created[0]?.title ?? '', /^\[factory\] Add factory pipeline$/);
    assert.match(client.created[0]?.body ?? '', /Closes #94/);
    assert.match(client.created[0]?.body ?? '', /\[x\] A run is persisted/);
    assert.match(client.created[0]?.body ?? '', /`npm test` → exit 0/);
    assert.match(client.created[0]?.body ?? '', /never auto-merges or auto-approves/);
    assert.equal(client.created[0]?.body.includes('workspaceId'), false);
    assert.equal('mergePullRequest' in publisher, false);
  });

  test('reuses an existing open draft for the same factory branch', async () => {
    const run = await reviewedRun();
    const existing = record({ number: 96, draft: true, state: 'open' });
    const client = fakeClient([existing]);
    const publisher = new FactoryDraftPrPublisher(client);
    const first = await publisher.publish(run);
    const second = await publisher.publish(run);

    assert.equal(first.number, 96);
    assert.equal(second.number, 96);
    assert.equal(client.created.length, 0);
  });

  test('opens a new draft when the only match is closed or merged', async () => {
    const run = await reviewedRun();
    const client = fakeClient([
      record({ number: 80, draft: true, state: 'closed' }),
      record({ number: 81, draft: false, state: 'closed' }),
    ]);
    const created = await new FactoryDraftPrPublisher(client).publish(run);

    assert.equal(created.number, 110);
    assert.equal(created.draft, true);
    assert.equal(client.created.length, 1);
  });

  test('refuses an open non-draft on the same factory branch', async () => {
    const run = await reviewedRun();
    const client = fakeClient([record({ number: 99, draft: false, state: 'open' })]);
    await assert.rejects(
      () => new FactoryDraftPrPublisher(client).publish(run),
      /refused a non-draft pull request/,
    );
    assert.equal(client.created.length, 0);
  });

  test('rejects unreviewed runs, foreign repos, and non-factory branches', async () => {
    const run = await reviewedRun();
    const publisher = new FactoryDraftPrPublisher(fakeClient());
    await assert.rejects(
      () => publisher.publish({ ...run, review: undefined }),
      /independently reviewed first/,
    );
    await assert.rejects(
      () => publisher.publish({ ...run, branch: 'main' }),
      /outside a factory-owned branch/,
    );
    await assert.rejects(
      () =>
        publisher.publish({
          ...run,
          task: { ...run.task, repository: 'other/repo' },
        }),
      /targets other\/repo/,
    );
  });

  test('refuses a GitHub response that is not a draft', async () => {
    const run = await reviewedRun();
    const client = fakeClient();
    client.createDraftPullRequest = async (input) => ({
      number: 111,
      htmlUrl: 'https://github.com/jellydn/flowly/pull/111',
      draft: false,
      state: 'open',
      head: input.head,
      base: input.base,
    });
    await assert.rejects(
      () => new FactoryDraftPrPublisher(client).publish(run),
      /refused a non-draft pull request/,
    );
  });
});

describe('renderFactoryPrBody', () => {
  test('includes the issue link, verification, and criterion checklist', async () => {
    const body = renderFactoryPrBody(await reviewedRun());
    assert.match(body, /Closes #94/);
    assert.match(body, /Ready for human review: yes/);
    assert.match(body, /factory\/orchestrator\.ts/);
    assert.match(body, /### Unresolved findings\n\n- none/);
  });
});

async function reviewedRun(): Promise<FactoryRun> {
  const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
  const { run } = await orchestrator.start({
    issueNumber: 94,
    title: 'Add factory pipeline',
    body: 'Implement it.',
    repository: 'jellydn/flowly',
  });
  await orchestrator.classify(run.id, {
    actionable: true,
    type: 'feature',
    priority: 'high',
    complexity: 'large',
    missingInformation: [],
  });
  await orchestrator.plan(run.id, {
    summary: 'Build foundation',
    steps: ['Add state'],
    acceptanceCriteria: [{ description: 'A run is persisted.' }],
    verificationCommands: ['npm test'],
  });
  await orchestrator.beginImplementation(run.id);
  await orchestrator.recordImplementation(run.id, {
    workspaceId: 'factory-run-94',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    changedFiles: ['factory/orchestrator.ts'],
    commands: [{ command: 'npm test', exitCode: 0 }],
  });
  await orchestrator.recordVerification(run.id, true);
  return orchestrator.recordReview(run.id, {
    readyForHumanReview: true,
    acceptanceCriteria: [
      {
        description: 'A run is persisted.',
        satisfied: true,
        evidence: 'orchestrator.ts records FactoryRun.',
      },
    ],
    summary: 'Ready for human review.',
    unresolvedFindings: [],
  });
}

function record(
  overrides: Partial<FactoryPullRequestRecord> & Pick<FactoryPullRequestRecord, 'number'>,
): FactoryPullRequestRecord {
  return {
    htmlUrl: `https://github.com/jellydn/flowly/pull/${overrides.number}`,
    draft: true,
    head: 'factory/94-add-factory-pipeline',
    base: 'main',
    state: 'open',
    ...overrides,
  };
}

function fakeClient(existing: FactoryPullRequestRecord[] = []): FactoryPullRequestClient & {
  created: Array<{ title: string; body: string; head: string; base: string }>;
} {
  const created: Array<{ title: string; body: string; head: string; base: string }> = [];
  return {
    owner: 'jellydn',
    repo: 'flowly',
    created,
    async findPullRequestsByHead() {
      return existing;
    },
    async createDraftPullRequest(input) {
      created.push(input);
      return record({
        number: 110,
        draft: true,
        state: 'open',
        head: input.head,
        base: input.base,
      });
    },
  };
}
