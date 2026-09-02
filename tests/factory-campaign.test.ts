import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  approveMigrationCampaign,
  buildMigrationCampaignPlan,
  createMigrationCampaign,
  matchesPath,
} from '../factory/campaign.ts';
import {
  campaignTask,
  createFactoryMigrationBatchExecutor,
  runMigrationCampaign,
} from '../factory/campaign-run.ts';
import {
  FileMigrationCampaignStore,
  MemoryMigrationCampaignStore,
} from '../factory/campaign-store.ts';
import type { MigrationCampaignManifest } from '../factory/campaign-types.ts';
import { factoryBranch, type FactoryRun } from '../factory/types.ts';
import { FactoryDraftPrPublisher } from '../factory/publisher.ts';
import { createRepositoryReader } from '../tools/repository.ts';
import { createSampleRepo, removeRepo } from './helpers.ts';

const manifest: MigrationCampaignManifest = {
  version: '1',
  id: 'typescript-api-migration',
  repository: 'jellydn/flowly',
  issueNumber: 119,
  goal: 'Migrate the TypeScript API',
  constraints: ['Keep public behavior stable.', 'Do not merge or deploy.'],
  includePaths: ['src/**'],
  excludePaths: ['src/generated/**'],
  maxFilesPerBatch: 1,
  orderingDependencies: [{ before: 'src/models/**', after: 'src/api/**' }],
  verificationCommands: ['npm test', 'npm run typecheck'],
};

const inventory = [
  'src/api/a.ts',
  'src/api/b.ts',
  'src/independent.ts',
  'src/models/a.ts',
  'src/models/b.ts',
  'src/generated/client.ts',
  '../escape.ts',
];

describe('migration campaign planning', () => {
  test('validates scope and deterministically produces bounded ordered batches', () => {
    const first = buildMigrationCampaignPlan(manifest, inventory, 1_700_000_000_000);
    const second = buildMigrationCampaignPlan(manifest, inventory.toReversed(), 1_700_000_000_000);

    assert.deepEqual(first, second);
    assert.deepEqual(first.inventory, [
      'src/api/a.ts',
      'src/api/b.ts',
      'src/independent.ts',
      'src/models/a.ts',
      'src/models/b.ts',
    ]);
    assert.ok(first.batches.every((batch) => batch.files.length <= manifest.maxFilesPerBatch));
    const apiBatches = first.batches.filter((batch) => batch.files[0]?.startsWith('src/api/'));
    assert.ok(apiBatches.every((batch) => batch.dependsOn.length === 2));
    assert.match(first.planDigest, /^[a-f0-9]{64}$/);
  });

  test('rejects malformed manifests and dependency cycles', () => {
    assert.throws(
      () => buildMigrationCampaignPlan({ ...manifest, includePaths: ['../escape'] }, inventory),
      /Invalid path scope|check/i,
    );
    assert.throws(
      () =>
        buildMigrationCampaignPlan(
          {
            ...manifest,
            orderingDependencies: [
              { before: 'src/models/**', after: 'src/api/**' },
              { before: 'src/api/**', after: 'src/models/**' },
            ],
          },
          inventory,
        ),
      /cycle/,
    );
  });

  test('matches bounded scopes without regex backtracking or traversal', () => {
    const started = performance.now();

    assert.equal(matchesPath('src/**/auth.ts', 'src/auth.ts'), true);
    assert.equal(matchesPath(`${'*'.repeat(32)}sentinel`, 'a'.repeat(500)), false);
    assert.equal(matchesPath('../**', '../secrets.txt'), false);
    assert.equal(matchesPath('/**', '/etc/passwd'), false);
    assert.ok(performance.now() - started < 1_000);
  });

  test('uses RepositoryReader discovery and honors included/excluded paths', async () => {
    const root = await createSampleRepo();
    try {
      const store = new MemoryMigrationCampaignStore();
      const result = await createMigrationCampaign(
        { ...manifest, orderingDependencies: [] },
        await createRepositoryReader(root),
        store,
      );
      assert.equal(result.created, true);
      assert.ok(result.campaign.inventory.every((filePath) => filePath.startsWith('src/')));
      assert.equal(result.campaign.inventory.includes('README.md'), false);
    } finally {
      await removeRepo(root);
    }
  });
});

describe('migration campaign approval and execution', () => {
  test('requires explicit digest-bound human approval before any batch runs', async () => {
    const store = await campaignStore();
    let calls = 0;
    await assert.rejects(
      () =>
        runMigrationCampaign(store, manifest.id, async () => {
          calls += 1;
          return completedRun('unexpected', 1);
        }),
      /explicitly approved/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      () => approveMigrationCampaign(store, manifest.id, 'wrong-digest', 'release-manager'),
      /digest changed/,
    );
    const campaign = (await store.load(manifest.id))!;
    const approved = await approveMigrationCampaign(
      store,
      manifest.id,
      campaign.planDigest,
      'release-manager',
    );
    assert.equal(approved.state, 'approved');
    assert.equal(approved.approvedBy, 'release-manager');
  });

  test('blocks dependent batches after failure while completing independent batches', async () => {
    const store = await approvedCampaignStore();
    const calls: string[] = [];
    const result = await runMigrationCampaign(store, manifest.id, async (_campaign, batch) => {
      calls.push(batch.id);
      return batch.files.includes('src/models/a.ts')
        ? failedRun(batch.id, 'npm test failed')
        : completedRun(batch.id, 200 + batch.sequence);
    });

    assert.equal(result.state, 'completed-with-failures');
    const failedBatch = result.batches.find((batch) => batch.files.includes('src/models/a.ts'))!;
    assert.equal(failedBatch.state, 'failed');
    assert.ok(
      result.batches
        .filter((batch) => batch.files[0]?.startsWith('src/api/'))
        .every(
          (batch) =>
            batch.state === 'blocked' && (batch.failureEvidence ?? '').includes(failedBatch.id),
        ),
    );
    assert.equal(
      result.batches.find((batch) => batch.files.includes('src/independent.ts'))?.state,
      'completed',
    );
    assert.ok(
      result.batches
        .filter((batch) => batch.files[0]?.startsWith('src/api/'))
        .every((batch) => !calls.includes(batch.id)),
    );
  });

  test('retries resumable batches without duplicating completed work or PR records', async () => {
    const store = await approvedCampaignStore();
    const attempts = new Map<string, number>();
    const execute = async (_campaign: unknown, batch: { id: string; sequence: number }) => {
      attempts.set(batch.id, (attempts.get(batch.id) ?? 0) + 1);
      if (batch.id === 'batch-002' && attempts.get(batch.id) === 1) {
        throw new Error('temporary provider failure');
      }
      return completedRun(batch.id, 300 + batch.sequence);
    };

    const first = await runMigrationCampaign(store, manifest.id, execute);
    assert.equal(first.state, 'executing');
    assert.equal(first.batches.find((batch) => batch.id === 'batch-002')?.state, 'ready');
    const second = await runMigrationCampaign(store, manifest.id, execute);
    const third = await runMigrationCampaign(store, manifest.id, execute);
    assert.equal(second.state, 'completed');
    assert.equal(third.version, second.version);
    assert.equal(attempts.get('batch-001'), 1);
    assert.equal(attempts.get('batch-002'), 2);
    assert.equal(
      new Set(second.batches.map((batch) => batch.prNumber)).size,
      second.batches.length,
    );
  });

  test('persists campaign and per-batch state across file-store instances', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flowly-campaign-'));
    try {
      const firstStore = new FileMigrationCampaignStore(directory);
      const campaign = buildMigrationCampaignPlan(manifest, inventory);
      await firstStore.createOrGet(campaign);
      await approveMigrationCampaign(firstStore, campaign.id, campaign.planDigest, 'operator');

      const secondStore = new FileMigrationCampaignStore(directory);
      const loaded = await secondStore.load(campaign.id);
      assert.equal(loaded?.approvedBy, 'operator');
      assert.ok(loaded?.batches.every((batch) => batch.state === 'ready'));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects persisted campaign state whose plan no longer matches its digest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flowly-campaign-'));
    try {
      const store = new FileMigrationCampaignStore(directory);
      const campaign = buildMigrationCampaignPlan(manifest, inventory);
      await store.createOrGet(campaign);
      await writeFile(
        path.join(directory, `${encodeURIComponent(campaign.id)}.json`),
        JSON.stringify({ ...campaign, inventory: ['src/unreviewed.ts'] }),
      );

      await assert.rejects(() => store.load(campaign.id), /plan digest does not match/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('serializes parallel file-store saves for one campaign', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flowly-campaign-'));
    try {
      const store = new FileMigrationCampaignStore(directory);
      const campaign = buildMigrationCampaignPlan(manifest, inventory);
      await store.createOrGet(campaign);
      const first = { ...campaign, version: 2, updatedAt: campaign.updatedAt + 1 };
      const second = { ...campaign, version: 2, updatedAt: campaign.updatedAt + 2 };

      const results = await Promise.allSettled([
        store.save(first, campaign.version),
        store.save(second, campaign.version),
      ]);

      assert.deepEqual(results.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
      assert.equal((await store.load(campaign.id))?.version, 2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('creates unique factory tasks and branches without privileged operations', () => {
    const campaign = buildMigrationCampaignPlan(manifest, inventory);
    const first = campaignTask(campaign, campaign.batches[0]!);
    const second = campaignTask(campaign, campaign.batches[1]!);
    const firstBranch = factoryBranch(first.issueNumber, first.title, first.campaign);
    const secondBranch = factoryBranch(second.issueNumber, second.title, second.campaign);
    assert.notEqual(firstBranch, secondBranch);
    assert.match(firstBranch, /^factory\/119-typescript-api-migration-batch-001-/);
    assert.equal('merge' in first || 'deploy' in first || 'approve' in first, false);
  });

  test('executes an approved batch through the existing factory boundaries', async () => {
    const oneFileManifest = {
      ...manifest,
      id: 'single-batch-migration',
      maxFilesPerBatch: 10,
      orderingDependencies: [],
    };
    const store = new MemoryMigrationCampaignStore();
    const planned = buildMigrationCampaignPlan(oneFileManifest, ['src/only.ts']);
    await store.createOrGet(planned);
    await approveMigrationCampaign(store, planned.id, planned.planDigest, 'operator');
    const calls: string[] = [];
    const executor = createFactoryMigrationBatchExecutor(store, {
      classifier: {
        async classify() {
          calls.push('classify');
          return {
            actionable: true,
            type: 'refactor',
            priority: 'medium',
            complexity: 'small',
            missingInformation: [],
          };
        },
      },
      planner: {
        async plan() {
          calls.push('plan');
          return {
            summary: 'Migrate one file.',
            steps: ['Update the API.'],
            acceptanceCriteria: [{ description: 'The API is migrated.' }],
            verificationCommands: ['wrong command'],
          };
        },
      },
      progress: { async publish() {} },
      git: {
        async createWorkspace(id, branch) {
          calls.push('workspace');
          return { id, branch, baseRef: 'origin/main', path: '/workspace' };
        },
        async commit() {
          calls.push('commit');
          return {
            commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            changedFiles: ['src/only.ts'],
          };
        },
        async push() {
          calls.push('push');
        },
        async isPristine() {
          return true;
        },
      },
      implementer: {
        async implement({ plan }) {
          calls.push(`implement:${plan.relevantFiles?.join(',')}`);
        },
      },
      verifier: {
        async run(commands) {
          calls.push(`verify:${commands.join(',')}`);
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
          calls.push('review');
          return { summary: 'Ready.', verdict: 'COMMENT', findings: [] };
        },
      },
      publisher: new FactoryDraftPrPublisher({
        owner: 'jellydn',
        repo: 'flowly',
        async findPullRequestsByHead() {
          return [];
        },
        async createDraftPullRequest(input) {
          calls.push('publish-draft');
          return {
            number: 401,
            htmlUrl: 'https://github.com/jellydn/flowly/pull/401',
            draft: true,
            state: 'open',
            head: input.head,
            base: input.base,
          };
        },
      }),
      readDiff: async () => '+migrated',
      judgmentsFrom: (evidence) =>
        evidence.acceptanceCriteria.map((criterion) => ({
          description: criterion.description,
          satisfied: true,
          evidence: 'Present in diff.',
        })),
      autonomyPolicy: {
        version: 'campaign-test-v1',
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
    });

    const result = await runMigrationCampaign(store, planned.id, executor);
    assert.equal(result.state, 'completed', JSON.stringify(result.batches, null, 2));
    assert.equal(result.batches[0]?.prNumber, 401);
    assert.deepEqual(calls, [
      'classify',
      'plan',
      'workspace',
      'implement:src/only.ts',
      'commit',
      'workspace',
      `verify:${manifest.verificationCommands.join(',')}`,
      'push',
      'review',
      'publish-draft',
    ]);
    assert.equal(
      calls.some((call) => /merge|approve|deploy/.test(call)),
      false,
    );
  });
});

async function campaignStore(): Promise<MemoryMigrationCampaignStore> {
  const store = new MemoryMigrationCampaignStore();
  await store.createOrGet(buildMigrationCampaignPlan(manifest, inventory));
  return store;
}

async function approvedCampaignStore(): Promise<MemoryMigrationCampaignStore> {
  const store = await campaignStore();
  const campaign = (await store.load(manifest.id))!;
  await approveMigrationCampaign(store, campaign.id, campaign.planDigest, 'operator');
  return store;
}

function completedRun(batchId: string, prNumber: number): FactoryRun {
  return run(batchId, 'completed', prNumber);
}

function failedRun(batchId: string, failure: string): FactoryRun {
  return { ...run(batchId, 'failed'), failure };
}

function run(batchId: string, state: 'completed' | 'failed', prNumber?: number): FactoryRun {
  return {
    id: `run-${batchId}`,
    task: {
      issueNumber: manifest.issueNumber,
      title: batchId,
      body: manifest.goal,
      repository: manifest.repository,
      campaign: { campaignId: manifest.id, batchId },
    },
    state,
    version: 10,
    prNumber,
    updatedAt: Date.now(),
  };
}
