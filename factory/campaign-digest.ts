import { createHash } from 'node:crypto';
import type { MigrationCampaignBatch, MigrationCampaignManifest } from './campaign-types.ts';

export function digestMigrationCampaignPlan(
  manifest: MigrationCampaignManifest,
  inventory: string[],
  batches: MigrationCampaignBatch[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        manifest,
        inventory,
        batches: batches.map(({ id, sequence, files, dependsOn }) => ({
          id,
          sequence,
          files,
          dependsOn,
        })),
      }),
    )
    .digest('hex');
}
