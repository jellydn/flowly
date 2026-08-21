import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { FactoryVerificationRunner } from '../factory/verification.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('FactoryVerificationRunner', () => {
  test('runs repository commands sequentially in the implementation workspace', async () => {
    const workspace = await temporaryWorkspace();
    const runner = new FactoryVerificationRunner({ env: { PATH: process.env.PATH } });

    const results = await runner.run(
      ['printf first > order.txt', 'test "$(cat order.txt)" = first && printf second'],
      workspace,
    );

    assert.deepEqual(
      results.map(({ command, exitCode, stdout, timedOut }) => ({
        command,
        exitCode,
        stdout,
        timedOut,
      })),
      [
        { command: 'printf first > order.txt', exitCode: 0, stdout: '', timedOut: false },
        {
          command: 'test "$(cat order.txt)" = first && printf second',
          exitCode: 0,
          stdout: 'second',
          timedOut: false,
        },
      ],
    );
  });

  test('records failures and bounds captured output', async () => {
    const workspace = await temporaryWorkspace();
    const runner = new FactoryVerificationRunner({ maxOutputBytes: 5 });

    const [result] = await runner.run(['printf 123456789; printf failure >&2; exit 7'], workspace);

    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, '12345');
    assert.equal(result.stderr, 'failu');
    assert.equal(result.timedOut, false);
  });

  test('terminates commands that exceed their configured timeout', async () => {
    const workspace = await temporaryWorkspace();
    const runner = new FactoryVerificationRunner({ timeoutMs: 20 });

    const [result] = await runner.run(['sleep 10'], workspace);

    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
  });

  test('requires a bounded, non-empty command list', async () => {
    const workspace = await temporaryWorkspace();
    const runner = new FactoryVerificationRunner();
    await assert.rejects(() => runner.run([], workspace), /between 1 and 20/);
    await assert.rejects(() => runner.run([''], workspace), /empty or exceeds/);
  });
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowly-factory-verification-'));
  temporaryDirectories.push(directory);
  return directory;
}
