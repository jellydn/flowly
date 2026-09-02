import type { RepositoryReader } from '../tools/repository.ts';
import { TOOL_LIMITS } from '../tools/contracts.ts';
import { digestMigrationCampaignPlan } from './campaign-digest.ts';
import { parseMigrationCampaignManifest } from './campaign-schema.ts';
import type { MigrationCampaignStore } from './campaign-store.ts';
import type {
  MigrationCampaign,
  MigrationCampaignBatch,
  MigrationCampaignManifest,
} from './campaign-types.ts';

export async function createMigrationCampaign(
  manifestValue: unknown,
  repository: RepositoryReader,
  store: MigrationCampaignStore,
): Promise<{ campaign: MigrationCampaign; created: boolean }> {
  const manifest = parseMigrationCampaignManifest(manifestValue);
  const entries = await repository.list('.', 100);
  const inventory = entries
    .filter(
      (entry) =>
        entry.type === 'file' &&
        (entry.size ?? Infinity) <= TOOL_LIMITS.maxFileBytes &&
        inManifestScope(entry.path, manifest),
    )
    .map((entry) => entry.path)
    .sort();
  const campaign = buildMigrationCampaignPlan(manifest, inventory);
  return store.createOrGet(campaign);
}

export function buildMigrationCampaignPlan(
  manifestValue: unknown,
  inventoryValue: string[],
  now = Date.now(),
): MigrationCampaign {
  const manifest = parseMigrationCampaignManifest(manifestValue);
  const inventory = [...new Set(inventoryValue)]
    .filter((filePath) => validRepositoryPath(filePath) && inManifestScope(filePath, manifest))
    .sort();
  if (inventory.length === 0) {
    throw new Error('Migration campaign inventory is empty within the declared path scope.');
  }

  const orderedFiles = topologicalFiles(inventory, manifest);
  const batches: MigrationCampaignBatch[] = [];
  for (let offset = 0; offset < orderedFiles.length; offset += manifest.maxFilesPerBatch) {
    const sequence = batches.length + 1;
    batches.push({
      id: `batch-${String(sequence).padStart(3, '0')}`,
      sequence,
      files: orderedFiles.slice(offset, offset + manifest.maxFilesPerBatch),
      dependsOn: [],
      state: 'planned',
    });
  }
  applyBatchDependencies(batches, manifest);
  const planDigest = digestMigrationCampaignPlan(manifest, inventory, batches);
  return {
    id: manifest.id,
    manifest,
    inventory,
    planDigest,
    batches,
    state: 'planned',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export async function approveMigrationCampaign(
  store: MigrationCampaignStore,
  campaignId: string,
  planDigest: string,
  approvedBy: string,
): Promise<MigrationCampaign> {
  if (!approvedBy.trim()) throw new Error('Migration campaign approval requires an actor.');
  const campaign = await requireCampaign(store, campaignId);
  if (campaign.state !== 'planned') return campaign;
  if (campaign.planDigest !== planDigest) {
    throw new Error('Migration campaign plan digest changed; review the current batch plan.');
  }
  return saveCampaign(store, {
    ...campaign,
    state: 'approved',
    approvedAt: Date.now(),
    approvedBy: approvedBy.trim(),
    batches: campaign.batches.map((batch) => ({ ...batch, state: 'ready' })),
  });
}

function topologicalFiles(inventory: string[], manifest: MigrationCampaignManifest): string[] {
  const outgoing = new Map(inventory.map((filePath) => [filePath, new Set<string>()]));
  const incoming = new Map(inventory.map((filePath) => [filePath, 0]));
  for (const dependency of manifest.orderingDependencies) {
    const beforeFiles = inventory.filter((filePath) => matchesPath(dependency.before, filePath));
    const afterFiles = inventory.filter((filePath) => matchesPath(dependency.after, filePath));
    for (const before of beforeFiles) {
      for (const after of afterFiles) {
        if (before === after || outgoing.get(before)?.has(after)) continue;
        outgoing.get(before)?.add(after);
        incoming.set(after, (incoming.get(after) ?? 0) + 1);
      }
    }
  }

  const ready = inventory.filter((filePath) => incoming.get(filePath) === 0).sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const target of [...(outgoing.get(current) ?? [])].sort()) {
      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (ordered.length !== inventory.length) {
    throw new Error('Migration campaign ordering dependencies contain a cycle.');
  }
  return ordered;
}

function applyBatchDependencies(
  batches: MigrationCampaignBatch[],
  manifest: MigrationCampaignManifest,
): void {
  const batchFor = (filePath: string) => batches.find((batch) => batch.files.includes(filePath));
  for (const dependency of manifest.orderingDependencies) {
    const beforeBatches = batches.filter((batch) =>
      batch.files.some((filePath) => matchesPath(dependency.before, filePath)),
    );
    const afterBatches = batches.filter((batch) =>
      batch.files.some((filePath) => matchesPath(dependency.after, filePath)),
    );
    for (const before of beforeBatches) {
      for (const after of afterBatches) {
        if (before === after || after.dependsOn.includes(before.id)) continue;
        after.dependsOn.push(before.id);
      }
    }
  }
  for (const batch of batches) {
    batch.dependsOn.sort();
    for (const filePath of batch.files) {
      if (batchFor(filePath) !== batch) throw new Error(`File ${filePath} belongs to two batches.`);
    }
  }
}

function inManifestScope(filePath: string, manifest: MigrationCampaignManifest): boolean {
  return (
    manifest.includePaths.some((pattern) => matchesPath(pattern, filePath)) &&
    !manifest.excludePaths.some((pattern) => matchesPath(pattern, filePath))
  );
}

export function matchesPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  const source = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DOUBLE_STAR__/g, '.*');
  const suffix =
    /[*?]/.test(normalizedPattern) || normalizedPattern.includes('.') ? '' : '(?:/.*)?';
  return new RegExp(`^${source}${suffix}$`).test(filePath);
}

function validRepositoryPath(filePath: string): boolean {
  return Boolean(filePath && !filePath.startsWith('/') && !filePath.split('/').includes('..'));
}

async function requireCampaign(
  store: MigrationCampaignStore,
  campaignId: string,
): Promise<MigrationCampaign> {
  const campaign = await store.load(campaignId);
  if (!campaign) throw new Error(`Migration campaign ${campaignId} does not exist.`);
  return campaign;
}

export async function saveCampaign(
  store: MigrationCampaignStore,
  campaign: MigrationCampaign,
): Promise<MigrationCampaign> {
  const next = {
    ...campaign,
    version: campaign.version + 1,
    updatedAt: Date.now(),
  };
  await store.save(next, campaign.version);
  return next;
}
