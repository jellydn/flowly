import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FactoryGitMutator, FactoryVerifier } from '../factory/implementation.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { FactoryDraftPrPublisher, type FactoryPullRequestClient } from '../factory/publisher.ts';
import { runFactoryPipeline, type FactoryPipelineDependencies } from '../factory/run.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryTask, ImplementationPlan, TaskClassification } from '../factory/types.ts';

const task: FactoryTask = {
  issueNumber: 94,
  title: 'Add factory pipeline',
  body: 'Implement it.',
  repository: 'jellydn/flowly',
};
const classification: TaskClassification = {
  actionable: true,
  type: 'feature',
  priority: 'high',
  complexity: 'large',
  missingInformation: [],
};
const plan: ImplementationPlan = {
  summary: 'Build the remaining factory stages.',
  steps: ['Plan', 'Implement', 'Review'],
  acceptanceCriteria: [{ description: 'A draft PR is created.' }],
  verificationCommands: ['npm test'],
};
const DIFF = [
  'diff --git a/factory/run.ts b/factory/run.ts',
  '--- a/factory/run.ts',
  '+++ b/factory/run.ts',
  '@@ -1,0 +1,1 @@',
  '+export async function runFactoryPipeline() {}',
].join('\n');
const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('runFactoryPipeline', () => {
  test('runs classify → plan → implement → review → draft PR without merging', async () => {
    const calls: string[] = [];
    const dependencies = pipelineDependencies(calls);

    const result = await runFactoryPipeline(task, dependencies);

    assert.equal(result.state, 'completed');
    assert.equal(result.prNumber, 110);
    assert.equal(result.branch, 'factory/94-add-factory-pipeline');
    assert.deepEqual(result.plan, plan);
    assert.match(calls.join('\n'), /classify:/);
    assert.match(calls.join('\n'), /plan:/);
    assert.match(calls.join('\n'), /implement:/);
    assert.match(calls.join('\n'), /review:/);
    assert.match(calls.join('\n'), /create:/);
    assert.equal(
      calls.some((call) => call.startsWith('merge:') || call.startsWith('approve:')),
      false,
    );
  });

  test('stops non-actionable issues before planning or implementation', async () => {
    const calls: string[] = [];
    const dependencies = pipelineDependencies(calls, {
      actionable: false,
      missingInformation: ['Describe the expected behavior.'],
    });

    const result = await runFactoryPipeline(task, dependencies);

    assert.equal(result.state, 'needs-input');
    assert.equal(result.plan, undefined);
    assert.equal(result.prNumber, undefined);
    assert.equal(
      calls.some((call) => call.startsWith('plan:')),
      false,
    );
    assert.equal(
      calls.some((call) => call.startsWith('implement:')),
      false,
    );
    assert.equal(
      calls.some((call) => call.startsWith('create:')),
      false,
    );
  });

  test('does not re-classify or re-plan duplicate deliveries of a completed run', async () => {
    const calls: string[] = [];
    const dependencies = pipelineDependencies(calls);

    const first = await runFactoryPipeline(task, dependencies);
    const second = await runFactoryPipeline(task, dependencies);

    assert.equal(first.id, second.id);
    assert.equal(second.state, 'completed');
    assert.equal(calls.filter((call) => call.startsWith('classify:')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith('plan:')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith('create:')).length, 1);
  });

  test('failed verification completes as failed and never opens a PR', async () => {
    const calls: string[] = [];
    const dependencies = pipelineDependencies(calls);
    dependencies.verifier = {
      async run(commands) {
        return commands.map((command) => ({
          command,
          exitCode: 1,
          stdout: '',
          stderr: 'boom',
          durationMs: 1,
          timedOut: false,
        }));
      },
    };

    const result = await runFactoryPipeline(task, dependencies);

    assert.equal(result.state, 'failed');
    assert.equal(result.prNumber, undefined);
    assert.equal(
      calls.some((call) => call.startsWith('create:')),
      false,
    );
    assert.equal(
      calls.some((call) => call.startsWith('push:')),
      false,
    );
  });
});

function pipelineDependencies(
  calls: string[],
  classify: Partial<TaskClassification> = {},
): FactoryPipelineDependencies {
  const client = fakeClient(calls);
  return {
    orchestrator: new FactoryOrchestrator(new MemoryFactoryRunStore()),
    classifier: {
      async classify() {
        calls.push('classify:');
        return { ...classification, ...classify };
      },
    },
    planner: {
      async plan() {
        calls.push('plan:');
        return plan;
      },
    },
    progress: {
      async publish(_task, body) {
        calls.push(`progress:${body.split('\n')[0]}`);
      },
    },
    git: fakeGit(calls),
    implementer: {
      async implement({ workspace }) {
        calls.push(`implement:${workspace.path}`);
      },
    },
    verifier: fakeVerifier(calls),
    reviewer: {
      async review(evidence) {
        calls.push(`review:${evidence.branch}`);
        return {
          summary: 'Acceptance criteria hold against the diff.',
          verdict: 'COMMENT',
          findings: [],
        };
      },
    },
    publisher: new FactoryDraftPrPublisher(client),
    readDiff: async (current) => {
      calls.push(`diff:${current.branch}`);
      return DIFF;
    },
    judgmentsFrom: (evidence) =>
      evidence.acceptanceCriteria.map((criterion) => ({
        description: criterion.description,
        satisfied: true,
        evidence: `${criterion.description} is present in the diff.`,
      })),
  };
}

function fakeGit(calls: string[]): FactoryGitMutator {
  return {
    async createWorkspace(id, branch, baseRef) {
      calls.push(`workspace:${id}:${branch}`);
      return { id, branch, baseRef: baseRef ?? 'origin/main', path: '/workspace' };
    },
    async commit(_workspace, message) {
      calls.push(`commit:${message}`);
      return { commitSha: COMMIT, changedFiles: ['factory/run.ts'] };
    },
    async push(_workspace, commitSha) {
      calls.push(`push:${commitSha}`);
    },
    async isPristine() {
      return true;
    },
  };
}

function fakeVerifier(calls: string[]): FactoryVerifier {
  return {
    async run(commands, workspacePath) {
      calls.push(`verify:${workspacePath}`);
      return commands.map((command) => ({
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      }));
    },
  };
}

function fakeClient(calls: string[]): FactoryPullRequestClient {
  const existing: Array<{
    number: number;
    htmlUrl: string;
    draft: boolean;
    state: 'open' | 'closed';
    head: string;
    base: string;
  }> = [];
  return {
    owner: 'jellydn',
    repo: 'flowly',
    async findPullRequestsByHead(head) {
      calls.push(`find:${head}`);
      return existing.filter((pullRequest) => pullRequest.head === head);
    },
    async createDraftPullRequest(input) {
      calls.push(`create:${input.head}`);
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
  };
}
