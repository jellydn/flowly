import type { FactoryRun } from './types.ts';

export const MIGRATION_CAMPAIGN_VERSION = '1' as const;

export type MigrationOrderingDependency = {
  before: string;
  after: string;
};

export type MigrationCampaignManifest = {
  version: typeof MIGRATION_CAMPAIGN_VERSION;
  id: string;
  repository: string;
  issueNumber: number;
  goal: string;
  constraints: string[];
  includePaths: string[];
  excludePaths: string[];
  maxFilesPerBatch: number;
  orderingDependencies: MigrationOrderingDependency[];
  verificationCommands: string[];
};

export type MigrationBatchState =
  | 'planned'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export type MigrationCampaignBatch = {
  id: string;
  sequence: number;
  files: string[];
  dependsOn: string[];
  state: MigrationBatchState;
  factoryRun?: FactoryRun;
  prNumber?: number;
  failureEvidence?: string;
  lastError?: string;
};

export type MigrationCampaignState =
  | 'planned'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'completed-with-failures';

export type MigrationCampaign = {
  id: string;
  manifest: MigrationCampaignManifest;
  inventory: string[];
  planDigest: string;
  batches: MigrationCampaignBatch[];
  state: MigrationCampaignState;
  version: number;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  approvedBy?: string;
};
