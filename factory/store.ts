import type { FactoryRun } from './types.ts';

export type FactoryRunStore = {
  load(id: string): Promise<FactoryRun | null>;
  save(run: FactoryRun, expectedVersion: number): Promise<void>;
  findByIssue(repository: string, issueNumber: number): Promise<FactoryRun | null>;
};

/** In-memory persistence for tests; production storage can implement this narrow contract. */
export class MemoryFactoryRunStore implements FactoryRunStore {
  private readonly runs = new Map<string, FactoryRun>();

  async load(id: string): Promise<FactoryRun | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async save(run: FactoryRun, expectedVersion: number): Promise<void> {
    const current = this.runs.get(run.id);
    if ((current?.version ?? 0) !== expectedVersion) {
      throw new Error(`Factory run ${run.id} changed concurrently.`);
    }
    this.runs.set(run.id, structuredClone(run));
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
