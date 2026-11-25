import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createSmolvmFactoryImplementer } from '../factory/smolvm-implementer.ts';
import { importTree, parseTreeArchive } from '../factory/tree-import.ts';

const RUN = '3f2a9c1e-0000-4000-8000-000000000001';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowly-tree-'));
  directories.push(dir);
  return dir;
}

/** A trusted clone with one commit: keep.txt, edit.txt, gone.txt, bin/run.sh. */
async function clone(): Promise<string> {
  const repo = path.join(await temporary(), RUN);
  await mkdir(path.join(repo, 'bin'), { recursive: true });
  await writeFile(path.join(repo, 'keep.txt'), 'same\n');
  await writeFile(path.join(repo, 'edit.txt'), 'old\n');
  await writeFile(path.join(repo, 'gone.txt'), 'bye\n');
  await writeFile(path.join(repo, 'bin', 'run.sh'), 'echo hi\n', { mode: 0o644 });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'base',
  ]);
  return repo;
}

/** The candidate tree as a guest would leave it, packed by real GNU tar. */
async function candidateArchive(format: 'gnu' | 'ustar' | 'pax'): Promise<Buffer> {
  const tree = await temporary();
  const deep = path.join('src', 'a'.repeat(60), 'b'.repeat(60));
  await mkdir(path.join(tree, deep), { recursive: true });
  await mkdir(path.join(tree, 'bin'));
  await writeFile(path.join(tree, 'keep.txt'), 'same\n');
  await writeFile(path.join(tree, 'edit.txt'), 'new\n');
  await writeFile(path.join(tree, 'bin', 'run.sh'), 'echo hi\n', { mode: 0o755 });
  await writeFile(path.join(tree, deep, 'long.txt'), 'deep\n');
  await symlink('../keep.txt', path.join(tree, 'bin', 'keep-link'));
  const out = path.join(await temporary(), 'c.tar');
  execFileSync('tar', [`--format=${format}`, '-cf', out, '-C', tree, '.']);
  return readFile(out);
}

/** One raw tar header block plus data, for archives real tar would not make. */
function entry(
  name: string,
  options: { type?: string; data?: string; link?: string; checksum?: number } = {},
) {
  const data = Buffer.from(options.data ?? '');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'latin1');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write(options.type ?? '0', 156, 'latin1');
  header.write(options.link ?? '', 157, 100, 'utf8');
  header.write('ustar\u000000', 257, 'latin1');
  header.fill(32, 148, 156);
  const sum = options.checksum ?? header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const archive = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(1024)]);

describe('parseTreeArchive', () => {
  for (const format of ['gnu', 'ustar', 'pax'] as const) {
    test(`reads ${format} archives with long paths, modes, and symlinks`, async () => {
      const entries = parseTreeArchive(await candidateArchive(format));
      const byPath = new Map(entries.map((item) => [item.path, item]));
      const long = `src/${'a'.repeat(60)}/${'b'.repeat(60)}/long.txt`;
      assert.deepEqual(
        [...byPath.keys()].sort(),
        ['bin/keep-link', 'bin/run.sh', 'edit.txt', 'keep.txt', long].sort(),
      );
      assert.deepEqual(byPath.get('bin/keep-link'), {
        path: 'bin/keep-link',
        type: 'symlink',
        target: '../keep.txt',
      });
      const script = byPath.get('bin/run.sh');
      assert.ok(script?.type === 'file' && script.executable);
      const deep = byPath.get(long);
      assert.ok(deep?.type === 'file' && deep.data.toString() === 'deep\n' && !deep.executable);
    });
  }

  const refusals: Array<[string, Buffer, RegExp]> = [
    ['an absolute path', archive(entry('/etc/passwd', { data: 'x' })), /absolute path/],
    [
      'a path that leaves the tree',
      archive(entry('src/../../x', { data: 'x' })),
      /leaves the tree/,
    ],
    ['a Git hook', archive(entry('./.git/hooks/pre-commit', { data: 'x' })), /Git metadata/],
    ['Git metadata in another case', archive(entry('.GIT/config', { data: 'x' })), /Git metadata/],
    ['a nested Git directory', archive(entry('vendor/.git/config', { data: 'x' })), /Git metadata/],
    ['a hard link', archive(entry('a', { type: '1', link: 'b' })), /unsupported type "1"/],
    ['a device', archive(entry('a', { type: '3' })), /unsupported type "3"/],
    [
      'a symlink out of the tree',
      archive(entry('lib/x', { type: '2', link: '../../etc' })),
      /outside the tree/,
    ],
    [
      'an absolute symlink',
      archive(entry('x', { type: '2', link: '/etc/passwd' })),
      /relative target/,
    ],
    [
      'a symlink into Git metadata',
      archive(entry('x', { type: '2', link: '.git/config' })),
      /Git metadata/,
    ],
    [
      'a file below a symlink',
      archive(entry('dir', { type: '2', link: 'src' }), entry('dir/x', { data: 'x' })),
      /below the non-directory "dir"/,
    ],
    ['a repeated path', archive(entry('a', { data: '1' }), entry('a', { data: '2' })), /repeats/],
    ['a wrong checksum', archive(entry('a', { data: 'x', checksum: 1 })), /checksum/],
    ['a truncated archive', entry('a', { data: 'x'.repeat(600) }).subarray(0, 700), /truncated/],
  ];
  for (const [label, input, expected] of refusals) {
    test(`refuses ${label}`, () => assert.throws(() => parseTreeArchive(input), expected));
  }

  test('enforces the byte and entry limits', () => {
    const two = archive(entry('a', { data: '1' }), entry('b', { data: '2' }));
    assert.throws(() => parseTreeArchive(two, { maxBytes: 100, maxEntries: 10 }), /limit is 100/);
    assert.throws(
      () => parseTreeArchive(two, { maxBytes: 1e6, maxEntries: 1 }),
      /more than 1 entries/,
    );
  });
});

describe('importTree', () => {
  test('makes the clone equal to the candidate and leaves .git alone', async () => {
    const repo = await clone();
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });

    const changed = await importTree(repo, parseTreeArchive(await candidateArchive('gnu')));

    const long = `src/${'a'.repeat(60)}/${'b'.repeat(60)}/long.txt`;
    assert.deepEqual(changed, ['bin/keep-link', 'bin/run.sh', 'edit.txt', 'gone.txt', long].sort());
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-uall'], {
      encoding: 'utf8',
    });
    assert.deepEqual(
      status.split('\n').filter(Boolean).sort(),
      [' D gone.txt', ' M bin/run.sh', ' M edit.txt', '?? bin/keep-link', `?? ${long}`].sort(),
    );
    assert.equal(await readlink(path.join(repo, 'bin/keep-link')), '../keep.txt');
    assert.equal(
      execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      head,
    );
  });

  test('never writes through a symlink that already exists in the clone', async () => {
    const repo = await clone();
    const outside = await temporary();
    await writeFile(path.join(outside, 'secret'), 'host\n');
    await symlink(path.join(outside, 'secret'), path.join(repo, 'edit.txt'), 'file').catch(
      async () => {
        await rm(path.join(repo, 'edit.txt'));
        await symlink(path.join(outside, 'secret'), path.join(repo, 'edit.txt'));
      },
    );
    await symlink(outside, path.join(repo, 'dir'));

    await importTree(repo, [
      { path: 'edit.txt', type: 'file', data: Buffer.from('candidate\n'), executable: false },
      { path: 'dir/new.txt', type: 'file', data: Buffer.from('candidate\n'), executable: false },
    ]);

    assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'host\n');
    await assert.rejects(lstat(path.join(outside, 'new.txt')));
    assert.ok((await lstat(path.join(repo, 'edit.txt'))).isFile());
    assert.ok((await lstat(path.join(repo, 'dir'))).isDirectory());
  });
});

describe('createSmolvmFactoryImplementer', () => {
  function fakeVms(candidate: Buffer, packExit = 0) {
    const log: string[] = [];
    const vms = {
      async recover(input: { runId: string; attempt: number; archivePath: string }) {
        log.push(`recover ${input.runId} a${input.attempt}`);
        return { runId: input.runId, attempt: input.attempt, name: 'vm', workdir: '/work' };
      },
      async execute(_vm: unknown, command: { command: string }) {
        log.push(`exec ${command.command}`);
        return { exitCode: packExit, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
      async copyOut(_vm: unknown, guest: string, host: string) {
        log.push(`copyOut ${guest}`);
        await writeFile(host, candidate);
      },
      async cleanup(runId: string) {
        log.push(`cleanup ${runId}`);
      },
    };
    return { vms, log };
  }
  const task = { issueNumber: 1, title: 't', body: '', repository: 'a/b' };
  const plan = { summary: 's', steps: [], acceptanceCriteria: [], verificationCommands: ['true'] };

  test('runs the agent against the attempt VM and imports the validated tree', async () => {
    const repo = await clone();
    const { vms, log } = fakeVms(await candidateArchive('ustar'));
    const agentEnv: Array<Record<string, string> | undefined> = [];
    const implementer = createSmolvmFactoryImplementer({
      vms,
      runAgent: async (_input, env) => void agentEnv.push(env),
    });

    await implementer.implement({
      task,
      plan,
      workspace: { id: RUN, path: repo, branch: 'factory/1-t', baseRef: 'HEAD' },
    });

    assert.deepEqual(agentEnv, [{ FLOWLY_SMOLVM_RUN_ID: RUN, FLOWLY_SMOLVM_ATTEMPT: '1' }]);
    assert.deepEqual(log, [
      `recover ${RUN} a1`,
      'exec tar -cf /tmp/flowly-candidate.tar -C /work .',
      'copyOut /tmp/flowly-candidate.tar',
      `cleanup ${RUN}`,
    ]);
    assert.equal(await readFile(path.join(repo, 'edit.txt'), 'utf8'), 'new\n');
  });

  test('refuses a malicious tree, leaves the clone unchanged, and deletes the VM', async () => {
    const repo = await clone();
    const { vms, log } = fakeVms(archive(entry('.git/hooks/post-commit', { data: 'evil' })));
    const implementer = createSmolvmFactoryImplementer({ vms, runAgent: async () => {} });

    await assert.rejects(
      implementer.implement({
        task,
        plan,
        workspace: { id: `${RUN}-a2`, path: repo, branch: 'factory/1-t', baseRef: 'HEAD' },
      }),
      /Git metadata/,
    );
    assert.equal(log[0], `recover ${RUN} a2`);
    assert.equal(log.at(-1), `cleanup ${RUN}`);
    assert.equal(
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }),
      '',
    );
    await assert.rejects(lstat(path.join(repo, '.git/hooks/post-commit')));
  });
});
