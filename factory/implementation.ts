import type { FactoryGitWorkspace } from './git.ts';
import type { FactoryOrchestrator } from './orchestrator.ts';
import type { FactoryRun, FactoryTask, ImplementationPlan } from './types.ts';
import type { VerificationCommandResult } from './verification.ts';

export type FactoryImplementerInput = {
  task: FactoryTask;
  plan: ImplementationPlan;
  workspace: FactoryGitWorkspace;
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
};

/**
 * Runs the mutation stage through trusted workspace, Git, and verification
 * boundaries. Only structured command outcomes enter persisted factory state.
 */
export async function runControlledImplementation(
  plannedRun: FactoryRun,
  dependencies: ControlledImplementationDependencies,
): Promise<FactoryRun> {
  const implementing = await dependencies.orchestrator.beginImplementation(plannedRun.id);
  if (!implementing.plan || !implementing.branch) {
    throw new Error(`Factory run ${implementing.id} is missing its plan or branch.`);
  }

  const workspace = await dependencies.git.createWorkspace(
    implementing.id,
    implementing.branch,
    dependencies.baseRef,
  );
  await dependencies.implementer.implement({
    task: implementing.task,
    plan: implementing.plan,
    workspace,
  });
  const commit = await dependencies.git.commit(
    workspace,
    dependencies.commitMessage ?? `Implement issue #${implementing.task.issueNumber}`,
  );
  const verification = await dependencies.verifier.run(
    implementing.plan.verificationCommands,
    workspace.path,
  );
  const pristine = await dependencies.git.isPristine(workspace, commit.commitSha);
  await dependencies.orchestrator.recordImplementation(implementing.id, {
    workspaceId: workspace.id,
    commitSha: commit.commitSha,
    changedFiles: commit.changedFiles,
    commands: verification.map(({ command, exitCode }) => ({ command, exitCode })),
  });

  const failed = verification.find((result) => result.exitCode !== 0);
  const failure = failed
    ? `Verification command failed with exit code ${failed.exitCode}: ${failed.command}`
    : pristine
      ? undefined
      : 'Verification commands modified the implementation or its commit history.';
  if (failure === undefined) {
    await dependencies.git.push(workspace, commit.commitSha);
  }
  return dependencies.orchestrator.recordVerification(
    implementing.id,
    failure === undefined,
    failure,
  );
}
