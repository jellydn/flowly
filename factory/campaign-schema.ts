import * as v from 'valibot';
import { digestMigrationCampaignPlan } from './campaign-digest.ts';
import { factoryRunSchema } from './schema.ts';
import { MIGRATION_CAMPAIGN_VERSION, type MigrationCampaign } from './campaign-types.ts';

const pathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(500),
  v.check(
    (value) => !value.startsWith('/') && !value.split('/').includes('..'),
    'Invalid path scope.',
  ),
);

export const migrationCampaignManifestSchema = v.object({
  version: v.literal(MIGRATION_CAMPAIGN_VERSION),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(100), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  repository: v.pipe(v.string(), v.regex(/^.+\/.+$/)),
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  goal: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  constraints: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
    v.minLength(1),
  ),
  includePaths: v.pipe(v.array(pathSchema), v.minLength(1)),
  excludePaths: v.array(pathSchema),
  maxFilesPerBatch: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  orderingDependencies: v.array(
    v.object({
      before: pathSchema,
      after: pathSchema,
    }),
  ),
  verificationCommands: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
    v.minLength(1),
    v.maxLength(20),
  ),
});

const migrationBatchSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^batch-\d{3}$/)),
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  files: v.pipe(v.array(pathSchema), v.minLength(1)),
  dependsOn: v.array(v.string()),
  state: v.picklist(['planned', 'ready', 'running', 'completed', 'failed', 'blocked']),
  factoryRun: v.optional(factoryRunSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  failureEvidence: v.optional(v.string()),
  lastError: v.optional(v.string()),
});

export const migrationCampaignSchema = v.object({
  id: v.string(),
  manifest: migrationCampaignManifestSchema,
  inventory: v.array(pathSchema),
  planDigest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  batches: v.array(migrationBatchSchema),
  state: v.picklist(['planned', 'approved', 'executing', 'completed', 'completed-with-failures']),
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  approvedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  approvedBy: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export function parseMigrationCampaignManifest(value: unknown) {
  return v.parse(migrationCampaignManifestSchema, value);
}

export function parseMigrationCampaign(value: unknown): MigrationCampaign {
  const campaign = v.parse(migrationCampaignSchema, value);
  if (
    campaign.planDigest !==
    digestMigrationCampaignPlan(campaign.manifest, campaign.inventory, campaign.batches)
  ) {
    throw new Error('Migration campaign plan digest does not match its persisted batch plan.');
  }
  return campaign;
}
