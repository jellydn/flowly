import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FactoryGitMutator } from '../factory/implementation.ts';
import { runControlledImplementation } from '../factory/implementation.ts';
import {
  FactoryAttemptLimitError,
  FactoryLeaseHeldError,
  FactoryOrchestrator,
  IMPLEMENTATION_LEASE_MS,
} from '../factory/orchestrator.ts';
import { stopBeforePush } from '../factory/smolvm-implementer.ts';
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
  test('a refused lease neither implements nor fails the holder workspace', async () => {
    const store = new MemoryFactoryRunStore();
    const { orchestrator, run } = await plannedRun(store);
    await new FactoryOrchestrator(store).beginImplementation(run.id);
    const calls: string[] = [];
    const git = { ...fakeGit(calls), fail: async (id: string) => void calls.push(`fail:${id}`) };

    await assert.rejects(
      runControlledImplementation(run, {
        orchestrator,
        git,
        verifier: { run: async () => [] },
        implementer: { implement: async () => void calls.push('implement') },
      }),
      FactoryLeaseHeldError,
    );
    assert.deepEqual(calls, []);
  });

  test('after a restart, a new process reclaims implementing with a fresh attempt clone', async () => {
    const store = new MemoryFactoryRunStore();
    const { orchestrator, run } = await plannedRun(store);
    await orchestrator.beginImplementation(run.id); // the first process dies here
    const restarted = new FactoryOrchestrator(store, {
      now: () => Date.now() + IMPLEMENTATION_LEASE_MS,
      maxAttempts: 3,
    });
    const calls: string[] = [];
    const workspaces: string[] = [];

    const result = await runControlledImplementation(await restarted.get(run.id), {
      orchestrator: restarted,
      git: fakeGit(calls),
      verifier: { run: async (commands) => commands.map((command) => commandResult(command, 0)) },
      implementer: { implement: async ({ workspace }) => void workspaces.push(workspace.id) },
    });

    assert.equal(result.state, 'reviewing');
    assert.deepEqual(workspaces, [`${run.id}-a2`]);
    assert.equal(result.implementation?.workspaceId, `${run.id}-a2`);
    assert.equal(result.implementationLease?.attempt, 2);
    assert.equal(result.branch, (await orchestrator.get(run.id)).branch);
  });

  test('after a restart in verifying, a new process verifies the recorded commit again', async () => {
    const store = new MemoryFactoryRunStore();
    const { orchestrator, run } = await plannedRun(store);
    const calls: string[] = [];
    await assert.rejects(
      runControlledImplementation(run, {
        orchestrator,
        git: stopBeforePush(fakeGit(calls)),
        verifier: { run: async (commands) => commands.map((command) => commandResult(command, 0)) },
        implementer: { implement: async () => {} },
      }),
      /stops before push/,
    );
    const restarted = new FactoryOrchestrator(store, {
      now: () => Date.now() + IMPLEMENTATION_LEASE_MS,
    });
    calls.length = 0;
    let implemented = false;

    const result = await runControlledImplementation(await restarted.get(run.id), {
      orchestrator: restarted,
      git: fakeGit(calls),
      verifier: { run: async (commands) => commands.map((command) => commandResult(command, 0)) },
      implementer: { implement: async () => void (implemented = true) },
    });

    assert.equal(result.state, 'reviewing');
    assert.equal(implemented, false);
    assert.equal(result.implementationLease?.attempt, 2);
    assert.equal(calls[0], `workspace:${run.id}:${result.branch}`);
    assert.ok(calls.includes('push:abc123'));
  });

  test('a reclaim at the attempt limit fails the run, its workspace, and its VMs', async () => {
    const store = new MemoryFactoryRunStore();
    const { orchestrator, run } = await plannedRun(store);
    await orchestrator.beginImplementation(run.id);
    const restarted = new FactoryOrchestrator(store, {
      now: () => Date.now() + IMPLEMENTATION_LEASE_MS,
      maxAttempts: 1,
    });
    const calls: string[] = [];

    await assert.rejects(
      runControlledImplementation(await restarted.get(run.id), {
        orchestrator: restarted,
        git: { ...fakeGit(calls), fail: async (id: string) => void calls.push(`fail:${id}`) },
        verifier: { run: async () => [] },
        implementer: {
          implement: async () => void calls.push('implement'),
          abandon: async (id) => void calls.push(`abandon:${id}`),
        },
      }),
      FactoryAttemptLimitError,
    );
    assert.deepEqual(calls, [`fail:${run.id}`, `abandon:${run.id}`]);
    assert.equal((await restarted.get(run.id)).state, 'failed');
  });

  test('a stale attempt that fails does not fail the newer attempt workspace', async () => {
    const store = new MemoryFactoryRunStore();
    const { orchestrator, run } = await plannedRun(store);
    const newer = new FactoryOrchestrator(store, {
      now: () => Date.now() + IMPLEMENTATION_LEASE_MS,
    });
    const calls: string[] = [];

    await assert.rejects(
      runControlledImplementation(run, {
        orchestrator,
        git: { ...fakeGit(calls), fail: async (id: string) => void calls.push(`fail:${id}`) },
        verifier: { run: async () => [] },
        implementer: {
          // The lease expires while attempt 1 runs, and another process takes attempt 2.
          implement: async () => {
            await newer.beginImplementation(run.id);
            throw new Error('attempt 1 crashed late');
          },
        },
      }),
      /attempt 1 crashed late/,
    );
    assert.deepEqual(
      calls.filter((call) => call.startsWith('fail:')),
      [`fail:${run.id}`],
    );
    assert.equal((await newer.get(run.id)).implementationLease?.attempt, 2);
  });

  test('the smolvm git mutator stops after verification and before push', async () => {
    const { orchestrator, run } = await plannedRun();
    const calls: string[] = [];
    const recorded: unknown[] = [];

    await assert.rejects(
      runControlledImplementation(run, {
        orchestrator,
        git: stopBeforePush(fakeGit(calls)),
        verifier: { run: async (commands) => commands.map((command) => commandResult(command, 0)) },
        implementer: {
          async implement({ recordExecution }) {
            await recordExecution?.({
              executor: 'smolvm',
              vmName: 'vm-1',
              baseSha: 'c'.repeat(40),
            });
            recorded.push('implemented');
          },
        },
      }),
      /stops before push: commit abc123/,
    );
    assert.ok(!calls.some((call) => call.startsWith('push')));
    const current = await orchestrator.get(run.id);
    assert.equal(current.state, 'verifying');
    assert.deepEqual(current.implementation?.commands, [
      { command: 'npm test', exitCode: 0 },
      { command: 'npm run typecheck', exitCode: 0 },
    ]);
    assert.deepEqual(current.execution, {
      executor: 'smolvm',
      vmName: 'vm-1',
      baseSha: 'c'.repeat(40),
      attempt: 1,
    });
  });

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
      `workspace:${run.id}:factory/94-controlled-implementation`,
      '/workspace',
      'verify:/workspace',
      'pristine:abc123',
      'push:abc123',
    ]);
  });

  test('resumes verification without rerunning the implementer or commit', async () => {
    const { orchestrator, run } = await plannedRun();
    const implementing = await orchestrator.beginImplementation(run.id);
    const verifying = await orchestrator.recordImplementation(implementing.id, {
      workspaceId: run.id,
      commitSha: 'abc123',
      changedFiles: ['factory/implementation.ts'],
      commands: [],
    });
    const calls: string[] = [];

    const result = await runControlledImplementation(verifying, {
      orchestrator,
      git: fakeGit(calls),
      implementer: {
        async implement() {
          calls.push('unexpected implement');
        },
      },
      verifier: {
        async run() {
          return [commandResult('npm test', 0)];
        },
      },
    });

    assert.equal(result.state, 'reviewing');
    assert.deepEqual(result.implementation?.commands, [{ command: 'npm test', exitCode: 0 }]);
    assert.equal(calls.includes('unexpected implement'), false);
    assert.equal(
      calls.some((call) => call.startsWith('commit:')),
      false,
    );
  });

  test('runs only additional verification commands approved by the plan', async () => {
    const { orchestrator, run } = await plannedRun();
    let verifiedCommands: string[] = [];

    const result = await runControlledImplementation(run, {
      orchestrator,
      git: fakeGit([]),
      implementer: { async implement() {} },
      verifier: {
        async run(commands) {
          verifiedCommands = commands;
          return commands.map((command) => commandResult(command, 0));
        },
      },
      additionalVerificationCommands: ['npm test', 'rm -rf /'],
    });

    assert.equal(result.state, 'reviewing');
    assert.deepEqual(verifiedCommands, ['npm test', 'npm run typecheck']);
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

  test('fails verification when checks change the committed implementation', async () => {
    const { orchestrator, run } = await plannedRun();
    const calls: string[] = [];
    const git = fakeGit(calls);
    git.isPristine = async () => false;

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
    assert.match(result.failure ?? '', /modified the implementation or its commit history/);
    assert.equal(
      calls.some((call) => call.startsWith('push:')),
      false,
    );
  });

  test('marks an allocated workspace failed when implementation throws', async () => {
    const { orchestrator, run } = await plannedRun();
    const calls: string[] = [];
    const git = fakeGit(calls);
    git.fail = async (id) => {
      calls.push(`fail:${id}`);
    };

    await assert.rejects(
      () =>
        runControlledImplementation(run, {
          orchestrator,
          git,
          implementer: {
            async implement() {
              throw new Error('implementation crashed');
            },
          },
          verifier: {
            async run() {
              return [];
            },
          },
        }),
      /implementation crashed/,
    );
    assert.equal(calls.includes(`fail:${run.id}`), true);
  });
});

async function plannedRun(
  store = new MemoryFactoryRunStore(),
): Promise<{ orchestrator: FactoryOrchestrator; run: FactoryRun }> {
  const orchestrator = new FactoryOrchestrator(store);
  const { run } = await orchestrator.start(task);
  await orchestrator.classify(run.id, classification);
  await orchestrator.plan(run.id, plan);
  await orchestrator.recordAutonomyAudit(run.id, autonomyAudit('implement-and-verify'));
  const planned = await orchestrator.recordAutonomyGate(run.id, 'implementation', {
    allowed: true,
    manualConfirmation: false,
    reason: 'Test policy allows implementation.',
  });
  return { orchestrator, run: planned };
}

function autonomyAudit(effectiveLevel: 'implement-and-verify') {
  return {
    policyVersion: 'test-v1',
    evidence: {
      runsConsidered: 0,
      verificationSamples: 0,
      verificationSuccesses: 0,
      verificationSuccessRate: 0,
      reviewSamples: 0,
      reviewReady: 0,
      reviewReadyRate: 0,
      publicationSamples: 0,
      publicationSuccesses: 0,
      publicationSuccessRate: 0,
      events: [],
    },
    effectiveLevel,
    explanation: ['Test policy.'],
    gateDecisions: [],
  };
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
    async push(_workspace, commitSha) {
      calls.push(`push:${commitSha}`);
    },
    async isPristine(_workspace, commitSha) {
      calls.push(`pristine:${commitSha}`);
      return true;
    },
  };
}

function commandResult(command: string, exitCode: number) {
  return { command, exitCode, stdout: '', stderr: '', durationMs: 1, timedOut: false };
}
