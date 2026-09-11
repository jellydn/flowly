import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { FactoryGitWorkspace } from '../factory/git.ts';
import {
  FactoryWorkspaceManager,
  type FactoryWorkspaceEvent,
  type FactoryWorkspaceGit,
} from '../factory/workspace-lifecycle.ts';
import { MemoryFactoryWorkspaceStore } from '../factory/workspace-store.ts';

const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FactoryWorkspaceManager', () => {
  test('allocates a workspace once per run/attempt and records hydration', async () => {
    const { manager, store, events, root } = await createManager();
    const first = await manager.allocate({
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    });
    const second = await manager.allocate({
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    });

    assert.equal(first.id, 'run-141');
    assert.equal(first.path, path.join(root, 'run-141'));
    assert.equal(first.baseSha, SHA);
    assert.equal(first.state, 'active');
    assert.equal(second.id, first.id);
    assert.equal((await store.findByRunAttempt('run-141', 1))?.state, 'active');
    assert.deepEqual(
      events.map((event) => event.type),
      ['workspace.allocated', 'workspace.hydrated', 'workspace.activated'],
    );
  });

  test('prevents two runs from sharing a workspace identity', async () => {
    const { manager } = await createManager();
    await manager.allocate({
      runId: 'run-a',
      attempt: 1,
      branch: 'factory/a',
      baseRef: 'origin/main',
    });
    const other = await manager.allocate({
      runId: 'run-b',
      attempt: 1,
      branch: 'factory/b',
      baseRef: 'origin/main',
    });
    assert.equal(other.id, 'run-b');
    assert.notEqual(other.path.endsWith('run-a'), true);
  });

  test('refuses a retry that would silently change the hydrated base', async () => {
    const { manager } = await createManager();
    await manager.allocate({
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    });
    await assert.rejects(
      () =>
        manager.allocate({
          runId: 'run-141',
          attempt: 1,
          branch: 'factory/141-lifecycle',
          baseRef: 'origin/develop',
        }),
      /cannot silently change base/,
    );
  });

  test('concurrent allocation for the same attempt converges on one record', async () => {
    const { manager, store } = await createManager();
    const input = {
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    };
    const [left, right] = await Promise.all([manager.allocate(input), manager.allocate(input)]);
    assert.equal(left.id, right.id);
    const listed = (await store.list()).filter((workspace) => workspace.runId === 'run-141');
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.state, 'active');
  });

  test('suspend and resume revalidate ownership, branch, and repository', async () => {
    const { manager } = await createManager();
    const allocated = await manager.allocate({
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    });
    await manager.suspend(allocated.id);
    await assert.rejects(
      () =>
        manager.resume(allocated.id, {
          runId: 'run-other',
          branch: 'factory/141-lifecycle',
          repositoryId: 'jellydn/flowly',
        }),
      /belongs to another run/,
    );
    await assert.rejects(
      () =>
        manager.resume(allocated.id, {
          runId: 'run-141',
          branch: 'factory/other',
          repositoryId: 'jellydn/flowly',
        }),
      /is on factory\/141-lifecycle/,
    );
    const resumed = await manager.resume(allocated.id, {
      runId: 'run-141',
      branch: 'factory/141-lifecycle',
      repositoryId: 'jellydn/flowly',
    });
    assert.equal(resumed.id, allocated.id);
  });

  test('resume fails after cleanup has begun', async () => {
    const { manager, store } = await createManager({ now: sequentialNow(1_000) });
    const allocated = await manager.allocate({
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    });
    await manager.complete(allocated.id);
    const current = await store.load(allocated.id);
    await store.save(
      { ...current!, cleanupAttempt: 1, version: current!.version + 1 },
      current!.version,
    );
    await assert.rejects(
      () =>
        manager.resume(allocated.id, {
          runId: 'run-141',
          branch: 'factory/141-lifecycle',
          repositoryId: 'jellydn/flowly',
        }),
      /cleanup has already begun/,
    );
  });

  test('garbage collection is deterministic, skips live workspaces, and is idempotent', async () => {
    let now = 1_000;
    const { manager, store, root } = await createManager({
      now: () => now,
      retention: {
        completedMs: 10,
        failedMs: 10,
        cancelledMs: 10,
        debugMs: 50,
      },
    });
    const live = await manager.allocate({
      runId: 'run-live',
      attempt: 1,
      branch: 'factory/live',
      baseRef: 'origin/main',
    });
    const done = await manager.allocate({
      runId: 'run-done',
      attempt: 1,
      branch: 'factory/done',
      baseRef: 'origin/main',
    });
    const failed = await manager.allocate({
      runId: 'run-failed',
      attempt: 1,
      branch: 'factory/failed',
      baseRef: 'origin/main',
    });
    const debug = await manager.allocate({
      runId: 'run-debug',
      attempt: 1,
      branch: 'factory/debug',
      baseRef: 'origin/main',
    });
    await manager.complete(done.id);
    await manager.fail(failed.id);
    await manager.retainForDebugging(debug.id);

    now = 1_020;
    const first = await manager.collectGarbage(now);
    assert.deepEqual(first.map((workspace) => workspace.id).sort(), ['run-done', 'run-failed']);
    assert.equal((await store.load(live.id))?.state, 'active');
    assert.equal((await store.load(debug.id))?.state, 'retained-for-debugging');
    await assert.rejects(() => access(path.join(root, 'run-done')), /ENOENT/);

    const second = await manager.collectGarbage(now);
    assert.deepEqual(second, []);
    assert.equal((await store.load(done.id))?.state, 'cleaned');

    now = 1_080;
    const third = await manager.collectGarbage(now);
    assert.deepEqual(
      third.map((workspace) => workspace.id),
      ['run-debug'],
    );
  });

  test('garbage collection never deletes a workspace owned by another active run', async () => {
    const { manager, store } = await createManager({
      now: () => 5_000,
      retention: { completedMs: 10, failedMs: 10, cancelledMs: 10, debugMs: 10 },
    });
    const done = await manager.allocate({
      runId: 'run-done',
      attempt: 1,
      branch: 'factory/done',
      baseRef: 'origin/main',
    });
    await manager.complete(done.id);
    const stale = await store.load(done.id);
    const hijack = {
      ...stale!,
      id: 'run-other',
      runId: 'run-other',
      state: 'active' as const,
      version: 1,
      cleanupAttempt: undefined,
      retentionUntil: undefined,
    };
    await store.save(hijack, 0);
    await assert.rejects(() => manager.collectGarbage(10_000), /shares a path with an active run/);
    assert.equal((await store.load(done.id))?.state, 'completed');
  });

  test('use-time confinement rejects a path that escapes the workspace root', async () => {
    const { manager, root } = await createManager();
    const allocated = await manager.allocate({
      runId: 'run-141',
      attempt: 1,
      branch: 'factory/141-lifecycle',
      baseRef: 'origin/main',
    });
    const outside = path.join(path.dirname(root), 'outside.txt');
    await writeFile(outside, 'secret\n');
    await rm(allocated.path, { recursive: true, force: true });
    await symlink(path.dirname(outside), allocated.path, 'dir');
    await assert.rejects(
      () =>
        manager.commit(
          {
            id: allocated.id,
            path: allocated.path,
            branch: allocated.branch,
            baseRef: allocated.baseRef,
          },
          'feat: escape',
        ),
      /escapes the isolated workspace root/,
    );
  });

  test('stale missing clones are detected on resume', async () => {
    const git = fakeGit(await tempDir(), { missingAfterCreate: true });
    const { manager } = await createManager({ git });
    await assert.rejects(
      () =>
        manager.allocate({
          runId: 'run-stale',
          attempt: 1,
          branch: 'factory/stale',
          baseRef: 'origin/main',
        }),
      /is stale; its directory is missing/,
    );
  });
});

async function createManager(
  overrides: {
    git?: FactoryWorkspaceGit;
    now?: () => number;
    retention?: {
      completedMs: number;
      failedMs: number;
      cancelledMs: number;
      debugMs: number;
    };
  } = {},
) {
  const root = await tempDir();
  const events: FactoryWorkspaceEvent[] = [];
  const store = new MemoryFactoryWorkspaceStore();
  const git = overrides.git ?? fakeGit(root);
  const manager = new FactoryWorkspaceManager({
    git,
    store,
    workspaceRoot: root,
    repositoryId: 'jellydn/flowly',
    events: {
      async emit(event) {
        events.push(event);
      },
    },
    now: overrides.now,
    retention: overrides.retention,
  });
  return { manager, store, events, root, git };
}

function fakeGit(
  root: string,
  options: { missingAfterCreate?: boolean; sha?: string } = {},
): FactoryWorkspaceGit {
  return {
    async createWorkspace(id, branch, baseRef = 'origin/main'): Promise<FactoryGitWorkspace> {
      const directory = path.join(root, id);
      if (!options.missingAfterCreate) await mkdir(directory, { recursive: true });
      return { id, path: directory, branch, baseRef };
    },
    async commit() {
      return { commitSha: SHA, changedFiles: ['README.md'] };
    },
    async push() {},
    async isPristine() {
      return true;
    },
    async resolveSha() {
      return options.sha ?? SHA;
    },
  };
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowly-workspace-'));
  temporaryDirectories.push(root);
  return root;
}

function sequentialNow(start: number): () => number {
  let current = start;
  return () => {
    current += 1;
    return current;
  };
}
