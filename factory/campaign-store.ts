import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMigrationCampaign } from './campaign-schema.ts';
import type { MigrationCampaign } from './campaign-types.ts';

export type MigrationCampaignStore = {
  load(id: string): Promise<MigrationCampaign | null>;
  createOrGet(
    campaign: MigrationCampaign,
  ): Promise<{ campaign: MigrationCampaign; created: boolean }>;
  save(campaign: MigrationCampaign, expectedVersion: number): Promise<void>;
};

export class MemoryMigrationCampaignStore implements MigrationCampaignStore {
  private readonly campaigns = new Map<string, MigrationCampaign>();

  async load(id: string): Promise<MigrationCampaign | null> {
    const campaign = this.campaigns.get(id);
    return campaign ? structuredClone(campaign) : null;
  }

  async createOrGet(campaign: MigrationCampaign) {
    const existing = this.campaigns.get(campaign.id);
    if (existing) return { campaign: structuredClone(existing), created: false };
    this.campaigns.set(campaign.id, structuredClone(campaign));
    return { campaign: structuredClone(campaign), created: true };
  }

  async save(campaign: MigrationCampaign, expectedVersion: number): Promise<void> {
    const current = this.campaigns.get(campaign.id);
    assertCampaignVersion(campaign, expectedVersion, current?.version ?? 0);
    this.campaigns.set(campaign.id, structuredClone(campaign));
  }
}

export class FileMigrationCampaignStore implements MigrationCampaignStore {
  private readonly campaignOperations = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async load(id: string): Promise<MigrationCampaign | null> {
    try {
      return parseMigrationCampaign(JSON.parse(await readFile(this.filePath(id), 'utf8')));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createOrGet(campaign: MigrationCampaign) {
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(this.filePath(campaign.id), `${JSON.stringify(campaign, null, 2)}\n`, {
        flag: 'wx',
      });
      return { campaign: structuredClone(campaign), created: true };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await this.load(campaign.id);
      if (!existing) throw new Error(`Migration campaign ${campaign.id} could not be read.`);
      return { campaign: existing, created: false };
    }
  }

  async save(campaign: MigrationCampaign, expectedVersion: number): Promise<void> {
    await this.withCampaignOperation(campaign.id, async () => {
      const current = await this.load(campaign.id);
      assertCampaignVersion(campaign, expectedVersion, current?.version ?? 0);
      const temporary = `${this.filePath(campaign.id)}.tmp`;
      await mkdir(this.directory, { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(campaign, null, 2)}\n`);
        await rename(temporary, this.filePath(campaign.id));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }

  private filePath(id: string): string {
    return path.join(this.directory, `${encodeURIComponent(id)}.json`);
  }

  private async withCampaignOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.campaignOperations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.campaignOperations.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.campaignOperations.get(id) === current) this.campaignOperations.delete(id);
    }
  }
}

function assertCampaignVersion(
  campaign: MigrationCampaign,
  expectedVersion: number,
  actualVersion: number,
): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Migration campaign ${campaign.id} changed concurrently (expected ${expectedVersion}, found ${actualVersion}).`,
    );
  }
  if (campaign.version !== expectedVersion + 1) {
    throw new Error(
      `Migration campaign ${campaign.id} must advance to version ${expectedVersion + 1}.`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
