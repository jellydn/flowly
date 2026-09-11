import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveStageCapabilities } from './capabilities.ts';
import { assertWorkspacePath } from './capability-guard.ts';
import { assertFactoryBranch, type FactoryGitWorkspace } from './git.ts';
import type { FactoryGitMutator } from './implementation.ts';
import {
  FACTORY_WORKSPACE_STATES,
  type FactoryWorkspace,
  type FactoryWorkspaceState,
  type FactoryWorkspaceStore,
} from './workspace-store.ts';

export { FACTORY_WORKSPACE_STATES, type FactoryWorkspace, type FactoryWorkspaceState };

const ACTIVE_STATES = new Set<FactoryWorkspaceState>([
  'requested',
  'allocated',
  'hydrated',
  'active',
  'suspended',
]);

const TERMINAL_STATES = new Set<FactoryWorkspaceState>([
  'completed',
  'failed',
  'cancelled',
  'retained-for-debugging',
]);

export type FactoryWorkspaceRetentionPolicy = {
  completedMs: number;
  failedMs: number;
  cancelledMs: number;
  debugMs: number;
};

export const DEFAULT_WORKSPACE_RETENTION: FactoryWorkspaceRetentionPolicy = {
  completedMs: 60 * 60_000,
  failedMs: 24 * 60 * 60_000,
  cancelledMs: 60 * 60_000,
  debugMs: 7 * 24 * 60 * 60_000,
};

export type FactoryWorkspaceEventType =
  | 'workspace.allocated'
  | 'workspace.hydrated'
  | 'workspace.activated'
  | 'workspace.suspended'
  | 'workspace.resumed'
  | 'workspace.completed'
  | 'workspace.failed'
  | 'workspace.cancelled'
  | 'workspace.retained'
  | 'workspace.cleaned';

export type FactoryWorkspaceEvent = {
  type: FactoryWorkspaceEventType;
  workspaceId: string;
  runId: string;
  timestamp: number;
  summary: string;
  metadata: Record<string, unknown>;
};

export type FactoryWorkspaceEventSink = {
  emit(event: FactoryWorkspaceEvent): Promise<void>;
};

export type FactoryWorkspaceGit = FactoryGitMutator & {
  resolveSha?(workspace: FactoryGitWorkspace, rev?: string): Promise<string>;
};

export type FactoryWorkspaceManagerOptions = {
  git: FactoryWorkspaceGit;
  store: FactoryWorkspaceStore;
  workspaceRoot: string;
  repositoryId: string;
  retention?: FactoryWorkspaceRetentionPolicy;
  events?: FactoryWorkspaceEventSink;
  now?: () => number;
  removePath?: (directory: string) => Promise<void>;
};

export function workspaceIdFor(runId: string, attempt: number): string {
  return attempt <= 1 ? runId : `${runId}-a${attempt}`;
}

/**
 * Trusted allocation and GC boundary for isolated factory clones. Writable
 * workspaces are created only here, owned by exactly one run/attempt, and
 * revalidated before mutation.
 */
export class FactoryWorkspaceManager implements FactoryGitMutator {
  private readonly git: FactoryWorkspaceGit;
  private readonly store: FactoryWorkspaceStore;
  private readonly workspaceRoot: string;
  private readonly repositoryId: string;
  private readonly retention: FactoryWorkspaceRetentionPolicy;
  private readonly events: FactoryWorkspaceEventSink;
  private readonly now: () => number;
  private readonly removePath: (directory: string) => Promise<void>;

  constructor(options: FactoryWorkspaceManagerOptions) {
    this.git = options.git;
    this.store = options.store;
    this.workspaceRoot = options.workspaceRoot;
    this.repositoryId = options.repositoryId;
    this.retention = options.retention ?? DEFAULT_WORKSPACE_RETENTION;
    this.events = options.events ?? { async emit() {} };
    this.now = options.now ?? Date.now;
    this.removePath =
      options.removePath ?? ((directory) => rm(directory, { recursive: true, force: true }));
  }

  async createWorkspace(
    id: string,
    branch: string,
    baseRef?: string,
  ): Promise<FactoryGitWorkspace> {
    const record = await this.allocate({
      runId: id,
      attempt: 1,
      branch,
      baseRef: baseRef ?? 'origin/main',
    });
    return this.toGitWorkspace(record);
  }

  async commit(
    workspace: FactoryGitWorkspace,
    message: string,
  ): Promise<{ commitSha: string; changedFiles: string[] }> {
    await this.assertUsable(workspace);
    return this.git.commit(workspace, message);
  }

  async push(workspace: FactoryGitWorkspace, commitSha: string): Promise<void> {
    await this.assertUsable(workspace);
    await this.git.push(workspace, commitSha);
  }

  async isPristine(workspace: FactoryGitWorkspace, commitSha: string): Promise<boolean> {
    await this.assertUsable(workspace);
    return this.git.isPristine(workspace, commitSha);
  }

  async complete(id: string): Promise<void> {
    await this.finish(id, 'completed', this.retention.completedMs, 'workspace.completed');
  }

  async fail(id: string): Promise<void> {
    await this.finish(id, 'failed', this.retention.failedMs, 'workspace.failed');
  }

  async cancel(id: string): Promise<void> {
    await this.finish(id, 'cancelled', this.retention.cancelledMs, 'workspace.cancelled');
  }

  async suspend(id: string): Promise<FactoryWorkspace> {
    const current = await this.require(id);
    this.assertNotCleaning(current);
    if (current.state === 'suspended') return current;
    this.assertTransition(current, ['allocated', 'hydrated', 'active']);
    const next = await this.save({
      ...current,
      state: 'suspended',
      lastUsedAt: this.now(),
    });
    await this.emit('workspace.suspended', next, 'Workspace suspended for later resume.');
    return next;
  }

  async resume(id: string, expected: { runId: string; branch: string; repositoryId: string }) {
    const current = await this.require(id);
    this.assertNotCleaning(current);
    if (current.runId !== expected.runId || current.repositoryId !== expected.repositoryId) {
      throw new Error(`Factory workspace ${id} belongs to another run or repository.`);
    }
    if (current.branch !== expected.branch) {
      throw new Error(`Factory workspace ${id} is on ${current.branch}, not ${expected.branch}.`);
    }
    if (current.state === 'cleaned') {
      throw new Error(`Factory workspace ${id} has already been cleaned.`);
    }
    const gitWorkspace = await this.git.createWorkspace(
      current.id,
      current.branch,
      current.baseRef,
    );
    await this.assertUsable(gitWorkspace, current);
    if (current.baseSha) {
      const sha = await this.git.resolveSha?.(gitWorkspace, current.baseRef);
      if (sha && sha !== current.baseSha) {
        throw new Error(
          `Factory workspace ${id} base moved from ${current.baseSha} to ${sha}; refusing silent rehydrate.`,
        );
      }
    }
    const next = await this.save({
      ...current,
      state: 'active',
      lastUsedAt: this.now(),
    });
    await this.emit('workspace.resumed', next, 'Workspace resumed after ownership checks.');
    return this.toGitWorkspace(next);
  }

  async retainForDebugging(id: string): Promise<FactoryWorkspace> {
    const current = await this.require(id);
    this.assertNotCleaning(current);
    this.assertTransition(current, ['completed', 'failed', 'cancelled', 'active', 'suspended']);
    const now = this.now();
    const next = await this.save({
      ...current,
      state: 'retained-for-debugging',
      lastUsedAt: now,
      retentionUntil: now + this.retention.debugMs,
    });
    await this.emit('workspace.retained', next, 'Workspace retained for debugging.');
    return next;
  }

  async allocate(input: {
    runId: string;
    attempt: number;
    branch: string;
    baseRef: string;
  }): Promise<FactoryWorkspace> {
    assertFactoryBranch(input.branch);
    const existing = await this.store.findByRunAttempt(input.runId, input.attempt);
    if (existing && existing.state !== 'cleaned') {
      if (existing.repositoryId !== this.repositoryId) {
        throw new Error(`Factory workspace ${existing.id} belongs to another repository.`);
      }
      if (existing.branch !== input.branch) {
        throw new Error(
          `Factory workspace ${existing.id} already owns ${existing.branch}, not ${input.branch}.`,
        );
      }
      if (existing.baseRef !== input.baseRef && existing.baseSha) {
        throw new Error(
          `Factory workspace ${existing.id} is hydrated from ${existing.baseRef} and cannot silently change base.`,
        );
      }
      try {
        const gitWorkspace = await this.git.createWorkspace(
          existing.id,
          existing.branch,
          existing.baseRef,
        );
        await this.assertUsable(gitWorkspace, existing);
        const next =
          existing.state === 'active'
            ? await this.touch(existing)
            : await this.save({
                ...existing,
                state: 'active',
                lastUsedAt: this.now(),
              });
        if (existing.state !== 'active') {
          await this.emit(
            'workspace.resumed',
            next,
            'Existing workspace reused for the same attempt.',
          );
        }
        return next;
      } catch (error) {
        if (isVersionConflict(error)) return this.allocate(input);
        throw error;
      }
    }

    const id = workspaceIdFor(input.runId, input.attempt);
    const claimed = await this.store.findByRunAttempt(input.runId, input.attempt);
    if (claimed && claimed.id !== id && ACTIVE_STATES.has(claimed.state)) {
      throw new Error(`Factory run ${input.runId} already has an active workspace.`);
    }

    const now = this.now();
    let record: FactoryWorkspace = {
      id,
      runId: input.runId,
      attempt: input.attempt,
      repositoryId: this.repositoryId,
      path: path.join(this.workspaceRoot, id),
      baseRef: input.baseRef,
      baseSha: '',
      branch: input.branch,
      state: 'requested',
      version: 1,
      createdAt: now,
      lastUsedAt: now,
    };
    try {
      await this.store.save(record, 0);
    } catch (error) {
      const raced = await this.store.findByRunAttempt(input.runId, input.attempt);
      if (raced) return this.allocate(input);
      throw error;
    }
    record = await this.save({ ...record, state: 'allocated' });
    await this.emit('workspace.allocated', record, 'Workspace path allocated.');

    const gitWorkspace = await this.git.createWorkspace(record.id, record.branch, record.baseRef);
    const baseSha =
      (await this.git.resolveSha?.(gitWorkspace, record.baseRef)) ??
      (await this.git.resolveSha?.(gitWorkspace, 'HEAD')) ??
      '';
    record = await this.save({
      ...record,
      path: gitWorkspace.path,
      baseSha,
      state: 'hydrated',
      lastUsedAt: this.now(),
    });
    await this.emit('workspace.hydrated', record, `Workspace hydrated from ${record.baseRef}.`);
    await this.assertUsable(gitWorkspace, record);
    record = await this.save({ ...record, state: 'active', lastUsedAt: this.now() });
    await this.emit('workspace.activated', record, 'Workspace is active for implementation.');
    return record;
  }

  async collectGarbage(now = this.now()): Promise<FactoryWorkspace[]> {
    const candidates = (await this.store.list())
      .filter((workspace) => this.isGcCandidate(workspace, now))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const cleaned: FactoryWorkspace[] = [];
    for (const candidate of candidates) {
      const latest = await this.store.load(candidate.id);
      if (!latest || !this.isGcCandidate(latest, now)) continue;
      cleaned.push(await this.clean(latest));
    }
    return cleaned;
  }

  private isGcCandidate(workspace: FactoryWorkspace, now: number): boolean {
    if (ACTIVE_STATES.has(workspace.state)) return false;
    if (workspace.state === 'cleaned') return false;
    if (!TERMINAL_STATES.has(workspace.state)) return false;
    const until = workspace.retentionUntil ?? workspace.lastUsedAt;
    return until <= now;
  }

  private async clean(workspace: FactoryWorkspace): Promise<FactoryWorkspace> {
    const owners = (await this.store.list()).filter(
      (item) =>
        item.path === workspace.path && item.id !== workspace.id && ACTIVE_STATES.has(item.state),
    );
    if (owners.length > 0) {
      throw new Error(`Factory workspace ${workspace.id} shares a path with an active run.`);
    }
    const cleaning = await this.save({
      ...workspace,
      cleanupAttempt: (workspace.cleanupAttempt ?? 0) + 1,
      lastUsedAt: this.now(),
    });
    await this.removePath(cleaning.path);
    const cleaned = await this.save({ ...cleaning, state: 'cleaned', lastUsedAt: this.now() });
    await this.emit('workspace.cleaned', cleaned, 'Expired workspace removed.');
    return cleaned;
  }

  private async finish(
    id: string,
    state: 'completed' | 'failed' | 'cancelled',
    retentionMs: number,
    type: FactoryWorkspaceEventType,
  ): Promise<FactoryWorkspace> {
    const current = await this.require(id);
    if (current.state === state) return current;
    this.assertNotCleaning(current);
    this.assertTransition(current, ['active', 'suspended', 'hydrated', 'allocated', state]);
    const now = this.now();
    const next = await this.save({
      ...current,
      state,
      lastUsedAt: now,
      retentionUntil: now + retentionMs,
    });
    await this.emit(type, next, `Workspace marked ${state}.`);
    return next;
  }

  private async assertUsable(
    workspace: FactoryGitWorkspace,
    record?: FactoryWorkspace,
  ): Promise<void> {
    const current = record ?? (await this.require(workspace.id));
    if (current.repositoryId !== this.repositoryId) {
      throw new Error(`Factory workspace ${current.id} belongs to another repository.`);
    }
    this.assertNotCleaning(current);
    assertFactoryBranch(workspace.branch);
    if (workspace.branch !== current.branch) {
      throw new Error(
        `Factory workspace ${current.id} is on ${workspace.branch}, not ${current.branch}.`,
      );
    }
    const root = await realpath(this.workspaceRoot);
    if (current.state !== 'requested' && current.state !== 'allocated') {
      try {
        await realpath(workspace.path);
      } catch {
        throw new Error(`Factory workspace ${current.id} is stale; its directory is missing.`);
      }
    }
    await assertWorkspacePath(resolveStageCapabilities('implementer'), root, workspace.path);
  }

  private assertNotCleaning(workspace: FactoryWorkspace): void {
    if (workspace.state === 'cleaned') {
      throw new Error(`Factory workspace ${workspace.id} has already been cleaned.`);
    }
    if ((workspace.cleanupAttempt ?? 0) > 0) {
      throw new Error(`Factory workspace ${workspace.id} cleanup has already begun.`);
    }
  }

  private assertTransition(workspace: FactoryWorkspace, allowed: FactoryWorkspaceState[]): void {
    if (!allowed.includes(workspace.state)) {
      throw new Error(
        `Factory workspace ${workspace.id} is ${workspace.state}; expected ${allowed.join(' or ')}.`,
      );
    }
  }

  private async require(id: string): Promise<FactoryWorkspace> {
    const workspace = await this.store.load(id);
    if (!workspace) throw new Error(`Factory workspace ${id} does not exist.`);
    return workspace;
  }

  private async touch(workspace: FactoryWorkspace): Promise<FactoryWorkspace> {
    return this.save({ ...workspace, lastUsedAt: this.now() });
  }

  private async save(workspace: FactoryWorkspace): Promise<FactoryWorkspace> {
    const next = { ...workspace, version: workspace.version + 1 };
    await this.store.save(next, workspace.version);
    return next;
  }

  private toGitWorkspace(workspace: FactoryWorkspace): FactoryGitWorkspace {
    return {
      id: workspace.id,
      path: workspace.path,
      branch: workspace.branch,
      baseRef: workspace.baseRef,
    };
  }

  private async emit(
    type: FactoryWorkspaceEventType,
    workspace: FactoryWorkspace,
    summary: string,
  ): Promise<void> {
    await this.events.emit({
      type,
      workspaceId: workspace.id,
      runId: workspace.runId,
      timestamp: this.now(),
      summary,
      metadata: {
        state: workspace.state,
        attempt: workspace.attempt,
        branch: workspace.branch,
        baseRef: workspace.baseRef,
        baseSha: workspace.baseSha,
        path: workspace.path,
        retentionUntil: workspace.retentionUntil,
      },
    });
  }
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('changed concurrently');
}
