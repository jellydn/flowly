import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertFactoryBranch } from './git.ts';
import type { FactoryGitMutator, FactoryVerifier } from './implementation.ts';
import type { FactoryDraftPrPublisher } from './publisher.ts';
import {
  branchMatchesPatterns,
  CapabilityDeniedError,
  type FactoryStage,
  isForbiddenContextSource,
  isForbiddenGitHubAction,
  type StageCapabilityManifest,
} from './capabilities.ts';
import type { FactoryRun } from './types.ts';

const PUBLISHER_FORBIDDEN_METHODS = [
  'merge',
  'mergePullRequest',
  'approve',
  'approvePullRequest',
  'submitApproval',
  'deploy',
] as const;

export function assertToolAllowed(manifest: StageCapabilityManifest, tool: string): void {
  if (!manifest.tools.includes(tool)) {
    throw new CapabilityDeniedError(
      manifest.stage,
      `tool.${tool}`,
      'Undeclared tools are denied by default.',
    );
  }
}

export function assertContextSource(manifest: StageCapabilityManifest, source: string): void {
  if (isForbiddenContextSource(source) || !manifest.contextSources.includes(source)) {
    throw new CapabilityDeniedError(
      manifest.stage,
      `context.${source}`,
      'This stage cannot receive that context source.',
    );
  }
}

export function selectAllowedContext(
  manifest: StageCapabilityManifest,
  provided: Record<string, string | undefined>,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [source, value] of Object.entries(provided)) {
    if (value === undefined || value === '') continue;
    assertContextSource(manifest, source);
    selected[source] = value;
  }
  return selected;
}

export function assertNetworkAccess(manifest: StageCapabilityManifest, host: string): void {
  if (manifest.network.mode === 'deny') {
    throw new CapabilityDeniedError(
      manifest.stage,
      `network.${host}`,
      'Network access is denied for this stage.',
    );
  }
  if (!manifest.network.hosts.includes(host)) {
    throw new CapabilityDeniedError(
      manifest.stage,
      `network.${host}`,
      'Host is not on the stage network allowlist.',
    );
  }
}

export function assertGitHubAction(manifest: StageCapabilityManifest, action: string): void {
  if (isForbiddenGitHubAction(action) || !manifest.github.allowedActions.includes(action)) {
    throw new CapabilityDeniedError(
      manifest.stage,
      `github.${action}`,
      'GitHub mutation is not allowed for this stage.',
    );
  }
}

export function assertRepositoryRead(manifest: StageCapabilityManifest): void {
  if (!manifest.repository.read) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'repository.read',
      'This stage cannot read repository files.',
    );
  }
}

export function assertRepositoryWrite(manifest: StageCapabilityManifest): void {
  if (!manifest.repository.write) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'repository.write',
      'This stage cannot write repository files.',
    );
  }
}

export function assertRepositoryPathsUnrestricted(manifest: StageCapabilityManifest): void {
  if (manifest.repository.allowedPaths !== undefined) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'repository.allowedPaths',
      'This adapter cannot safely provide a restricted repository view.',
    );
  }
}

export function assertShell(manifest: StageCapabilityManifest, command?: string): void {
  if (!manifest.shell.enabled) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'shell',
      'Shell execution is disabled for this stage.',
    );
  }
  if (
    command !== undefined &&
    manifest.shell.allowedCommands &&
    !manifest.shell.allowedCommands.includes(command)
  ) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'shell.command',
      'Command is not in the stage allowlist.',
    );
  }
}

export function assertGitRead(manifest: StageCapabilityManifest): void {
  if (!manifest.git.read) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'git.read',
      'This stage cannot read git state.',
    );
  }
}

export function assertGitMutation(manifest: StageCapabilityManifest, branch: string): void {
  if (!manifest.git.write) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'git.write',
      'This stage cannot mutate git state.',
    );
  }
  assertFactoryBranch(branch);
  if (!branchMatchesPatterns(manifest.git.allowedBranchPatterns, branch)) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'git.branch',
      `Refusing git mutation on ${branch}.`,
    );
  }
}

export async function assertWorkspacePath(
  manifest: StageCapabilityManifest,
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  assertRepositoryWrite(manifest);
  const root = await resolveExistingPath(workspaceRoot);
  const target = await resolveProspectivePath(targetPath);
  if (!isWithin(root, target)) {
    throw new CapabilityDeniedError(
      manifest.stage,
      'repository.path',
      'Path escapes the isolated workspace root.',
    );
  }
  if (manifest.repository.allowedPaths && manifest.repository.allowedPaths.length > 0) {
    const relative = path.relative(root, target).replaceAll('\\', '/');
    const allowed = manifest.repository.allowedPaths.some(
      (pattern) => relative === pattern || relative.startsWith(`${pattern.replace(/\/$/, '')}/`),
    );
    if (!allowed) {
      throw new CapabilityDeniedError(
        manifest.stage,
        'repository.path',
        `Path ${relative} is outside the stage path allowlist.`,
      );
    }
  }
}

export function bindGitMutator(
  git: FactoryGitMutator,
  manifest: StageCapabilityManifest,
): FactoryGitMutator {
  return {
    async createWorkspace(id, branch, baseRef) {
      assertGitMutation(manifest, branch);
      return git.createWorkspace(id, branch, baseRef);
    },
    async commit(workspace, message) {
      assertGitMutation(manifest, workspace.branch);
      return git.commit(workspace, message);
    },
    async push(workspace, commitSha) {
      assertGitMutation(manifest, workspace.branch);
      return git.push(workspace, commitSha);
    },
    async isPristine(workspace, commitSha) {
      assertGitRead(manifest);
      return git.isPristine(workspace, commitSha);
    },
  };
}

export function bindVerifier(
  verifier: FactoryVerifier,
  manifest: StageCapabilityManifest,
): FactoryVerifier {
  return {
    async run(commands, workspacePath) {
      assertShell(manifest);
      for (const command of commands) assertShell(manifest, command);
      return verifier.run(commands, workspacePath, { network: manifest.network });
    },
  };
}

export function bindDraftPublisher(
  publisher: FactoryDraftPrPublisher,
  manifest: StageCapabilityManifest,
): FactoryDraftPrPublisher {
  assertPublisherCannotEscalate(publisher, manifest.stage);
  return {
    publish: async (run: FactoryRun) => {
      assertGitHubAction(manifest, 'create-draft-pr');
      assertContextSource(manifest, 'structured-implementation');
      assertContextSource(manifest, 'structured-review');
      return publisher.publish(run);
    },
  } as FactoryDraftPrPublisher;
}

export function assertPublisherCannotEscalate(
  publisher: object,
  stage: FactoryStage = 'publisher',
): void {
  for (const name of PUBLISHER_FORBIDDEN_METHODS) {
    if (name in publisher && typeof (publisher as Record<string, unknown>)[name] === 'function') {
      throw new CapabilityDeniedError(
        stage,
        `github.${name}`,
        'Publisher must not expose merge, approval, or deploy operations.',
      );
    }
  }
}

async function resolveExistingPath(filePath: string): Promise<string> {
  return realpath(filePath);
}

async function resolveProspectivePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await resolveProspectivePath(parent), path.basename(resolved));
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
