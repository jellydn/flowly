import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  eventsForRunTransition,
  explainFactoryRun,
  MemoryFactoryEventLog,
  projectFactoryRun,
  StoredFactoryEventLog,
  unknownUsage,
  type FactoryRunEventType,
} from '../factory/events.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import { FactoryDraftPrPublisher } from '../factory/publisher.ts';
import { runFactoryPipeline, type FactoryPipelineDependencies } from '../factory/run.ts';
import { FileFactoryRunStore, MemoryFactoryRunStore } from '../factory/store.ts';
import type { FactoryTask, ImplementationPlan, TaskClassification } from '../factory/types.ts';

const task: FactoryTask = {
  issueNumber: 139,
  title: 'Add operator control plane',
  body: 'Inspect runs without chain-of-thought.',
  repository: 'jellydn/flowly',
};
const classification: TaskClassification = {
  actionable: true,
  type: 'feature',
  priority: 'high',
  complexity: 'medium',
  missingInformation: [],
};
const plan: ImplementationPlan = {
  summary: 'Record factory events.',
  steps: ['Emit', 'Project'],
  acceptanceCriteria: [{ description: 'Operators can explain a run.' }],
  verificationCommands: ['npm test'],
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('factory event log', () => {
  test('appends ordered schema-validated events and ingests duplicates idempotently', async () => {
    const log = new MemoryFactoryEventLog();
    const first = await log.append({
      runId: 'run-139',
      stage: 'run',
      type: 'run.started',
      timestamp: 10,
      attempt: 1,
      summary: 'Started.',
      metadata: { repository: 'jellydn/flowly', issueNumber: 139 },
    });
    const duplicate = await log.append(first);
    await assert.rejects(
      () =>
        log.append({
          ...first,
          summary: 'Different payload.',
        }),
      /already exists with different payload/,
    );
    await assert.rejects(
      () =>
        log.append({
          runId: 'run-139',
          sequence: 3,
          type: 'run.completed',
          timestamp: 20,
          attempt: 1,
          summary: 'Skipped sequence.',
          metadata: {},
        }),
      /must use sequence 2/,
    );
    assert.equal(first.sequence, 1);
    assert.equal(duplicate.sequence, 1);
    assert.equal((await log.list('run-139')).length, 1);
  });

  test('file-backed run log round-trips events', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flowly-events-'));
    temporaryDirectories.push(directory);
    const store = new FileFactoryRunStore(directory);
    const orchestrator = new FactoryOrchestrator(store);
    const { run } = await orchestrator.start(task);
    const log = new StoredFactoryEventLog(store, task.repository);
    await log.append({
      runId: run.id,
      type: 'tool.invoked',
      timestamp: 2,
      attempt: 1,
      summary: 'Tool completed.',
      metadata: { repository: 'jellydn/flowly' },
    });
    const reloaded = new StoredFactoryEventLog(new FileFactoryRunStore(directory), task.repository);
    assert.equal((await reloaded.list(run.id))[1]?.summary, 'Tool completed.');
  });

  test('stored log does not lose concurrent appends', async () => {
    const store = new MemoryFactoryRunStore();
    const orchestrator = new FactoryOrchestrator(store);
    const { run } = await orchestrator.start(task);
    const log = new StoredFactoryEventLog(store, task.repository);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        log.append({
          runId: run.id,
          type: 'tool.invoked',
          timestamp: index + 1,
          attempt: 1,
          summary: `Tool ${index}.`,
          metadata: {},
        }),
      ),
    );
    const events = await log.list(run.id);
    assert.equal(events.length, 21);
    assert.deepEqual(
      events.map((item) => item.sequence),
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
  });

  test('projection replays status, retries, gates, and unknown usage', () => {
    const events = [
      event(1, 'run.started', 'run', 'Started.', {
        repository: 'jellydn/flowly',
        issueNumber: 139,
      }),
      event(2, 'stage.started', 'implementer', 'Attempt 1.', {
        usage: unknownUsage(['tokens', 'cost']),
      }),
      event(3, 'stage.failed', 'implementer', 'Timed out.', { failure: 'Timed out.' }),
      event(4, 'run.resumed', 'run', 'Retrying.', {}),
      event(5, 'stage.started', 'implementer', 'Attempt 2.', {}, 2),
      event(
        6,
        'gate.evaluated',
        'publisher',
        'Publication blocked.',
        {
          boundary: 'publication',
          allowed: false,
          reason: 'Need human confirmation.',
          policyVersion: 'policy-v1',
        },
        1,
        'policy-v1',
      ),
    ];
    const projection = projectFactoryRun(events);
    assert.equal(projection.status, 'blocked');
    assert.equal(projection.attempts, 2);
    assert.equal(projection.gates[0]?.allowed, false);
    assert.equal(projection.gates[0]?.policyVersion, 'policy-v1');
    assert.deepEqual(projection.usage.unknown, ['tokens', 'cost']);
    assert.match(explainFactoryRun(events), /Need human confirmation/);
    assert.match(explainFactoryRun(events), /Policy version: policy-v1/);
    assert.match(explainFactoryRun(events), /unknown: tokens, cost/);
  });

  test('does not persist chain-of-thought in transition metadata', () => {
    const events = eventsForRunTransition(undefined, {
      id: 'run-139',
      task,
      state: 'queued',
      version: 1,
      updatedAt: 1,
      chainOfThought: 'secret reasoning',
    } as never);
    assert.equal(JSON.stringify(events).includes('secret reasoning'), false);
    assert.equal(JSON.stringify(events).includes('chainOfThought'), false);
  });

  test('removes sensitive metadata recursively', async () => {
    const log = new MemoryFactoryEventLog();
    const recorded = await log.append({
      runId: 'run-139',
      type: 'tool.invoked',
      timestamp: 1,
      attempt: 1,
      summary: 'Tool completed.',
      metadata: {
        safe: { result: 'ok', transcript: 'secret' },
        nested: [{ implementer_scratch: 'secret', value: 2 }],
      },
    });
    assert.deepEqual(recorded.metadata, {
      safe: { result: 'ok' },
      nested: [{ value: 2 }],
    });
  });

  test('records a reclaimed planning lease as a new attempt', async () => {
    const store = new MemoryFactoryRunStore();
    const orchestrator = new FactoryOrchestrator(store);
    const { run } = await orchestrator.start(task);
    await orchestrator.classify(run.id, classification);
    const first = await orchestrator.beginPlanning(run.id);
    await store.save(
      {
        ...first.run,
        version: first.run.version + 1,
        planningStartedAt: 0,
      },
      first.run.version,
    );
    await orchestrator.beginPlanning(run.id);
    const events = (await orchestrator.get(run.id)).events ?? [];
    const resumed = events.find((item) => item.type === 'run.resumed');
    assert.equal(resumed?.attempt, 2);
    assert.equal(
      events.some(
        (item) => item.type === 'stage.started' && item.stage === 'planner' && item.attempt === 2,
      ),
      true,
    );
  });
});

describe('factory pipeline events', () => {
  test('records a complete stage timeline that explain can replay', async () => {
    const store = new MemoryFactoryRunStore();
    const events = new StoredFactoryEventLog(store, task.repository);
    const result = await runFactoryPipeline(task, pipelineDependencies(store));
    const timeline = await events.list(result.id);
    assert.equal(timeline[0]?.type, 'run.started');
    assert.deepEqual(
      timeline.map((event) => event.sequence),
      timeline.map((_, index) => index + 1),
    );
    const types = timeline.map((event) => event.type);
    const expectedTypes: FactoryRunEventType[] = [
      'run.started',
      'stage.completed',
      'stage.started',
      'gate.evaluated',
      'verification.completed',
      'review.completed',
      'publication.completed',
      'run.completed',
    ];
    for (const expected of expectedTypes) {
      assert.equal(types.includes(expected), true, expected);
    }
    const projection = projectFactoryRun(timeline);
    assert.equal(projection.status, 'completed');
    assert.equal(projection.issueNumber, 139);
    assert.equal(projection.verification?.passed, true);
    assert.equal(projection.publication?.draft, true);
    assert.match(explainFactoryRun(timeline), /completed/);
    assert.equal(JSON.stringify(timeline).includes('chain-of-thought'), false);
  });
});

function event(
  sequence: number,
  type: FactoryRunEventType,
  stage: 'run' | 'classifier' | 'planner' | 'implementer' | 'verifier' | 'reviewer' | 'publisher',
  summary: string,
  metadata: Record<string, unknown>,
  attempt = 1,
  policyVersion?: string,
) {
  return {
    runId: 'run-139',
    sequence,
    stage,
    type,
    timestamp: sequence * 10,
    attempt,
    summary,
    metadata,
    ...(policyVersion ? { policyVersion } : {}),
  };
}

function pipelineDependencies(store: MemoryFactoryRunStore): FactoryPipelineDependencies {
  return {
    orchestrator: new FactoryOrchestrator(store),
    classifier: {
      async classify() {
        return classification;
      },
    },
    planner: {
      async plan() {
        return plan;
      },
    },
    progress: { async publish() {} },
    git: {
      async createWorkspace(id, branch) {
        return { id, path: '/workspace', branch, baseRef: 'origin/main' };
      },
      async commit() {
        return {
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          changedFiles: ['factory/events.ts'],
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
        return { summary: 'Ready for human review.', verdict: 'COMMENT', findings: [] };
      },
    },
    publisher: new FactoryDraftPrPublisher({
      owner: 'jellydn',
      repo: 'flowly',
      async findPullRequestsByHead() {
        return [];
      },
      async createDraftPullRequest(input) {
        return {
          number: 139,
          htmlUrl: 'https://github.com/jellydn/flowly/pull/139',
          draft: true,
          head: input.head,
          base: input.base,
          state: 'open',
        };
      },
    }),
    readDiff: async () =>
      [
        'diff --git a/factory/events.ts b/factory/events.ts',
        '--- a/factory/events.ts',
        '+++ b/factory/events.ts',
        '@@ -1,0 +1,1 @@',
        '+export type FactoryRunEvent = {};',
      ].join('\n'),
    judgmentsFrom: (evidence) =>
      evidence.acceptanceCriteria.map((criterion) => ({
        description: criterion.description,
        satisfied: true,
        evidence: 'diff',
      })),
    autonomyPolicy: {
      version: 'test-publish-v1',
      promotionEnabled: false,
      defaultLevel: 'publish-draft-pr',
      maximumLevel: 'publish-draft-pr',
      minimumSamples: { implementAndVerify: 1, publishDraftPr: 1 },
      promotionThresholds: {
        verificationSuccessRate: 0,
        reviewReadyRate: 0,
        publicationSuccessRate: 0,
      },
      demotions: {},
    },
  };
}
