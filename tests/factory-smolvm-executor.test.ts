import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseFactoryExecutor } from '../factory/execution.ts';
import {
  SmolvmExecutionAdapter,
  parseSmolvmConfig,
  type SmolvmCommandResult,
  type SmolvmConfig,
} from '../factory/smolvm.ts';

const RUN = '3f2a9c1e-0000-4000-8000-000000000001';
const OTHER = '3f2a9c1e-0000-4000-8000-000000000002';

const config: SmolvmConfig = {
  prefix: 'flowly',
  source: { pack: '/opt/flowly/base.smolmachine' },
  cpus: 2,
  memoryMb: 4096,
  commandTimeoutMs: 60_000,
  maxAttempts: 2,
};

/** Fake smolvm 1.37 CLI with an in-memory machine table, shaped like the real output. */
function fakeSmolvm(initial: Array<{ name: string; state: string; network?: boolean }> = []) {
  const machines = new Map(initial.map((item) => [item.name, item]));
  const calls: string[][] = [];
  const failOn = new Set<string>();
  const ok = (stdout = '', stderr = ''): SmolvmCommandResult => ({
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
  });
  const notFound = (name: string, json: boolean): SmolvmCommandResult => ({
    exitCode: 1,
    stdout: '',
    stderr: `${json ? `{"error":{"code":"NOT_FOUND","message":"vm not found: ${name}"}}\n` : ''}Error: vm not found: ${name}\n`,
    timedOut: false,
  });
  const runner = async (args: string[]): Promise<SmolvmCommandResult> => {
    calls.push(args);
    const [noun, verb] = args;
    const name = args[args.indexOf('--name') + 1];
    if (failOn.has(verb))
      return { exitCode: 2, stdout: '', stderr: `${verb} broke`, timedOut: false };
    if (noun !== 'machine') return ok('smolvm 1.37.0');
    if (verb === 'ls') {
      if (args.includes('--local')) {
        return {
          exitCode: 2,
          stdout: '',
          stderr: "error: unexpected argument '--local' found",
          timedOut: false,
        };
      }
      const list = [...machines.values()].map((item) => ({
        name: item.name,
        state: item.state,
        network: item.network ?? false,
        labels: {},
        created_at: 1794713441,
      }));
      return ok(JSON.stringify(list));
    }
    if (verb === 'create') {
      machines.set(name, { name, state: 'stopped', network: args.includes('--net') });
      // Real `create --from` prints a WARN line on stderr and still succeeds.
      return ok('', 'WARN refusing stale or transfer-owned VM cleanup');
    }
    if (verb === 'cp') return ok('', 'Uploading 4.0 KB / 4.0 KB (100.0%)');
    if (!machines.has(name)) return notFound(name, args.includes('--error-format'));
    if (verb === 'start') machines.get(name)!.state = 'running';
    if (verb === 'delete') machines.delete(name);
    return ok();
  };
  return { runner, calls, machines, failOn };
}

describe('factory executor selection', () => {
  test('defaults to local and rejects unknown executors instead of falling back', () => {
    assert.equal(parseFactoryExecutor({}), 'local');
    assert.equal(parseFactoryExecutor({ FLOWLY_EXECUTOR: 'smolvm' }), 'smolvm');
    assert.throws(() => parseFactoryExecutor({ FLOWLY_EXECUTOR: 'sprite' }), /FLOWLY_EXECUTOR/);
  });

  test('smolvm config requires exactly one guest source and a safe prefix', () => {
    assert.throws(() => parseSmolvmConfig({}), /exactly one/);
    assert.throws(
      () => parseSmolvmConfig({ FLOWLY_VM_IMAGE: 'node:24-alpine', FLOWLY_VM_BASE_PACK: '/b' }),
      /exactly one/,
    );
    assert.throws(
      () => parseSmolvmConfig({ FLOWLY_VM_IMAGE: 'node:24-alpine', FLOWLY_VM_PREFIX: 'Bad;rm' }),
      /FLOWLY_VM_PREFIX/,
    );
    assert.equal(
      parseSmolvmConfig({ FLOWLY_VM_IMAGE: 'node:24-alpine' }).commandTimeoutMs,
      1_800_000,
    );
  });
});

describe('SmolvmExecutionAdapter', () => {
  test('prepare creates an offline VM and copies only the archived tree', async () => {
    const smolvm = fakeSmolvm();
    const adapter = new SmolvmExecutionAdapter(config, smolvm.runner);

    const workspace = await adapter.prepare({
      runId: RUN,
      attempt: 1,
      archivePath: '/tmp/base.tar',
    });

    assert.equal(workspace.name, `flowly-${RUN}-a1`);
    assert.ok(smolvm.calls.every((args) => !args.includes('--net') && !args.includes('-v')));
    const create = smolvm.calls.find((args) => args[1] === 'create')!;
    assert.deepEqual(create.slice(4, 6), ['--from', '/opt/flowly/base.smolmachine']);
    assert.ok(
      smolvm.calls.some(
        (args) => args[1] === 'cp' && args[3] === `${workspace.name}:/tmp/flowly-source.tar`,
      ),
    );
  });

  test('a failed prepare deletes the half-made VM', async () => {
    const smolvm = fakeSmolvm();
    smolvm.failOn.add('cp');
    const adapter = new SmolvmExecutionAdapter(config, smolvm.runner);

    await assert.rejects(
      adapter.prepare({ runId: RUN, attempt: 1, archivePath: '/tmp/base.tar' }),
      /machine cp failed with exit code 2/,
    );
    assert.equal(smolvm.machines.size, 0);
  });

  test('prepare refuses an existing VM and an attempt above the limit', async () => {
    const adapter = new SmolvmExecutionAdapter(
      config,
      fakeSmolvm([{ name: `flowly-${RUN}-a1`, state: 'paused' }]).runner,
    );
    await assert.rejects(
      adapter.prepare({ runId: RUN, attempt: 1, archivePath: '/a.tar' }),
      /already exists \(paused\); use recover/,
    );
    await assert.rejects(
      adapter.prepare({ runId: RUN, attempt: 3, archivePath: '/a.tar' }),
      /attempt limit \(2\)/,
    );
  });

  test('recover discards the interrupted VM and prepares it again', async () => {
    const name = `flowly-${RUN}-a2`;
    const smolvm = fakeSmolvm([{ name, state: 'running' }]);
    const adapter = new SmolvmExecutionAdapter(config, smolvm.runner);

    await adapter.recover({ runId: RUN, attempt: 2, archivePath: '/a.tar' });

    const verbs = smolvm.calls.map((args) => args[1]);
    assert.ok(verbs.indexOf('delete') < verbs.indexOf('create'));
    assert.equal(smolvm.machines.get(name)?.state, 'running');
  });

  test('execute runs in the workdir and never forwards secret-looking variables', async () => {
    const smolvm = fakeSmolvm([{ name: `flowly-${RUN}-a1`, state: 'running' }]);
    const adapter = new SmolvmExecutionAdapter(config, smolvm.runner);
    const workspace = { runId: RUN, attempt: 1, name: `flowly-${RUN}-a1`, workdir: '/work' };

    await adapter.execute(workspace, { command: 'npm test', env: { CI: '1' } });
    assert.deepEqual(smolvm.calls.at(-1), [
      'machine',
      'exec',
      '--name',
      workspace.name,
      '-w',
      '/work',
      '-e',
      'CI=1',
      '--',
      'sh',
      '-lc',
      'npm test',
    ]);
    await assert.rejects(
      adapter.execute(workspace, { command: 'true', env: { GITHUB_TOKEN: 'x' } }),
      /GITHUB_TOKEN/,
    );
  });

  test('cleanup deletes every attempt of one run, is idempotent, and spares other runs', async () => {
    const smolvm = fakeSmolvm([
      { name: `flowly-${RUN}-a1`, state: 'stopped' },
      { name: `flowly-${RUN}-a2`, state: 'paused' },
      { name: `flowly-${OTHER}-a1`, state: 'running' },
    ]);
    const adapter = new SmolvmExecutionAdapter(config, smolvm.runner);

    await adapter.cleanup(RUN);
    await adapter.cleanup(RUN);

    assert.deepEqual([...smolvm.machines.keys()], [`flowly-${OTHER}-a1`]);
  });

  test('execute passes the guest exit code through, and reports a vanished VM', async () => {
    const smolvm = fakeSmolvm([{ name: `flowly-${RUN}-a1`, state: 'running' }]);
    const runner = async (args: string[]) =>
      args[1] === 'exec' && smolvm.machines.size
        ? { exitCode: 1, stdout: '', stderr: 'Error: vm not found: forged', timedOut: false }
        : smolvm.runner(args);
    const adapter = new SmolvmExecutionAdapter(config, runner);
    const workspace = { runId: RUN, attempt: 1, name: `flowly-${RUN}-a1`, workdir: '/work' };

    // Guest output that only looks like a smolvm error is a normal failed command.
    assert.equal((await adapter.execute(workspace, { command: 'false' })).exitCode, 1);
    smolvm.machines.clear();
    await assert.rejects(adapter.execute(workspace, { command: 'true' }), /no longer exists/);
  });

  test('prepare refuses a VM that came up with networking on', async () => {
    const smolvm = fakeSmolvm();
    const runner = async (args: string[]) => {
      const result = await smolvm.runner(args);
      if (args[1] === 'start') smolvm.machines.get(args[3])!.network = true;
      return result;
    };
    await assert.rejects(
      new SmolvmExecutionAdapter(config, runner).prepare({
        runId: RUN,
        attempt: 1,
        archivePath: '/a.tar',
      }),
      /networking off/,
    );
    assert.equal(smolvm.machines.size, 0);
  });

  test('a delete that fails for another reason is not treated as deleted', async () => {
    const smolvm = fakeSmolvm([{ name: `flowly-${RUN}-a1`, state: 'running' }]);
    smolvm.failOn.add('delete');
    await assert.rejects(
      new SmolvmExecutionAdapter(config, smolvm.runner).cleanup(RUN),
      /exit code 2/,
    );
  });

  test('a vanished VM during cleanup counts as deleted', async () => {
    const smolvm = fakeSmolvm([{ name: `flowly-${RUN}-a1`, state: 'stopped' }]);
    const runner = async (args: string[]) => {
      if (args[1] === 'delete') smolvm.machines.clear();
      return smolvm.runner(args);
    };
    await new SmolvmExecutionAdapter(config, runner).cleanup(RUN);
  });

  test('sweepOrphans deletes only prefixed VMs without an active run', async () => {
    const smolvm = fakeSmolvm([
      { name: `flowly-${RUN}-a1`, state: 'running' },
      { name: `flowly-${OTHER}-a3`, state: 'paused' },
      { name: 'flowly-dev', state: 'running' },
      { name: 'flowly-not-a-uuid-a1', state: 'stopped' },
      { name: `orb-amp-${OTHER}`, state: 'paused', network: true },
      { name: `orb-${OTHER}-a1`, state: 'running' },
    ]);
    const adapter = new SmolvmExecutionAdapter(config, smolvm.runner);

    const deleted = await adapter.sweepOrphans(new Set([RUN]));

    assert.deepEqual(deleted, [`flowly-${OTHER}-a3`]);
    assert.deepEqual([...smolvm.machines.keys()].sort(), [
      `flowly-${RUN}-a1`,
      'flowly-dev',
      'flowly-not-a-uuid-a1',
      `orb-${OTHER}-a1`,
      `orb-amp-${OTHER}`,
    ]);
  });
});
