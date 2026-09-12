#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { setRepositoryInstinctStatus } from '../memory/engine.ts';
import { FileRepositoryMemoryStore } from '../memory/store.ts';

const [command, id] = process.argv.slice(2);

async function main(): Promise<void> {
  let store = new FileRepositoryMemoryStore(
    path.resolve(process.env.FLOWLY_MEMORY_STORE ?? '.flowly/repository-instincts.json'),
  );
  let state = await store.load();
  if (state === null && process.env.FLOWLY_MEMORY_STORE === undefined) {
    store = new FileRepositoryMemoryStore(path.resolve('.flue/repository-instincts.json'));
    state = await store.load();
  }
  if (command === 'list') {
    console.log(
      JSON.stringify(
        (state?.instincts ?? []).map(({ id: instinctId, kind, statement, confidence, status }) => ({
          id: instinctId,
          kind,
          statement,
          confidence,
          status,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (!state) throw new Error('Repository memory is empty.');
  if (command === 'explain' && id) {
    const instinct = state.instincts.find((item) => item.id === id);
    if (!instinct) throw new Error(`Repository instinct ${id} does not exist.`);
    console.log(JSON.stringify(instinct, null, 2));
    return;
  }
  if ((command === 'reject' || command === 'deprecate') && id) {
    await store.update((current) => {
      if (!current) throw new Error('Repository memory is empty.');
      return setRepositoryInstinctStatus(
        current,
        id,
        command === 'reject' ? 'rejected' : 'deprecated',
      );
    });
    console.log(
      `Repository instinct ${id} marked ${command === 'reject' ? 'rejected' : 'deprecated'}.`,
    );
    return;
  }
  throw new Error('Usage: npm run memory -- list | explain <id> | reject <id> | deprecate <id>');
}

main().catch((error: unknown) => {
  console.error(`[flowly-memory] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
