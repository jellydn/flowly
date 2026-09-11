import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as v from 'valibot';

export const FACTORY_WORKSPACE_STATES = [
  'requested',
  'allocated',
  'hydrated',
  'active',
  'suspended',
  'completed',
  'failed',
  'cancelled',
  'retained-for-debugging',
  'cleaned',
] as const;
export type FactoryWorkspaceState = (typeof FACTORY_WORKSPACE_STATES)[number];

export type FactoryWorkspace = {
  id: string;
  runId: string;
  attempt: number;
  repositoryId: string;
  path: string;
  baseRef: string;
  baseSha: string;
  branch: string;
  state: FactoryWorkspaceState;
  version: number;
  createdAt: number;
  lastUsedAt: number;
  retentionUntil?: number;
  cleanupAttempt?: number;
};

export type FactoryWorkspaceStore = {
  load(id: string): Promise<FactoryWorkspace | null>;
  save(workspace: FactoryWorkspace, expectedVersion: number): Promise<void>;
  findByRunAttempt(runId: string, attempt: number): Promise<FactoryWorkspace | null>;
  list(): Promise<FactoryWorkspace[]>;
};

const workspaceSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  runId: v.pipe(v.string(), v.minLength(1)),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1)),
  repositoryId: v.pipe(v.string(), v.minLength(1)),
  path: v.pipe(v.string(), v.minLength(1)),
  baseRef: v.pipe(v.string(), v.minLength(1)),
  baseSha: v.string(),
  branch: v.pipe(v.string(), v.minLength(1)),
  state: v.picklist(
    FACTORY_WORKSPACE_STATES as unknown as [FactoryWorkspaceState, ...FactoryWorkspaceState[]],
  ),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lastUsedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  retentionUntil: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  cleanupAttempt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export function parseFactoryWorkspace(value: unknown): FactoryWorkspace {
  return v.parse(workspaceSchema, value);
}

export function assertWorkspaceVersion(
  workspace: FactoryWorkspace,
  expectedVersion: number,
  actualVersion: number,
): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Factory workspace ${workspace.id} changed concurrently (expected version ${expectedVersion}, found ${actualVersion}).`,
    );
  }
  if (workspace.version !== expectedVersion + 1) {
    throw new Error(
      `Factory workspace ${workspace.id} must advance to version ${expectedVersion + 1}.`,
    );
  }
}

function attemptKey(runId: string, attempt: number): string {
  return `${runId}:${attempt}`;
}

export class MemoryFactoryWorkspaceStore implements FactoryWorkspaceStore {
  private readonly workspaces = new Map<string, FactoryWorkspace>();
  private readonly attempts = new Map<string, string>();

  async load(id: string): Promise<FactoryWorkspace | null> {
    const workspace = this.workspaces.get(id);
    return workspace ? structuredClone(workspace) : null;
  }

  async save(workspace: FactoryWorkspace, expectedVersion: number): Promise<void> {
    const current = this.workspaces.get(workspace.id);
    assertWorkspaceVersion(workspace, expectedVersion, current?.version ?? 0);
    this.workspaces.set(workspace.id, structuredClone(workspace));
    this.attempts.set(attemptKey(workspace.runId, workspace.attempt), workspace.id);
  }

  async findByRunAttempt(runId: string, attempt: number): Promise<FactoryWorkspace | null> {
    const id = this.attempts.get(attemptKey(runId, attempt));
    return id ? this.load(id) : null;
  }

  async list(): Promise<FactoryWorkspace[]> {
    return [...this.workspaces.values()].map((workspace) => structuredClone(workspace));
  }
}

export class FileFactoryWorkspaceStore implements FactoryWorkspaceStore {
  constructor(private readonly directory: string) {}

  async load(id: string): Promise<FactoryWorkspace | null> {
    return readWorkspaceFile(this.filePath(id));
  }

  async save(workspace: FactoryWorkspace, expectedVersion: number): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const current = await this.load(workspace.id);
    assertWorkspaceVersion(workspace, expectedVersion, current?.version ?? 0);
    await writeAtomicJson(this.filePath(workspace.id), workspace);
  }

  async findByRunAttempt(runId: string, attempt: number): Promise<FactoryWorkspace | null> {
    const workspaces = await this.list();
    return (
      workspaces.find((workspace) => workspace.runId === runId && workspace.attempt === attempt) ??
      null
    );
  }

  async list(): Promise<FactoryWorkspace[]> {
    try {
      const names = await readdir(this.directory);
      const workspaces: FactoryWorkspace[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const workspace = await readWorkspaceFile(path.join(this.directory, name));
        if (workspace) workspaces.push(workspace);
      }
      return workspaces;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private filePath(id: string): string {
    return path.join(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

async function readWorkspaceFile(filePath: string): Promise<FactoryWorkspace | null> {
  try {
    return parseFactoryWorkspace(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeAtomicJson(filePath: string, workspace: FactoryWorkspace): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(workspace, null, 2)}\n`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
