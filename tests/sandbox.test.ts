import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restrictedSandbox } from '../sandbox.ts';

// The runtime's SandboxFactory shape changed across minor versions
// (createSessionEnv in 2.0.1, createSandbox in 2.0.2). The restricted
// factory preserves whichever entry point the installed runtime provides,
// so the test narrows through a version-agnostic shape instead of naming a
// specific method.
interface SandboxLike {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

interface RestrictedSandboxShape {
  tools?: (sandbox: never, options: never) => unknown[];
  createSandbox?: (options: { id: string }) => Promise<SandboxLike>;
  createSessionEnv?: (options: { id: string }) => Promise<SandboxLike>;
}

test('restricted sandbox preserves session creation and removes default tools', async () => {
  const sandbox = restrictedSandbox as RestrictedSandboxShape;

  // Model-facing tools are removed: the agent cannot reach shell/filesystem
  // through the sandbox, only through the five bounded inspection tools.
  assert.deepEqual(sandbox.tools?.({} as never, {} as never), []);

  const create = sandbox.createSandbox ?? sandbox.createSessionEnv;
  assert.ok(create, 'sandbox factory must keep a session-creation entry point');
  const session = await create({ id: 'sandbox-test' });
  await session.writeFile('status.txt', 'ok');
  assert.equal(await session.readFile('status.txt'), 'ok');
});
