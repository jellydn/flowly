import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { FACTORY_RUN_STATES, type FactoryRun, type FactoryRunState } from './types.ts';

export type FactoryRunStore = {
  load(id: string): Promise<FactoryRun | null>;
  save(run: FactoryRun, expectedVersion: number): Promise<void>;
  createOrGet(run: FactoryRun): Promise<{ run: FactoryRun; created: boolean }>;
  findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null>;
};

/** In-memory persistence for tests; production storage can implement this narrow contract. */
export class MemoryFactoryRunStore implements FactoryRunStore {
  private readonly runs = new Map<string, FactoryRun>();
  private readonly issueRuns = new Map<string, string>();

  async load(id: string): Promise<FactoryRun | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async save(run: FactoryRun, expectedVersion: number): Promise<void> {
    const current = this.runs.get(run.id);
    const actualVersion = current?.version ?? 0;
    if (actualVersion !== expectedVersion) {
      throw new Error(
        `Factory run ${run.id} changed concurrently (expected version ${expectedVersion}, found ${actualVersion}).`,
      );
    }
    if (run.version !== expectedVersion + 1) {
      throw new Error(`Factory run ${run.id} must advance to version ${expectedVersion + 1}.`);
    }
    this.runs.set(run.id, structuredClone(run));
  }

  async createOrGet(run: FactoryRun): Promise<{ run: FactoryRun; created: boolean }> {
    const key = issueKey(run.task.repository, run.task.issueNumber);
    const existingId = this.issueRuns.get(key);
    if (existingId) return { run: structuredClone(this.runs.get(existingId)!), created: false };
    this.runs.set(run.id, structuredClone(run));
    this.issueRuns.set(key, run.id);
    return { run: structuredClone(run), created: true };
  }

  async findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null> {
    for (const run of this.runs.values()) {
      if (run.task.repository === repository && run.task.issueNumber === issueNumber) {
        return structuredClone(run);
      }
    }
    return null;
  }
}

function issueKey(repository: string, issueNumber: number): string {
  return `${repository}:${issueNumber}`;
}

/**
 * JSON-file persistence so a factory run survives GitHub Actions retries.
 * Duplicate deliveries for the same issue reuse the stored run instead of
 * creating another branch or PR.
 */
export class FileFactoryRunStore implements FactoryRunStore {
  constructor(private readonly directory: string) {}

  async load(id: string): Promise<FactoryRun | null> {
    return readRunFile(this.runPath(id));
  }

  async save(run: FactoryRun, expectedVersion: number): Promise<void> {
    await this.withLock(async () => {
      const current = await this.load(run.id);
      assertRunVersion(run, expectedVersion, current?.version ?? 0);
      await writeRunFile(this.runPath(run.id), run);
    });
  }

  async createOrGet(run: FactoryRun): Promise<{ run: FactoryRun; created: boolean }> {
    return this.withLock(async () => {
      const existingId = await readIssueIndex(
        this.issuePath(run.task.repository, run.task.issueNumber),
      );
      if (existingId) {
        const existing = await this.load(existingId);
        if (!existing) {
          throw new Error(`Factory run index points at missing run ${existingId}.`);
        }
        return { run: existing, created: false };
      }
      await writeRunFile(this.runPath(run.id), run);
      await writeIssueIndex(this.issuePath(run.task.repository, run.task.issueNumber), run.id);
      return { run: structuredClone(run), created: true };
    });
  }

  async findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null> {
    const existingId = await readIssueIndex(this.issuePath(repository, issueNumber));
    return existingId ? this.load(existingId) : null;
  }

  private runPath(id: string): string {
    return path.join(this.directory, 'runs', `${encodeURIComponent(id)}.json`);
  }

  private issuePath(repository: string, issueNumber: number): string {
    return path.join(
      this.directory,
      'issues',
      `${encodeURIComponent(issueKey(repository, issueNumber))}.json`,
    );
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, '.lock');
    const token = await acquireLock(lockPath);
    try {
      return await operation();
    } finally {
      await releaseLock(lockPath, token);
    }
  }
}

function assertRunVersion(run: FactoryRun, expectedVersion: number, actualVersion: number): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Factory run ${run.id} changed concurrently (expected version ${expectedVersion}, found ${actualVersion}).`,
    );
  }
  if (run.version !== expectedVersion + 1) {
    throw new Error(`Factory run ${run.id} must advance to version ${expectedVersion + 1}.`);
  }
}

async function readRunFile(filePath: string): Promise<FactoryRun | null> {
  try {
    return parseFactoryRun(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeRunFile(filePath: string, run: FactoryRun): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(temporaryPath, `${JSON.stringify(run, null, 2)}\n`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readIssueIndex(filePath: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as { runId?: unknown };
    return typeof value.runId === 'string' && value.runId ? value.runId : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeIssueIndex(filePath: string, runId: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(temporaryPath, `${JSON.stringify({ runId })}\n`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseFactoryRun(value: unknown): FactoryRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Factory run snapshot is not an object.');
  }
  const snapshot = value as Partial<FactoryRun>;
  if (typeof snapshot.id !== 'string' || !snapshot.id) {
    throw new Error('Factory run snapshot is missing an id.');
  }
  if (!isFactoryRunState(snapshot.state)) {
    throw new Error(`Factory run snapshot has invalid state "${String(snapshot.state)}".`);
  }
  if (!Number.isInteger(snapshot.version) || (snapshot.version as number) < 0) {
    throw new Error('Factory run snapshot has an invalid version.');
  }
  const task = snapshot.task;
  if (
    !task ||
    typeof task !== 'object' ||
    typeof task.issueNumber !== 'number' ||
    !Number.isInteger(task.issueNumber) ||
    task.issueNumber <= 0 ||
    typeof task.title !== 'string' ||
    typeof task.body !== 'string' ||
    typeof task.repository !== 'string' ||
    !task.repository.includes('/')
  ) {
    throw new Error('Factory run snapshot has an invalid task.');
  }
  return structuredClone(snapshot as FactoryRun);
}

function isFactoryRunState(value: unknown): value is FactoryRunState {
  return typeof value === 'string' && (FACTORY_RUN_STATES as readonly string[]).includes(value);
}

async function acquireLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), {
        encoding: 'utf8',
        flag: 'wx',
      });
      return token;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const owner = parseLockOwner(await readFile(lockPath, 'utf8'));
        if (!isProcessAlive(owner.pid)) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (isNotFound(lockError)) continue;
        throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out acquiring factory run store lock "${lockPath}".`);
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = parseLockOwner(await readFile(lockPath, 'utf8'));
    if (owner.token === token) await rm(lockPath, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function parseLockOwner(raw: string): { pid: number; token: string } {
  const owner = JSON.parse(raw) as { pid?: unknown; token?: unknown };
  if (typeof owner.pid === 'number' && typeof owner.token === 'string' && owner.token) {
    return { pid: owner.pid, token: owner.token };
  }
  throw new Error('Factory run store lock is malformed.');
}

async function writeDurableFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}
