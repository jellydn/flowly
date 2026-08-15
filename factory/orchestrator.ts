import { randomUUID } from 'node:crypto';
import type { FactoryRunStore } from './store.ts';
import {
  factoryBranch,
  type FactoryRun,
  type FactoryTask,
  type ImplementationPlan,
  type TaskClassification,
} from './types.ts';

/**
 * Trusted factory state boundary. It creates one run per issue and permits only
 * monotonic stage transitions, preventing duplicate deliveries from creating
 * another branch or PR.
 */
export class FactoryOrchestrator {
  constructor(private readonly store: FactoryRunStore) {}

  async start(task: FactoryTask): Promise<{ run: FactoryRun; duplicate: boolean }> {
    const existing = await this.store.findByIssue(task.repository, task.issueNumber);
    if (existing) return { run: existing, duplicate: true };
    const now = Date.now();
    const run: FactoryRun = {
      id: randomUUID(), task, state: 'queued', version: 1, updatedAt: now,
    };
    await this.store.save(run, 0);
    return { run, duplicate: false };
  }

  async classify(id: string, classification: TaskClassification): Promise<FactoryRun> {
    const run = await this.requireState(id, 'queued');
    return this.save({
      ...run,
      classification,
      state: classification.actionable ? 'classified' : 'needs-input',
    });
  }

  async plan(id: string, plan: ImplementationPlan): Promise<FactoryRun> {
    const run = await this.requireState(id, 'classified');
    return this.save({ ...run, plan, state: 'planned' });
  }

  async beginImplementation(id: string): Promise<FactoryRun> {
    const run = await this.requireState(id, 'planned');
    return this.save({ ...run, state: 'implementing', branch: factoryBranch(run.task.issueNumber, run.task.title) });
  }

  private async requireState(id: string, state: FactoryRun['state']): Promise<FactoryRun> {
    const run = await this.store.load(id);
    if (!run) throw new Error(`Factory run ${id} does not exist.`);
    if (run.state !== state) throw new Error(`Factory run ${id} is ${run.state}; expected ${state}.`);
    return run;
  }

  private async save(run: FactoryRun): Promise<FactoryRun> {
    const next = { ...run, version: run.version + 1, updatedAt: Date.now() };
    await this.store.save(next, run.version);
    return next;
  }
}
