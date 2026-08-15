import type { FactoryRun } from './types.ts';

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
