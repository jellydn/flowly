import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restrictedSandbox } from '../sandbox.ts';

test('restricted sandbox preserves session creation and removes default tools', async () => {
  assert.deepEqual(restrictedSandbox.tools?.({} as never, { subagents: {} }), []);
  const session = await restrictedSandbox.createSessionEnv({ id: 'sandbox-test' });
  await session.writeFile('status.txt', 'ok');
  assert.equal(await session.readFile('status.txt'), 'ok');
});
