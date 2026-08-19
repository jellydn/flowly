import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FactoryGitMutator } from '../factory/implementation.ts';
import { runControlledImplementation } from '../factory/implementation.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun } from '../factory/types.ts';
import type { FactoryVerifier } from '../factory/implementation.ts';

const task = {
  issueNumber: 94,
  title: 'Controlled implementation',
  body: 'Implement in an isolated workspace.',
  repository: 'jellydn/flowly',
};
const classification = {
  actionable: true,
  type: 'feature' as const,
  priority: 'high' as const,
  complexity: 'large' as const,
  missingInformation: [],
};
const plan = {
  summary: 'Implement safely',
  steps: ['Change the code'],
  acceptanceCriteria: [{ description: 'Checks pass.' }],
  verificationCommands: ['npm test', 'npm run typecheck'],
};

describe('runControlledImplementation', () => {
  test('implements, verifies, pushes, and persists only structured outcomes', async () => {
    const { orchestrator, run } = await plannedRun();
    const calls: string[] = [];
    const git = fakeGit(calls);
    const verifier: FactoryVerifier = {
      async run(commands, workspacePath) {
        calls.push(`verify:${workspacePath}`);
        return commands.map((command) => commandResult(command, 0));
      },
    };

    const result = await runControlledImplementation(run, {
      orchestrator,
      git,
      verifier,
      implementer: {
        async implement({ workspace }) {
          calls.push(`implement:${workspace.path}`);
        },
      },
    });

    assert.equal(result.state, 'reviewing');
    assert.deepEqual(result.implementation, {
      workspaceId: run.id,
      commitSha: 'abc123',
      changedFiles: ['factory/implementation.ts'],
      commands: [
        { command: 'npm test', exitCode: 0 },
        { command: 'npm run typecheck', exitCode: 0 },
      ],
    });
    assert.deepEqual(calls, [
      `workspace:${run.id}:factory/94-controlled-implementation`,
      '/workspace',
      'implement:/workspace',
      'commit:Implement issue #94',
      'verify:/workspace',
      'clean',
      'push',
    ]);
  });

  test('records failed verification and does not enter review', async () => {
    const { orchestrator, run } = await plannedRun();
    const calls: string[] = [];
    const git = fakeGit(calls);

    const result = await runControlledImplementation(run, {
      orchestrator,
      git,
      implementer: { async implement() {} },
      verifier: {
        async run() {
          return [commandResult('npm test', 2)];
        },
      },
    });

    assert.equal(result.state, 'failed');
    assert.equal(result.failure, 'Verification command failed with exit code 2: npm test');
    assert.deepEqual(result.implementation?.commands, [{ command: 'npm test', exitCode: 2 }]);
    assert.equal(calls.includes('push'), false);
  });

  test('fails verification when checks leave uncommitted changes', async () => {
    const { orchestrator, run } = await plannedRun();
    const calls: string[] = [];
    const git = fakeGit(calls);
    git.isClean = async () => false;

    const result = await runControlledImplementation(run, {
      orchestrator,
      git,
      implementer: { async implement() {} },
      verifier: {
        async run() {
          return [commandResult('npm test', 0)];
        },
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.failure ?? '', /modified the implementation after it was committed/);
    assert.equal(calls.includes('push'), false);
  });
});

async function plannedRun(): Promise<{ orchestrator: FactoryOrchestrator; run: FactoryRun }> {
  const orchestrator = new FactoryOrchestrator(new MemoryFactoryRunStore());
  const { run } = await orchestrator.start(task);
  await orchestrator.classify(run.id, classification);
  const planned = await orchestrator.plan(run.id, plan);
  return { orchestrator, run: planned };
}

function fakeGit(calls: string[]): FactoryGitMutator {
  return {
    async createWorkspace(id, branch, baseRef) {
      calls.push(`workspace:${id}:${branch}`, baseRef ?? '/workspace');
      return { id, branch, baseRef: baseRef ?? 'origin/main', path: '/workspace' };
    },
    async commit(_workspace, message) {
      calls.push(`commit:${message}`);
      return { commitSha: 'abc123', changedFiles: ['factory/implementation.ts'] };
    },
    async push() {
      calls.push('push');
    },
    async isClean() {
      calls.push('clean');
      return true;
    },
  };
}

function commandResult(command: string, exitCode: number) {
  return { command, exitCode, stdout: '', stderr: '', durationMs: 1, timedOut: false };
}
