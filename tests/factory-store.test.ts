import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { FileFactoryRunStore } from '../factory/store.ts';
import type { FactoryRun } from '../factory/types.ts';

const task = {
  issueNumber: 94,
  title: 'Add factory pipeline',
  body: 'Implement it.',
  repository: 'jellydn/flowly',
};

describe('FileFactoryRunStore', () => {
  test('round-trips a run across process-style store instances', async () => {
    await withStore(async (directory) => {
      const first = new FileFactoryRunStore(directory);
      const created = await first.createOrGet(queuedRun('run-1'));
      assert.equal(created.created, true);

      const classified: FactoryRun = {
        ...created.run,
        state: 'classified',
        version: 2,
        classification: {
          actionable: true,
          type: 'feature',
          priority: 'high',
          complexity: 'large',
          missingInformation: [],
        },
        updatedAt: created.run.updatedAt + 1,
      };
      await first.save(classified, 1);

      const second = new FileFactoryRunStore(directory);
      const loaded = await second.load('run-1');
      assert.equal(loaded?.state, 'classified');
      assert.equal(loaded?.version, 2);
      assert.equal((await second.findByIssue(task.repository, task.issueNumber))?.id, 'run-1');
    });
  });

  test('reuses one run per issue instead of creating a duplicate', async () => {
    await withStore(async (directory) => {
      const store = new FileFactoryRunStore(directory);
      const first = await store.createOrGet(queuedRun('run-1'));
      const duplicate = await store.createOrGet(queuedRun('run-2'));
      assert.equal(first.created, true);
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.run.id, 'run-1');
    });
  });

  test('rejects stale version writes', async () => {
    await withStore(async (directory) => {
      const store = new FileFactoryRunStore(directory);
      const { run } = await store.createOrGet(queuedRun('run-1'));
      await assert.rejects(
        () => store.save({ ...run, state: 'classified', version: 2, updatedAt: Date.now() }, 0),
        /expected version 0, found 1/,
      );
    });
  });
});

function queuedRun(id: string): FactoryRun {
  return {
    id,
    task,
    state: 'queued',
    version: 1,
    updatedAt: Date.now(),
  };
}

async function withStore(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowly-factory-runs-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
