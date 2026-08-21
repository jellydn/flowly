import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { FactoryGitAdapter, assertFactoryBranch } from '../factory/git.ts';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('FactoryGitAdapter', () => {
  test('commits and pushes from an isolated factory-owned workspace', async () => {
    const fixture = await createGitFixture();
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot: fixture.workspaces,
    });
    const workspace = await adapter.createWorkspace(
      'run-94',
      'factory/94-controlled-implementation',
    );

    await writeFile(path.join(workspace.path, 'implementation.txt'), 'factory output\n');
    const result = await adapter.commitAndPush(workspace, 'feat: implement issue 94');

    assert.match(result.commitSha, /^[a-f0-9]{40}$/);
    assert.deepEqual(result.changedFiles, ['implementation.txt']);
    assert.equal(await git(['branch', '--show-current'], fixture.source), 'main');
    await assert.rejects(() => readFile(path.join(fixture.source, 'implementation.txt')), /ENOENT/);
    assert.equal(
      await git(
        ['show', 'factory/94-controlled-implementation:implementation.txt'],
        fixture.remote,
      ),
      'factory output',
    );
  });

  test('restores the same workspace without replacing its changes', async () => {
    const fixture = await createGitFixture();
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot: fixture.workspaces,
    });
    const workspace = await adapter.createWorkspace('run-94', 'factory/94-resume');
    await writeFile(path.join(workspace.path, 'pending.txt'), 'keep me\n');

    const restored = await adapter.createWorkspace('run-94', 'factory/94-resume');

    assert.equal(restored.path, workspace.path);
    assert.equal(await readFile(path.join(restored.path, 'pending.txt'), 'utf8'), 'keep me\n');
  });

  test('rechecks the current branch before committing or pushing', async () => {
    const fixture = await createGitFixture();
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot: fixture.workspaces,
    });
    const workspace = await adapter.createWorkspace('run-94', 'factory/94-guard');
    await git(['checkout', '-b', 'user-owned'], workspace.path);
    await writeFile(path.join(workspace.path, 'unsafe.txt'), 'do not push\n');

    await assert.rejects(
      () => adapter.commitAndPush(workspace, 'feat: unsafe mutation'),
      /is on user-owned, not factory\/94-guard/,
    );
    await assert.rejects(
      () => git(['show-ref', '--verify', 'refs/heads/factory/94-guard'], fixture.remote),
      /Command failed/,
    );
  });

  test('rechecks the remote after committing and before pushing', async () => {
    const fixture = await createGitFixture();
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot: fixture.workspaces,
      execGit: async (args, cwd) => {
        const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
        if (args.includes('commit')) {
          await git(['remote', 'set-url', 'origin', '../unexpected.git'], cwd);
        }
        return result;
      },
    });
    const workspace = await adapter.createWorkspace('run-94', 'factory/94-remote-guard');
    await writeFile(path.join(workspace.path, 'unsafe.txt'), 'do not push\n');

    await assert.rejects(
      () => adapter.commitAndPush(workspace, 'feat: unsafe remote mutation'),
      /unexpected origin remote/,
    );
    await assert.rejects(
      () => git(['show-ref', '--verify', 'refs/heads/factory/94-remote-guard'], fixture.remote),
      /Command failed/,
    );
  });

  test('rejects non-factory refs and workspace roots inside the source checkout', async () => {
    assert.throws(() => assertFactoryBranch('main'), /outside a factory-owned branch/);
    assert.throws(() => assertFactoryBranch('factory/../main'), /outside a factory-owned branch/);
    const fixture = await createGitFixture();
    const workspaceRoot = path.join(fixture.source, '.factory-workspaces');
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot,
    });

    await assert.rejects(
      () => adapter.createWorkspace('run-94', 'factory/94-contained'),
      /must be outside the source checkout/,
    );
    await assert.rejects(() => access(workspaceRoot), /ENOENT/);
  });

  test('rejects a workspace root that contains the source checkout without creating a clone', async () => {
    const fixture = await createGitFixture();
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot: fixture.root,
    });

    await assert.rejects(
      () => adapter.createWorkspace('run-94', 'factory/94-containing'),
      /must be outside the source checkout/,
    );
    await assert.rejects(() => access(path.join(fixture.root, 'run-94')), /ENOENT/);
  });

  test('rejects a workspace root inside a symlink alias without creating it', async () => {
    const fixture = await createGitFixture();
    const sourceAlias = path.join(fixture.root, 'source-alias');
    await symlink(fixture.source, sourceAlias, 'dir');
    const workspaceRoot = path.join(sourceAlias, '.factory-workspaces');
    const adapter = new FactoryGitAdapter({
      sourceRepository: fixture.source,
      workspaceRoot,
    });

    await assert.rejects(
      () => adapter.createWorkspace('run-94', 'factory/94-symlink-contained'),
      /must be outside the source checkout/,
    );
    await assert.rejects(() => access(workspaceRoot), /ENOENT/);
  });
});

async function createGitFixture(): Promise<{
  root: string;
  remote: string;
  source: string;
  workspaces: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowly-factory-git-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  const workspaces = path.join(root, 'workspaces');
  await git(['init', '--bare', remote], root);
  await git(['clone', remote, source], root);
  await git(['checkout', '-b', 'main'], source);
  await writeFile(path.join(source, 'README.md'), '# Fixture\n');
  await git(['add', 'README.md'], source);
  await git(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-m',
      'Initial commit',
    ],
    source,
  );
  await git(['push', '--set-upstream', 'origin', 'main'], source);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  return { root, remote, source, workspaces };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}
