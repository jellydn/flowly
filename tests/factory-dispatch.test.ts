import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dispatchFactoryLabeledIssue, factoryTaskFromIssuesEvent } from '../factory/dispatch.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { FactoryDraftPrPublisher } from '../factory/publisher.ts';
import type { FactoryPipelineDependencies } from '../factory/run.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';

describe('factoryTaskFromIssuesEvent', () => {
  test('builds a factory task from a factory-labeled issue', () => {
    const task = factoryTaskFromIssuesEvent('issues', labeledPayload());
    assert.deepEqual(task, {
      issueNumber: 94,
      title: 'Add factory pipeline',
      body: 'Implement the remaining stages.',
      repository: 'jellydn/flowly',
    });
  });

  test('rejects events that are not issues.labeled with factory', () => {
    assert.throws(
      () => factoryTaskFromIssuesEvent('pull_request', labeledPayload()),
      /expected issues.labeled, received pull_request/,
    );
    const unlabeled = labeledPayload();
    unlabeled.issue.labels = [];
    unlabeled.label = { name: 'bug' };
    assert.throws(
      () => factoryTaskFromIssuesEvent('issues', unlabeled),
      /requires the factory label/,
    );
  });
});

describe('dispatchFactoryLabeledIssue', () => {
  test('runs the factory pipeline for a labeled issue', async () => {
    const result = await dispatchFactoryLabeledIssue(
      'issues',
      labeledPayload(),
      pipelineDependencies(),
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.task.issueNumber, 94);
    assert.equal(result.prNumber, 110);
  });
});

function labeledPayload() {
  return {
    action: 'labeled',
    label: { name: 'factory' },
    issue: {
      number: 94,
      title: 'Add factory pipeline',
      body: 'Implement the remaining stages.',
      labels: [{ name: 'factory' }, { name: 'enhancement' }],
    },
    repository: { full_name: 'jellydn/flowly' },
    sender: { login: 'jellydn' },
  };
}

function pipelineDependencies(): FactoryPipelineDependencies {
  const existing: Array<{
    number: number;
    htmlUrl: string;
    draft: boolean;
    state: 'open' | 'closed';
    head: string;
    base: string;
  }> = [];
  return {
    orchestrator: new FactoryOrchestrator(new MemoryFactoryRunStore()),
    autonomyPolicy: {
      version: 'dispatch-test-v1',
      promotionEnabled: false,
      defaultLevel: 'publish-draft-pr',
      maximumLevel: 'publish-draft-pr',
      minimumSamples: { implementAndVerify: 1, publishDraftPr: 1 },
      promotionThresholds: {
        verificationSuccessRate: 1,
        reviewReadyRate: 1,
        publicationSuccessRate: 1,
      },
      demotions: {},
    },
    classifier: {
      async classify() {
        return {
          actionable: true,
          type: 'feature',
          priority: 'high',
          complexity: 'large',
          missingInformation: [],
        };
      },
    },
    planner: {
      async plan() {
        return {
          summary: 'Ship it',
          steps: ['Do the work'],
          acceptanceCriteria: [{ description: 'A draft PR exists.' }],
          verificationCommands: ['npm test'],
        };
      },
    },
    progress: { async publish() {} },
    git: {
      async createWorkspace(id, branch, baseRef) {
        return { id, branch, baseRef: baseRef ?? 'origin/main', path: '/workspace' };
      },
      async commit() {
        return {
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          changedFiles: ['factory/dispatch.ts'],
        };
      },
      async push() {},
      async isPristine() {
        return true;
      },
    },
    implementer: { async implement() {} },
    verifier: {
      async run(commands) {
        return commands.map((command) => ({
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        }));
      },
    },
    reviewer: {
      async review() {
        return {
          summary: 'Ready for humans.',
          verdict: 'COMMENT',
          findings: [],
        };
      },
    },
    publisher: new FactoryDraftPrPublisher({
      owner: 'jellydn',
      repo: 'flowly',
      async findPullRequestsByHead(head) {
        return existing.filter((pullRequest) => pullRequest.head === head);
      },
      async createDraftPullRequest(input) {
        const record = {
          number: 110,
          htmlUrl: 'https://github.com/jellydn/flowly/pull/110',
          draft: true,
          state: 'open' as const,
          head: input.head,
          base: input.base,
        };
        existing.push(record);
        return record;
      },
    }),
    readDiff: async () => 'diff --git a/factory/dispatch.ts b/factory/dispatch.ts\n',
    judgmentsFrom: (evidence) =>
      evidence.acceptanceCriteria.map((criterion) => ({
        description: criterion.description,
        satisfied: true,
        evidence: 'Present in the isolated diff.',
      })),
  };
}
