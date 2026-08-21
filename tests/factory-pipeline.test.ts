import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { runIndependentReviewAndPublish } from '../factory/pipeline.ts';
import {
  FactoryDraftPrPublisher,
  type FactoryPullRequestClient,
  type FactoryPullRequestRecord,
} from '../factory/publisher.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun } from '../factory/types.ts';

const DIFF = [
  'diff --git a/factory/orchestrator.ts b/factory/orchestrator.ts',
  '--- a/factory/orchestrator.ts',
  '+++ b/factory/orchestrator.ts',
  '@@ -1,0 +1,1 @@',
  '+export class FactoryOrchestrator {}',
].join('\n');

describe('runIndependentReviewAndPublish', () => {
  test('reviews isolated evidence, opens a draft PR, and completes the run', async () => {
    const { orchestrator, run } = await verifyingRun();
    const calls: string[] = [];
    const client = fakeClient(calls);

    const result = await runIndependentReviewAndPublish(run, {
      orchestrator,
      publisher: new FactoryDraftPrPublisher(client),
      readDiff: async (current) => {
        calls.push(`diff:${current.branch}`);
        return DIFF;
      },
      reviewer: {
        async review(evidence) {
          calls.push(`review:${JSON.stringify(evidence)}`);
          return {
            summary: 'Acceptance criteria hold against the diff.',
            verdict: 'COMMENT',
            findings: [],
          };
        },
      },
      judgmentsFrom: (evidence) =>
        evidence.acceptanceCriteria.map((criterion) => ({
          description: criterion.description,
          satisfied: true,
          evidence: `${criterion.description} is present in the diff.`,
        })),
      progress: {
        async publish(_task, body) {
          calls.push(`progress:${body}`);
        },
      },
    });

    assert.equal(result.state, 'completed');
    assert.equal(result.prNumber, 110);
    assert.equal(result.review?.readyForHumanReview, true);
    assert.equal(result.review?.acceptanceCriteria[0]?.satisfied, true);
    assert.equal(
      calls.some((call) => call.includes('IMPLEMENTER_SCRATCH_TOKEN')),
      false,
    );
    assert.match(calls.find((call) => call.startsWith('progress:Factory draft PR')) ?? '', /#110/);
    assert.equal(client.created.length, 1);
    assert.equal(client.created[0]?.head.startsWith('factory/'), true);
  });

  test('does not publish a PR when independent review fails', async () => {
    const { orchestrator, run } = await verifyingRun();
    const client = fakeClient([]);
    await assert.rejects(
      () =>
        runIndependentReviewAndPublish(run, {
          orchestrator,
          publisher: new FactoryDraftPrPublisher(client),
          readDiff: async () => DIFF,
          reviewer: {
            async review() {
              throw new Error('Reviewer unavailable.');
            },
          },
          judgmentsFrom: () => [],
        }),
      /Reviewer unavailable/,
    );
    assert.equal(client.created.length, 0);
  });

  test('completes an already published run without opening another PR', async () => {
    const { orchestrator, run } = await verifyingRun();
    const client = fakeClient([]);
    const dependencies = {
      orchestrator,
      publisher: new FactoryDraftPrPublisher(client),
      readDiff: async () => DIFF,
      reviewer: {
        async review() {
          return {
            summary: 'Ready for human review.',
            verdict: 'COMMENT' as const,
            findings: [],
          };
        },
      },
      judgmentsFrom: () => [
        {
          description: 'A run is persisted.',
          satisfied: true,
          evidence: 'FactoryRun exists.',
        },
      ],
    };

    const first = await runIndependentReviewAndPublish(run, dependencies);
    const second = await runIndependentReviewAndPublish(first, dependencies);
    assert.equal(first.state, 'completed');
    assert.equal(second.state, 'completed');
    assert.equal(second.prNumber, first.prNumber);
    assert.equal(client.created.length, 1);
  });
});

async function verifyingRun(): Promise<{
  orchestrator: FactoryOrchestrator;
  run: FactoryRun;
}> {
  const store = new MemoryFactoryRunStore();
  const orchestrator = new FactoryOrchestrator(store);
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
  const reviewing = await orchestrator.recordVerification(run.id, true);
  return { orchestrator, run: reviewing };
}

function fakeClient(calls: string[]): FactoryPullRequestClient & {
  created: Array<{ title: string; body: string; head: string; base: string }>;
} {
  const created: Array<{ title: string; body: string; head: string; base: string }> = [];
  const existing: FactoryPullRequestRecord[] = [];
  return {
    owner: 'jellydn',
    repo: 'flowly',
    created,
    async findPullRequestsByHead(head) {
      calls.push(`find:${head}`);
      return existing.filter((pullRequest) => pullRequest.head === head);
    },
    async createDraftPullRequest(input) {
      calls.push(`create:${input.head}`);
      created.push(input);
      const record: FactoryPullRequestRecord = {
        number: 110,
        htmlUrl: 'https://github.com/jellydn/flowly/pull/110',
        draft: true,
        head: input.head,
        base: input.base,
      };
      existing.push(record);
      return record;
    },
  };
}
