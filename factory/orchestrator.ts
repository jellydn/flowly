import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyFactoryAutonomyEvent, decideFactoryAutonomyGate } from './autonomy.ts';
import type { FactoryCapabilityAudit } from './capabilities.ts';
import { appendFactoryEvents, eventsForRunTransition } from './events.ts';
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
  type FactoryAutonomyPolicy,
  type FactoryManualConfirmation,
  type FactoryRunExecution,
} from './types.ts';

/** Another live process holds the implementation lease. Callers must not touch its workspace. */
export class FactoryLeaseHeldError extends Error {
  constructor(id: string, until: number) {
    super(
      `Factory run ${id} is being implemented by another process until ${new Date(until).toISOString()}.`,
    );
    this.name = 'FactoryLeaseHeldError';
  }
}

/**
 * Trusted factory state boundary. It creates one run per issue and permits only
 * monotonic stage transitions, preventing duplicate deliveries from creating
 * another branch or PR.
 */
export class FactoryOrchestrator {
  /** Identifies this process as an implementation lease holder. */
  readonly holder: string;
  private readonly now: () => number;

  constructor(
    private readonly store: FactoryRunStore,
    options: { holder?: string; now?: () => number } = {},
  ) {
    this.holder = options.holder ?? randomUUID();
    this.now = options.now ?? Date.now;
  }

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
    run.events = appendFactoryEvents([], eventsForRunTransition(undefined, run));
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

  async recordCapabilityAudit(id: string, audit: FactoryCapabilityAudit): Promise<FactoryRun> {
    const run = await this.get(id);
    if (run.capabilities) {
      if (isDeepStrictEqual(run.capabilities, audit)) return run;
      throw new Error(`Factory run ${id} already has a capability audit.`);
    }
    return this.save({ ...run, capabilities: audit });
  }

  async recordAutonomyGate(
    id: string,
    boundary: FactoryAutonomyBoundary,
    decision: { allowed: boolean; manualConfirmation: boolean; reason: string },
  ): Promise<FactoryRun> {
    const run = await this.get(id);
    if (!run.autonomy) throw new Error(`Factory run ${id} has no autonomy audit.`);
    const existing = run.autonomy.gateDecisions.find((item) => item.boundary === boundary);
    // One-run confirmation remains valid on retry. Failure events revoke it through applyAutonomyEvent.
    if (existing?.allowed || (existing && !decision.allowed)) return run;
    const gateDecisions = run.autonomy.gateDecisions.filter((item) => item.boundary !== boundary);
    gateDecisions.push({ ...decision, boundary, decidedAt: Date.now() });
    return this.save({ ...run, autonomy: { ...run.autonomy, gateDecisions } });
  }

  async applyAutonomyEvent(
    id: string,
    event: FactoryAutonomyEvent,
    policy: FactoryAutonomyPolicy | undefined,
    confirmation: FactoryManualConfirmation | undefined,
    boundary?: FactoryAutonomyBoundary,
  ): Promise<FactoryRun> {
    const run = await this.get(id);
    if (!run.autonomy) throw new Error(`Factory run ${id} has no autonomy audit.`);
    if (run.autonomyEvents?.includes(event) && run.autonomy.evidence.events.includes(event)) {
      return run;
    }

    let autonomy = applyFactoryAutonomyEvent(run.autonomy, policy, event);
    if (boundary) {
      const decision = decideFactoryAutonomyGate(autonomy, boundary, confirmation);
      const existing = autonomy.gateDecisions.find((item) => item.boundary === boundary);
      const decidedAt =
        existing &&
        existing.allowed === decision.allowed &&
        existing.manualConfirmation === decision.manualConfirmation &&
        existing.reason === decision.reason
          ? existing.decidedAt
          : Date.now();
      autonomy = {
        ...autonomy,
        gateDecisions: [
          ...autonomy.gateDecisions.filter((item) => item.boundary !== boundary),
          { ...decision, boundary, decidedAt },
        ],
      };
    }
    return this.save({
      ...run,
      autonomy,
      autonomyEvents: [...new Set([...(run.autonomyEvents ?? []), event])],
    });
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

  /**
   * Claims planned → implementing with an exclusive lease. The holder may call
   * it again. Another process gets FactoryLeaseHeldError while the lease is
   * live; after expiry it reclaims the run with the next attempt number.
   */
  async beginImplementation(id: string): Promise<FactoryRun> {
    const run = await this.requireState(id, ['planned', 'implementing'], []);
    if (run.implementationLease?.holder === this.holder && run.state === 'implementing') {
      return run;
    }
    this.assertImplementationLeaseFree(run);
    try {
      return await this.save({
        ...run,
        state: 'implementing',
        branch:
          run.branch ?? factoryBranch(run.task.issueNumber, run.task.title, run.task.campaign),
        implementationLease: {
          holder: this.holder,
          attempt: (run.implementationLease?.attempt ?? 0) + 1,
          startedAt: this.now(),
        },
      });
    } catch (error) {
      if (!isVersionConflict(error)) throw error;
      this.assertImplementationLeaseFree(await this.get(id));
      throw error;
    }
  }

  /** Record the executor environment of the current implementation attempt. Lease holder only. */
  async recordExecution(
    id: string,
    execution: Omit<FactoryRunExecution, 'attempt'>,
  ): Promise<FactoryRun> {
    const run = await this.requireState(id, ['implementing'], []);
    const lease = run.implementationLease;
    if (lease?.holder !== this.holder) {
      throw new Error(
        `Factory run ${id} cannot record execution without its implementation lease.`,
      );
    }
    const next: FactoryRunExecution = { ...execution, attempt: lease.attempt };
    if (isDeepStrictEqual(run.execution, next)) return run;
    return this.save({ ...run, execution: next });
  }

  private assertImplementationLeaseFree(run: FactoryRun): void {
    const lease = run.implementationLease;
    if (run.state !== 'implementing' || !lease || lease.holder === this.holder) return;
    const until = lease.startedAt + IMPLEMENTATION_LEASE_MS;
    if (this.now() < until) throw new FactoryLeaseHeldError(run.id, until);
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
    const previous = await this.store.load(run.id);
    if (!previous) throw new Error(`Factory run ${run.id} does not exist.`);
    const next = { ...run, version: run.version + 1, updatedAt: Date.now() };
    next.events = appendFactoryEvents(
      previous.events ?? [],
      eventsForRunTransition(previous, next),
    );
    await this.store.save(next, run.version);
    return next;
  }
}

/**
 * How long an `implementing` claim is exclusive. It exceeds the implementer's
 * 20-minute timeout, so a live attempt is never taken over.
 */
export const IMPLEMENTATION_LEASE_MS = 30 * 60_000;

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
