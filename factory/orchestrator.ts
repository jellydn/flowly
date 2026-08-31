import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FactoryRunStore } from './store.ts';
import {
  factoryBranch,
  type FactoryRun,
  type FactoryTask,
  type ImplementationResult,
  type ImplementationPlan,
  type ReviewVerdict,
  type TaskClassification,
  type FactoryAutonomyAudit,
  type FactoryAutonomyBoundary,
  type FactoryAutonomyEvent,
} from './types.ts';

/**
 * Trusted factory state boundary. It creates one run per issue and permits only
 * monotonic stage transitions, preventing duplicate deliveries from creating
 * another branch or PR.
 */
export class FactoryOrchestrator {
  constructor(private readonly store: FactoryRunStore) {}

  /** Load the persisted run. Callers must not treat a stale snapshot as current. */
  async get(id: string): Promise<FactoryRun> {
    const run = await this.store.load(id);
    if (!run) throw new Error(`Factory run ${id} does not exist.`);
    return run;
  }

  async start(task: FactoryTask): Promise<{ run: FactoryRun; duplicate: boolean }> {
    const now = Date.now();
    const run: FactoryRun = {
      id: randomUUID(),
      task,
      state: 'queued',
      version: 1,
      updatedAt: now,
    };
    const created = await this.store.createOrGet(run);
    return { run: created.run, duplicate: !created.created };
  }

  async history(repository: string, excludingRunId?: string): Promise<FactoryRun[]> {
    return (await this.store.listByRepository(repository)).filter(
      (run) => run.id !== excludingRunId,
    );
  }

  async recordAutonomyAudit(id: string, audit: FactoryAutonomyAudit): Promise<FactoryRun> {
    const run = await this.get(id);
    if (run.autonomy) return run;
    return this.save({ ...run, autonomy: audit });
  }

  async recordAutonomyGate(
    id: string,
    boundary: FactoryAutonomyBoundary,
    decision: { allowed: boolean; manualConfirmation: boolean; reason: string },
  ): Promise<FactoryRun> {
    const run = await this.get(id);
    if (!run.autonomy) throw new Error(`Factory run ${id} has no autonomy audit.`);
    const existing = run.autonomy.gateDecisions.find((item) => item.boundary === boundary);
    if (existing?.allowed || (existing && !decision.allowed)) return run;
    const gateDecisions = run.autonomy.gateDecisions.filter((item) => item.boundary !== boundary);
    gateDecisions.push({ ...decision, boundary, decidedAt: Date.now() });
    return this.save({ ...run, autonomy: { ...run.autonomy, gateDecisions } });
  }

  async recordAutonomyEvent(id: string, event: FactoryAutonomyEvent): Promise<FactoryRun> {
    const run = await this.get(id);
    if (run.autonomyEvents?.includes(event)) return run;
    return this.save({ ...run, autonomyEvents: [...(run.autonomyEvents ?? []), event] });
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

  /**
   * Atomically claims classified → planning. A live lease is not stolen.
   * An expired `planning` snapshot (dead worker / retried job) can be reclaimed.
   */
  async beginPlanning(id: string): Promise<{ run: FactoryRun; claimed: boolean }> {
    const run = await this.requireState(id, ['classified', 'planning'], ['planned']);
    if (run.state === 'planned') return { run, claimed: false };
    if (run.state === 'planning' && !planningLeaseExpired(run)) {
      return { run, claimed: false };
    }
    try {
      const saved = await this.save({
        ...run,
        state: 'planning',
        planningStartedAt: Date.now(),
      });
      return { run: saved, claimed: true };
    } catch (error) {
      if (!isVersionConflict(error)) throw error;
      const current = await this.get(id);
      if (current.state === 'planned') return { run: current, claimed: false };
      if (current.state === 'planning' && !planningLeaseExpired(current)) {
        return { run: current, claimed: false };
      }
      throw error;
    }
  }

  async plan(id: string, plan: ImplementationPlan): Promise<FactoryRun> {
    const run = await this.requireState(id, ['classified', 'planning'], ['planned']);
    if (run.state === 'planned') return run;
    return this.save({ ...run, plan, state: 'planned' });
  }

  async beginImplementation(id: string): Promise<FactoryRun> {
    const run = await this.requireState(id, ['planned'], ['implementing']);
    if (run.state === 'implementing') return run;
    return this.save({
      ...run,
      state: 'implementing',
      branch: factoryBranch(run.task.issueNumber, run.task.title, run.task.campaign),
    });
  }

  async recordImplementation(
    id: string,
    implementation: ImplementationResult,
  ): Promise<FactoryRun> {
    const run = await this.requireState(id, ['implementing'], ['verifying']);
    if (run.state === 'verifying') {
      if (isDeepStrictEqual(run.implementation, implementation)) return run;
      if (
        run.implementation &&
        run.implementation.commands.length === 0 &&
        isDeepStrictEqual(
          { ...run.implementation, commands: implementation.commands },
          implementation,
        )
      ) {
        return this.save({ ...run, implementation });
      }
      throw new Error(`Factory run ${id} already has an implementation result.`);
    }
    if (!run.branch) throw new Error(`Factory run ${id} has no factory-owned branch.`);
    return this.save({ ...run, implementation, state: 'verifying' });
  }

  async recordVerification(id: string, passed: boolean, failure?: string): Promise<FactoryRun> {
    const run = await this.requireState(id, ['verifying'], ['reviewing', 'failed']);
    const normalizedFailure = failure ?? 'Repository verification failed.';
    if (run.state !== 'verifying') {
      const matches =
        (run.state === 'reviewing' && passed) ||
        (run.state === 'failed' && !passed && run.failure === normalizedFailure);
      if (!matches) throw new Error(`Factory run ${id} already has a verification result.`);
      return run;
    }
    return this.save({
      ...run,
      state: passed ? 'reviewing' : 'failed',
      ...(passed ? {} : { failure: normalizedFailure }),
    });
  }

  async recordReview(id: string, review: ReviewVerdict): Promise<FactoryRun> {
    const run = await this.requireState(id, ['reviewing'], ['pr-created']);
    if (run.review) {
      if (!isDeepStrictEqual(run.review, review)) {
        throw new Error(`Factory run ${id} already has an independent review verdict.`);
      }
      return run;
    }
    if (run.state === 'pr-created') return run;
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

/** How long a `planning` claim is exclusive before a retried worker may take over. */
export const PLANNING_LEASE_MS = 15 * 60_000;

export function planningLeaseExpired(run: FactoryRun, now = Date.now()): boolean {
  if (run.state !== 'planning') return false;
  const startedAt = run.planningStartedAt ?? 0;
  return now - startedAt >= PLANNING_LEASE_MS;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('changed concurrently');
}
