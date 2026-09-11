import { resolveStageCapabilities, type FactoryCapabilityPolicy } from './capabilities.ts';
import { assertContextSource, bindGitMutator, bindVerifier } from './capability-guard.ts';
import type { FactoryGitWorkspace } from './git.ts';
import type { FactoryOrchestrator } from './orchestrator.ts';
import type { FactoryRun, FactoryTask, ImplementationPlan } from './types.ts';
import type { VerificationCommandResult } from './verification.ts';
import { assertFactoryAutonomyGate } from './autonomy.ts';

export type FactoryImplementerInput = {
  task: FactoryTask;
  plan: ImplementationPlan;
  workspace: FactoryGitWorkspace;
  repositoryInstincts?: string;
};

export type FactoryImplementer = {
  implement(input: FactoryImplementerInput): Promise<void>;
};

export type FactoryGitMutator = {
  createWorkspace(id: string, branch: string, baseRef?: string): Promise<FactoryGitWorkspace>;
  commit(
    workspace: FactoryGitWorkspace,
    message: string,
  ): Promise<{ commitSha: string; changedFiles: string[] }>;
  push(workspace: FactoryGitWorkspace, commitSha: string): Promise<void>;
  isPristine(workspace: FactoryGitWorkspace, commitSha: string): Promise<boolean>;
};

export type FactoryVerifier = {
  run(commands: string[], workspacePath: string): Promise<VerificationCommandResult[]>;
};

export type ControlledImplementationDependencies = {
  orchestrator: FactoryOrchestrator;
  git: FactoryGitMutator;
  implementer: FactoryImplementer;
  verifier: FactoryVerifier;
  baseRef?: string;
  commitMessage?: string;
  repositoryInstincts?: string;
  additionalVerificationCommands?: string[];
  capabilityPolicy?: FactoryCapabilityPolicy;
};

/**
 * Runs the mutation stage through trusted workspace, Git, and verification
 * boundaries. Only structured command outcomes enter persisted factory state.
 */
export async function runControlledImplementation(
  plannedRun: FactoryRun,
  dependencies: ControlledImplementationDependencies,
): Promise<FactoryRun> {
  assertFactoryAutonomyGate(plannedRun, 'implementation');
  if (plannedRun.state === 'verifying') {
    return resumeVerification(plannedRun, dependencies);
  }
  const implementing = await dependencies.orchestrator.beginImplementation(plannedRun.id);
  if (!implementing.plan || !implementing.branch) {
    throw new Error(`Factory run ${implementing.id} is missing its plan or branch.`);
  }

  const implementerManifest = resolveStageCapabilities(
    'implementer',
    dependencies.capabilityPolicy,
  );
  assertContextSource(implementerManifest, 'issue');
  assertContextSource(implementerManifest, 'approved-plan');
  if (dependencies.repositoryInstincts) {
    assertContextSource(implementerManifest, 'repository-instincts');
  }
  const git = bindGitMutator(dependencies.git, implementerManifest);
  const workspace = await git.createWorkspace(
    implementing.id,
    implementing.branch,
    dependencies.baseRef,
  );
  await dependencies.implementer.implement({
    task: implementing.task,
    plan: implementing.plan,
    workspace,
    repositoryInstincts: dependencies.repositoryInstincts,
  });
  const commit = await git.commit(
    workspace,
    dependencies.commitMessage ?? `Implement issue #${implementing.task.issueNumber}`,
  );
  const verifying = await dependencies.orchestrator.recordImplementation(implementing.id, {
    workspaceId: workspace.id,
    commitSha: commit.commitSha,
    changedFiles: commit.changedFiles,
    commands: [],
  });
  return resumeVerification(verifying, dependencies);
}

async function resumeVerification(
  verifying: FactoryRun,
  dependencies: ControlledImplementationDependencies,
): Promise<FactoryRun> {
  if (!verifying.plan || !verifying.branch || !verifying.implementation) {
    throw new Error(`Factory run ${verifying.id} cannot resume verification.`);
  }
  const implementerManifest = resolveStageCapabilities(
    'implementer',
    dependencies.capabilityPolicy,
  );
  const verifierManifest = resolveStageCapabilities('verifier', dependencies.capabilityPolicy);
  assertContextSource(verifierManifest, 'workspace');
  assertContextSource(verifierManifest, 'verification-commands');
  const git = bindGitMutator(dependencies.git, implementerManifest);
  const verifier = bindVerifier(dependencies.verifier, verifierManifest);
  const workspace = await git.createWorkspace(verifying.id, verifying.branch, dependencies.baseRef);
  const approvedCommands = new Set(verifying.plan.verificationCommands);
  const commands = [
    ...new Set([
      ...verifying.plan.verificationCommands,
      ...(dependencies.additionalVerificationCommands ?? []).filter((command) =>
        approvedCommands.has(command),
      ),
    ]),
  ];
  const verification = await verifier.run(commands, workspace.path);
  const pristine = await bindGitMutator(dependencies.git, verifierManifest).isPristine(
    workspace,
    verifying.implementation.commitSha,
  );
  await dependencies.orchestrator.recordImplementation(verifying.id, {
    ...verifying.implementation,
    commands: verification.map(({ command, exitCode }) => ({ command, exitCode })),
  });

  const failed = verification.find((result) => result.exitCode !== 0);
  const failure = failed
    ? `Verification command failed with exit code ${failed.exitCode}: ${failed.command}`
    : pristine
      ? undefined
      : 'Verification commands modified the implementation or its commit history.';
  if (failure === undefined) {
    await dependencies.git.push(workspace, verifying.implementation.commitSha);
  }
  const result = await dependencies.orchestrator.recordVerification(
    verifying.id,
    failure === undefined,
    failure,
  );
  return result;
}
