import { randomUUID } from 'node:crypto';
import type { FactoryRunStore } from './store.ts';
import {
  factoryBranch,
  type FactoryRun,
  type FactoryTask,
  type ImplementationResult,
  type ImplementationPlan,
  type ReviewVerdict,
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

  async recordImplementation(id: string, implementation: ImplementationResult): Promise<FactoryRun> {
    const run = await this.requireState(id, ['implementing'], ['verifying']);
    if (run.state === 'verifying') return run;
    if (!run.branch) throw new Error(`Factory run ${id} has no factory-owned branch.`);
    return this.save({ ...run, implementation, state: 'verifying' });
  }

  async recordVerification(id: string, passed: boolean, failure?: string): Promise<FactoryRun> {
    const run = await this.requireState(id, ['verifying'], ['reviewing', 'failed']);
    if (run.state !== 'verifying') return run;
    return this.save({
      ...run,
      state: passed ? 'reviewing' : 'failed',
      ...(passed ? {} : { failure: failure ?? 'Repository verification failed.' }),
    });
  }

  async recordReview(id: string, review: ReviewVerdict): Promise<FactoryRun> {
    const run = await this.requireState(id, ['reviewing'], ['pr-created']);
    if (run.state === 'pr-created') return run;
    if (run.review) {
      if (JSON.stringify(run.review) !== JSON.stringify(review)) {
        throw new Error(`Factory run ${id} already has an independent review verdict.`);
      }
      return run;
    }
    return this.save({ ...run, review });
  }

  async recordDraftPr(id: string, prNumber: number): Promise<FactoryRun> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error('Draft PR number must be a positive integer.');
    }
    const run = await this.requireState(id, ['reviewing'], ['pr-created']);
    if (run.state === 'pr-created') {
      if (run.prNumber !== prNumber) {
        throw new Error(`Factory run ${id} already owns draft PR #${run.prNumber}.`);
      }
      return run;
    }
    if (!run.review) throw new Error(`Factory run ${id} must be independently reviewed first.`);
    return this.save({ ...run, prNumber, state: 'pr-created' });
  }

  async complete(id: string): Promise<FactoryRun> {
    const run = await this.requireState(id, ['pr-created'], ['completed']);
    if (run.state === 'completed') return run;
    return this.save({ ...run, state: 'completed' });
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
