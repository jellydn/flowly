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
    const now = Date.now();
    const run: FactoryRun = {
      id: randomUUID(), task, state: 'queued', version: 1, updatedAt: now,
    };
    const created = await this.store.createOrGet(run);
    return { run: created.run, duplicate: !created.created };
  }

  async classify(id: string, classification: TaskClassification): Promise<FactoryRun> {
    const run = await this.requireState(id, ['queued'], ['classified', 'needs-input']);
    if (run.state !== 'queued') return run;
    return this.save({
      ...run,
      classification,
      state: classification.actionable ? 'classified' : 'needs-input',
    });
  }

  async plan(id: string, plan: ImplementationPlan): Promise<FactoryRun> {
    const run = await this.requireState(id, ['classified'], ['planned']);
    if (run.state === 'planned') return run;
    return this.save({ ...run, plan, state: 'planned' });
  }

  async beginImplementation(id: string): Promise<FactoryRun> {
    const run = await this.requireState(id, ['planned'], ['implementing']);
    if (run.state === 'implementing') return run;
    return this.save({
      ...run,
      state: 'implementing',
      branch: factoryBranch(run.task.issueNumber, run.task.title),
    });
  }

  private async requireState(
    id: string,
    expected: FactoryRun['state'][],
    completed: FactoryRun['state'][],
  ): Promise<FactoryRun> {
    const run = await this.store.load(id);
    if (!run) throw new Error(`Factory run ${id} does not exist.`);
    if (!expected.includes(run.state) && !completed.includes(run.state)) {
      throw new Error(`Factory run ${id} is ${run.state}; expected ${expected.join(' or ')}.`);
    }
    return run;
  }

  private async save(run: FactoryRun): Promise<FactoryRun> {
    const next = { ...run, version: run.version + 1, updatedAt: Date.now() };
    await this.store.save(next, run.version);
    return next;
  }
}
