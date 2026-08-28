import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFactoryRun } from './schema.ts';
import type { FactoryRun } from './types.ts';

export type FactoryRunStore = {
  load(id: string): Promise<FactoryRun | null>;
  save(run: FactoryRun, expectedVersion: number): Promise<void>;
  createOrGet(run: FactoryRun): Promise<{ run: FactoryRun; created: boolean }>;
  findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null>;
};

export function assertRunVersion(
  run: FactoryRun,
  expectedVersion: number,
  actualVersion: number,
): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Factory run ${run.id} changed concurrently (expected version ${expectedVersion}, found ${actualVersion}).`,
    );
  }
  if (run.version !== expectedVersion + 1) {
    throw new Error(`Factory run ${run.id} must advance to version ${expectedVersion + 1}.`);
  }
}

export function issueKey(repository: string, issueNumber: number): string {
  return `${repository}:${issueNumber}`;
}

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
    assertRunVersion(run, expectedVersion, current?.version ?? 0);
    this.runs.set(run.id, structuredClone(run));
    this.issueRuns.set(issueKey(run.task.repository, run.task.issueNumber), run.id);
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
    const existingId = this.issueRuns.get(issueKey(repository, issueNumber));
    return existingId ? this.load(existingId) : null;
  }
}

/**
 * One JSON file per issue for local/single-process use. GitHub Actions retries
 * must use {@link createGitHubFactoryRunStore} — a runner disk does not survive
 * a new job.
 */
export class FileFactoryRunStore implements FactoryRunStore {
  private readonly issueOperations = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async load(id: string): Promise<FactoryRun | null> {
    for (const run of await this.readAll()) {
      if (run.id === id) return run;
    }
    return null;
  }

  async findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null> {
    return readRunFile(this.filePath(repository, issueNumber));
  }

  async createOrGet(run: FactoryRun): Promise<{ run: FactoryRun; created: boolean }> {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.filePath(run.task.repository, run.task.issueNumber);
    try {
      await writeFile(filePath, `${JSON.stringify(run, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { run: structuredClone(run), created: true };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await this.findByIssue(run.task.repository, run.task.issueNumber);
      if (!existing)
        throw new Error(`Factory run file for ${filePath} exists but could not be read.`);
      return { run: existing, created: false };
    }
  }

  async save(run: FactoryRun, expectedVersion: number): Promise<void> {
    const key = issueKey(run.task.repository, run.task.issueNumber);
    await this.withIssueOperation(key, async () => {
      const current = await this.findByIssue(run.task.repository, run.task.issueNumber);
      assertRunVersion(run, expectedVersion, current?.version ?? 0);
      if (current && current.id !== run.id) {
        throw new Error(`Factory run ${run.id} does not own issue ${run.task.issueNumber}.`);
      }
      await writeAtomicJson(this.filePath(run.task.repository, run.task.issueNumber), run);
    });
  }

  private filePath(repository: string, issueNumber: number): string {
    return path.join(
      this.directory,
      `${encodeURIComponent(issueKey(repository, issueNumber))}.json`,
    );
  }

  private async readAll(): Promise<FactoryRun[]> {
    try {
      const names = await readdir(this.directory);
      const runs: FactoryRun[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const run = await readRunFile(path.join(this.directory, name));
        if (run) runs.push(run);
      }
      return runs;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async withIssueOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.issueOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.issueOperations.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.issueOperations.get(key) === current) this.issueOperations.delete(key);
    }
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

async function writeAtomicJson(filePath: string, run: FactoryRun): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(run, null, 2)}\n`);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
