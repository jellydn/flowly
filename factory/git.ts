import { execFile } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FACTORY_BRANCH = /^factory\/[a-z0-9][a-z0-9._/-]*$/;

export type FactoryGitWorkspace = {
  id: string;
  path: string;
  branch: string;
  baseRef: string;
};

export type FactoryCommit = {
  commitSha: string;
  changedFiles: string[];
};

type GitResult = { stdout: string; stderr: string };

export type FactoryGitAdapterOptions = {
  sourceRepository: string;
  workspaceRoot: string;
  remote?: string;
  gitBin?: string;
  execGit?: (args: string[], cwd: string) => Promise<GitResult>;
};

/**
 * Trusted mutation boundary for factory implementations. Work happens in an
 * independent clone, and every branch-changing operation rechecks ownership.
 */
export class FactoryGitAdapter {
  private readonly remote: string;
  private readonly gitBin: string;
  private readonly execGit: (args: string[], cwd: string) => Promise<GitResult>;

  constructor(private readonly options: FactoryGitAdapterOptions) {
    this.remote = options.remote ?? 'origin';
    this.gitBin = options.gitBin ?? 'git';
    this.execGit =
      options.execGit ??
      (async (args, cwd) =>
        execFileAsync(this.gitBin, args, {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        }));
  }

  async createWorkspace(
    id: string,
    branch: string,
    baseRef = `${this.remote}/main`,
  ): Promise<FactoryGitWorkspace> {
    assertWorkspaceId(id);
    assertFactoryBranch(branch);
    const sourceRepository = await realpath(this.options.sourceRepository);
    const intendedWorkspaceRoot = await resolveProspectivePath(this.options.workspaceRoot);
    assertSeparatePaths(sourceRepository, intendedWorkspaceRoot);

    await mkdir(intendedWorkspaceRoot, { recursive: true });
    const workspaceRoot = await realpath(intendedWorkspaceRoot);
    assertSeparatePaths(sourceRepository, workspaceRoot);

    const workspace: FactoryGitWorkspace = {
      id,
      path: path.join(workspaceRoot, id),
      branch,
      baseRef,
    };
    const sourceRemoteUrl = (
      await this.execGit(['remote', 'get-url', this.remote], sourceRepository)
    ).stdout.trim();

    if (await exists(workspace.path)) {
      await this.assertWorkspace(workspace, sourceRemoteUrl);
      return workspace;
    }

    await this.execGit(
      ['clone', '--no-hardlinks', '--origin', this.remote, sourceRepository, workspace.path],
      workspaceRoot,
    );
    await this.execGit(['remote', 'set-url', this.remote, sourceRemoteUrl], workspace.path);
    await this.execGit(['checkout', '--no-track', '-b', branch, baseRef], workspace.path);
    await this.assertWorkspace(workspace, sourceRemoteUrl);
    return workspace;
  }

  async commit(workspace: FactoryGitWorkspace, message: string): Promise<FactoryCommit> {
    if (!message.trim()) throw new Error('Factory commit message must not be empty.');
    const sourceRepository = await realpath(this.options.sourceRepository);
    const sourceRemoteUrl = (
      await this.execGit(['remote', 'get-url', this.remote], sourceRepository)
    ).stdout.trim();
    await this.assertWorkspace(workspace, sourceRemoteUrl);

    const status = await this.execGit(['status', '--porcelain=v1', '-z'], workspace.path);
    if (status.stdout) {
      await this.execGit(['add', '--all'], workspace.path);
      await this.execGit(
        [
          '-c',
          'user.name=Flowly Factory',
          '-c',
          'user.email=flowly-factory@users.noreply.github.com',
          'commit',
          '-m',
          message,
        ],
        workspace.path,
      );
    }

    const ahead = Number(
      (await this.execGit(['rev-list', '--count', `${workspace.baseRef}..HEAD`], workspace.path))
        .stdout,
    );
    if (!Number.isInteger(ahead) || ahead < 1) {
      throw new Error('Factory implementation has no commits to push.');
    }

    const commitSha = (await this.execGit(['rev-parse', 'HEAD'], workspace.path)).stdout.trim();
    const changedFiles = (
      await this.execGit(
        ['diff', '--name-only', '-z', `${workspace.baseRef}...HEAD`],
        workspace.path,
      )
    ).stdout
      .split('\0')
      .filter(Boolean)
      .sort();
    return { commitSha, changedFiles };
  }

  async push(workspace: FactoryGitWorkspace, commitSha: string): Promise<void> {
    assertCommitSha(commitSha);
    const sourceRepository = await realpath(this.options.sourceRepository);
    const sourceRemoteUrl = (
      await this.execGit(['remote', 'get-url', this.remote], sourceRepository)
    ).stdout.trim();
    await this.assertWorkspace(workspace, sourceRemoteUrl);
    await this.execGit(
      ['push', '--set-upstream', this.remote, `${commitSha}:refs/heads/${workspace.branch}`],
      workspace.path,
    );
  }

  async commitAndPush(workspace: FactoryGitWorkspace, message: string): Promise<FactoryCommit> {
    const commit = await this.commit(workspace, message);
    await this.push(workspace, commit.commitSha);
    return commit;
  }

  async isPristine(workspace: FactoryGitWorkspace, commitSha: string): Promise<boolean> {
    assertCommitSha(commitSha);
    const sourceRepository = await realpath(this.options.sourceRepository);
    const sourceRemoteUrl = (
      await this.execGit(['remote', 'get-url', this.remote], sourceRepository)
    ).stdout.trim();
    await this.assertWorkspace(workspace, sourceRemoteUrl);
    const head = (await this.execGit(['rev-parse', 'HEAD'], workspace.path)).stdout.trim();
    const status = await this.execGit(['status', '--porcelain=v1', '-z'], workspace.path);
    return head === commitSha && status.stdout === '';
  }

  private async assertWorkspace(
    workspace: FactoryGitWorkspace,
    expectedRemoteUrl: string,
  ): Promise<void> {
    assertWorkspaceId(workspace.id);
    assertFactoryBranch(workspace.branch);
    const workspaceRoot = await realpath(this.options.workspaceRoot);
    const expectedPath = path.join(workspaceRoot, workspace.id);
    const actualPath = await realpath(workspace.path);
    if (actualPath !== expectedPath || !isWithin(workspaceRoot, actualPath)) {
      throw new Error('Factory workspace path escapes the configured workspace root.');
    }
    const actualRemoteUrl = (
      await this.execGit(['remote', 'get-url', this.remote], actualPath)
    ).stdout.trim();
    if (actualRemoteUrl !== expectedRemoteUrl) {
      throw new Error(`Factory workspace ${workspace.id} has an unexpected ${this.remote} remote.`);
    }
    const pushUrls = (
      await this.execGit(['remote', 'get-url', '--push', '--all', this.remote], actualPath)
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (pushUrls.length !== 1 || pushUrls[0] !== expectedRemoteUrl) {
      throw new Error(
        `Factory workspace ${workspace.id} has an unexpected ${this.remote} push destination.`,
      );
    }
    await this.assertOwnedBranch(workspace);
  }

  private async assertOwnedBranch(workspace: FactoryGitWorkspace): Promise<void> {
    assertFactoryBranch(workspace.branch);
    const current = (
      await this.execGit(['branch', '--show-current'], workspace.path)
    ).stdout.trim();
    if (current !== workspace.branch) {
      throw new Error(
        `Factory workspace ${workspace.id} is on ${current || 'a detached HEAD'}, not ${workspace.branch}.`,
      );
    }
  }
}

export function assertFactoryBranch(branch: string): void {
  if (
    !FACTORY_BRANCH.test(branch) ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.includes('@{')
  ) {
    throw new Error(`Refusing Git mutation outside a factory-owned branch: ${branch}`);
  }
}

function assertCommitSha(commitSha: string): void {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) {
    throw new Error(`Invalid factory commit SHA: ${commitSha}`);
  }
}

function assertWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new Error(`Invalid factory workspace id: ${id}`);
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertSeparatePaths(sourceRepository: string, workspaceRoot: string): void {
  if (
    workspaceRoot === sourceRepository ||
    isWithin(sourceRepository, workspaceRoot) ||
    isWithin(workspaceRoot, sourceRepository)
  ) {
    throw new Error('Factory workspace root must be outside the source checkout.');
  }
}

async function resolveProspectivePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await resolveProspectivePath(parent), path.basename(resolved));
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
