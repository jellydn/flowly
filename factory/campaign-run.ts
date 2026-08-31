import type { FactoryPipelineDependencies } from './run.ts';
import { runFactoryPipeline } from './run.ts';
import { FactoryOrchestrator } from './orchestrator.ts';
import { assertRunVersion, type FactoryRunStore } from './store.ts';
import { saveCampaign } from './campaign.ts';
import type { MigrationCampaignStore } from './campaign-store.ts';
import type { MigrationCampaign, MigrationCampaignBatch } from './campaign-types.ts';
import type { FactoryRun, FactoryTask } from './types.ts';

export type MigrationBatchExecutor = (
  campaign: MigrationCampaign,
  batch: MigrationCampaignBatch,
) => Promise<FactoryRun>;

export async function runMigrationCampaign(
  store: MigrationCampaignStore,
  campaignId: string,
  executeBatch: MigrationBatchExecutor,
): Promise<MigrationCampaign> {
  let campaign = await requireCampaign(store, campaignId);
  if (campaign.state === 'planned') {
    throw new Error('Migration campaign batch plan must be explicitly approved before execution.');
  }
  if (campaign.state === 'completed' || campaign.state === 'completed-with-failures') {
    return campaign;
  }
  if (campaign.state === 'approved') {
    campaign = await saveCampaign(store, { ...campaign, state: 'executing' });
  }

  for (const plannedBatch of campaign.batches.toSorted((a, b) => a.sequence - b.sequence)) {
    campaign = await requireCampaign(store, campaignId);
    const batch = campaign.batches.find((candidate) => candidate.id === plannedBatch.id)!;
    if (batch.state === 'completed' || batch.state === 'failed' || batch.state === 'blocked') {
      continue;
    }
    const dependencies = batch.dependsOn.map((id) =>
      campaign.batches.find((candidate) => candidate.id === id),
    );
    const failedDependency = dependencies.find(
      (dependency) => dependency?.state === 'failed' || dependency?.state === 'blocked',
    );
    if (failedDependency) {
      campaign = await updateBatch(store, campaign, batch.id, {
        state: 'blocked',
        failureEvidence: `Blocked by ${failedDependency.id}: ${failedDependency.failureEvidence ?? 'dependency failed'}`,
      });
      continue;
    }
    if (dependencies.some((dependency) => dependency?.state !== 'completed')) continue;

    campaign = await updateBatch(store, campaign, batch.id, {
      state: 'running',
      lastError: undefined,
    });
    const runningBatch = campaign.batches.find((candidate) => candidate.id === batch.id)!;
    try {
      const run = await executeBatch(campaign, runningBatch);
      campaign = await requireCampaign(store, campaignId);
      if (run.state === 'completed') {
        campaign = await updateBatch(store, campaign, batch.id, {
          state: 'completed',
          factoryRun: run,
          prNumber: run.prNumber,
          failureEvidence: undefined,
        });
      } else if (run.state === 'failed') {
        campaign = await updateBatch(store, campaign, batch.id, {
          state: 'failed',
          factoryRun: run,
          failureEvidence: run.failure ?? 'Factory batch failed.',
        });
      } else {
        campaign = await updateBatch(store, campaign, batch.id, {
          state: 'ready',
          factoryRun: run,
          lastError: `Factory run stopped at ${run.state}; satisfy its trusted gate and retry.`,
        });
      }
    } catch (error) {
      campaign = await requireCampaign(store, campaignId);
      campaign = await updateBatch(store, campaign, batch.id, {
        state: 'ready',
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  campaign = await requireCampaign(store, campaignId);
  const terminal = campaign.batches.every((batch) =>
    ['completed', 'failed', 'blocked'].includes(batch.state),
  );
  if (!terminal) return campaign;
  return saveCampaign(store, {
    ...campaign,
    state: campaign.batches.every((batch) => batch.state === 'completed')
      ? 'completed'
      : 'completed-with-failures',
  });
}

export function createFactoryMigrationBatchExecutor(
  campaignStore: MigrationCampaignStore,
  dependencies: Omit<FactoryPipelineDependencies, 'orchestrator'>,
): MigrationBatchExecutor {
  return async (campaign, batch) => {
    const task = campaignTask(campaign, batch);
    return runFactoryPipeline(task, {
      ...dependencies,
      planner: {
        async plan(input) {
          const plan = await dependencies.planner.plan(input);
          return {
            ...plan,
            relevantFiles: [...batch.files],
            verificationCommands: [...campaign.manifest.verificationCommands],
          };
        },
      },
      orchestrator: new FactoryOrchestrator(
        new CampaignBatchFactoryRunStore(campaignStore, campaign.id, batch.id),
      ),
    });
  };
}

export function campaignTask(
  campaign: MigrationCampaign,
  batch: MigrationCampaignBatch,
): FactoryTask {
  return {
    issueNumber: campaign.manifest.issueNumber,
    repository: campaign.manifest.repository,
    title: `${campaign.manifest.goal} (${batch.id})`,
    body: [
      campaign.manifest.goal,
      '',
      'Files in this approved migration batch:',
      ...batch.files.map((filePath) => `- ${filePath}`),
      '',
      'Repository constraints:',
      ...campaign.manifest.constraints.map((constraint) => `- ${constraint}`),
    ].join('\n'),
    campaign: { campaignId: campaign.id, batchId: batch.id },
  };
}

class CampaignBatchFactoryRunStore implements FactoryRunStore {
  constructor(
    private readonly store: MigrationCampaignStore,
    private readonly campaignId: string,
    private readonly batchId: string,
  ) {}

  async load(id: string): Promise<FactoryRun | null> {
    const run = (await this.batch()).factoryRun;
    return run?.id === id ? structuredClone(run) : null;
  }

  async createOrGet(run: FactoryRun) {
    const campaign = await requireCampaign(this.store, this.campaignId);
    const batch = campaign.batches.find((candidate) => candidate.id === this.batchId)!;
    if (batch.factoryRun) return { run: structuredClone(batch.factoryRun), created: false };
    await updateBatch(this.store, campaign, this.batchId, { factoryRun: run });
    return { run: structuredClone(run), created: true };
  }

  async save(run: FactoryRun, expectedVersion: number): Promise<void> {
    const campaign = await requireCampaign(this.store, this.campaignId);
    const batch = campaign.batches.find((candidate) => candidate.id === this.batchId)!;
    assertRunVersion(run, expectedVersion, batch.factoryRun?.version ?? 0);
    await updateBatch(this.store, campaign, this.batchId, { factoryRun: run });
  }

  async findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null> {
    const run = (await this.batch()).factoryRun;
    return run?.task.repository === repository && run.task.issueNumber === issueNumber
      ? structuredClone(run)
      : null;
  }

  async listByRepository(repository: string): Promise<FactoryRun[]> {
    const campaign = await requireCampaign(this.store, this.campaignId);
    return campaign.batches
      .flatMap((batch) => (batch.factoryRun ? [batch.factoryRun] : []))
      .filter((run) => run.task.repository === repository)
      .map((run) => structuredClone(run));
  }

  private async batch(): Promise<MigrationCampaignBatch> {
    const campaign = await requireCampaign(this.store, this.campaignId);
    const batch = campaign.batches.find((candidate) => candidate.id === this.batchId);
    if (!batch) throw new Error(`Migration batch ${this.batchId} does not exist.`);
    return batch;
  }
}

async function updateBatch(
  store: MigrationCampaignStore,
  campaign: MigrationCampaign,
  batchId: string,
  update: Partial<MigrationCampaignBatch>,
): Promise<MigrationCampaign> {
  return saveCampaign(store, {
    ...campaign,
    batches: campaign.batches.map((batch) =>
      batch.id === batchId ? { ...batch, ...update } : batch,
    ),
  });
}

async function requireCampaign(
  store: MigrationCampaignStore,
  campaignId: string,
): Promise<MigrationCampaign> {
  const campaign = await store.load(campaignId);
  if (!campaign) throw new Error(`Migration campaign ${campaignId} does not exist.`);
  return campaign;
}
