import { stageCapabilitiesFromAudit, type NetworkCapability } from './capabilities.ts';
import {
  assertContextSource,
  assertRepositoryPathsUnrestricted,
  assertRepositoryRead,
  assertRepositoryWrite,
  assertToolAllowed,
  bindGitMutator,
  bindVerifier,
} from './capability-guard.ts';
import type { FactoryGitWorkspace } from './git.ts';
import {
  FactoryAttemptLimitError,
  FactoryLeaseHeldError,
  type FactoryOrchestrator,
} from './orchestrator.ts';
import { workspaceIdFor } from './workspace-lifecycle.ts';
import type { FactoryRun, FactoryRunExecution, FactoryTask, ImplementationPlan } from './types.ts';
import type { VerificationCommandResult } from './verification.ts';
import { assertFactoryAutonomyGate } from './autonomy.ts';

export type FactoryImplementerInput = {
  task: FactoryTask;
  plan: ImplementationPlan;
  workspace: FactoryGitWorkspace;
  repositoryInstincts?: string;
  /** Records where this attempt runs (executor, VM, base SHA) in the run store. */
  recordExecution?: (execution: Omit<FactoryRunExecution, 'attempt'>) => Promise<void>;
};

export type FactoryImplementer = {
  implement(input: FactoryImplementerInput): Promise<void>;
  /** Delete every executor resource of a run that stopped for good. Idempotent. */
  abandon?(runId: string): Promise<void>;
};

export type FactoryGitMutator = {
  createWorkspace(id: string, branch: string, baseRef?: string): Promise<FactoryGitWorkspace>;
  commit(
    workspace: FactoryGitWorkspace,
    message: string,
  ): Promise<{ commitSha: string; changedFiles: string[] }>;
  push(workspace: FactoryGitWorkspace, commitSha: string): Promise<void>;
  isPristine(workspace: FactoryGitWorkspace, commitSha: string): Promise<boolean>;
  complete?(id: string): Promise<void>;
  fail?(id: string): Promise<void>;
};

export type FactoryVerifier = {
  run(
    commands: string[],
    workspacePath: string,
    options?: { network: NetworkCapability },
  ): Promise<VerificationCommandResult[]>;
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
  // The workspace this call allocated. On failure only it is failed: after a
  // lease expiry, the run's current workspace may belong to a newer attempt.
  const owned: OwnedWorkspace = {};
  try {
    if (plannedRun.state === 'verifying') {
      // Phase-boundary recovery: claim the run, then verify the committed tree again.
      const resumed = await dependencies.orchestrator.resumeVerification(plannedRun.id);
      return await resumeVerification(resumed, dependencies, owned);
    }
    return await implementAndVerify(plannedRun, dependencies, owned);
  } catch (error) {
    // The lease holder owns the workspace; a refused claim must not fail it.
    if (error instanceof FactoryLeaseHeldError) throw error;
    if (owned.id) {
      await markWorkspaceFailed(dependencies.git, owned.id);
    } else if (error instanceof FactoryAttemptLimitError) {
      // The run failed for good, so no newer attempt exists: fail the last one.
      const current = await dependencies.orchestrator.get(plannedRun.id).catch(() => plannedRun);
      await markWorkspaceFailed(dependencies.git, currentWorkspaceId(current));
    }
    if (error instanceof FactoryAttemptLimitError) {
      await dependencies.implementer.abandon?.(plannedRun.id);
    }
    throw error;
  }
}

type OwnedWorkspace = { id?: string };

/** How often a long verification extends the implementation lease. */
export const LEASE_HEARTBEAT_MS = 5 * 60_000;

async function implementAndVerify(
  plannedRun: FactoryRun,
  dependencies: ControlledImplementationDependencies,
  owned: OwnedWorkspace,
): Promise<FactoryRun> {
  const implementing = await dependencies.orchestrator.beginImplementation(plannedRun.id);
  if (!implementing.plan || !implementing.branch) {
    throw new Error(`Factory run ${implementing.id} is missing its plan or branch.`);
  }

  const implementerManifest = stageCapabilitiesFromAudit(implementing.capabilities, 'implementer');
  assertRepositoryRead(implementerManifest);
  assertRepositoryWrite(implementerManifest);
  assertRepositoryPathsUnrestricted(implementerManifest);
  for (const tool of ['list_files', 'read_file', 'write_file', 'search_code', 'bash']) {
    assertToolAllowed(implementerManifest, tool);
  }
  assertContextSource(implementerManifest, 'issue');
  assertContextSource(implementerManifest, 'approved-plan');
  if (dependencies.repositoryInstincts) {
    assertContextSource(implementerManifest, 'repository-instincts');
  }
  const git = bindGitMutator(dependencies.git, implementerManifest);
  // Each attempt gets a fresh clone (`<runId>-a<N>`); a dirty tree is never reused.
  owned.id = currentWorkspaceId(implementing);
  const workspace = await git.createWorkspace(owned.id, implementing.branch, dependencies.baseRef);
  await dependencies.implementer.implement({
    task: implementing.task,
    plan: implementing.plan,
    workspace,
    repositoryInstincts: dependencies.repositoryInstincts,
    recordExecution: async (execution) => {
      await dependencies.orchestrator.recordExecution(implementing.id, execution);
    },
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
  return resumeVerification(verifying, dependencies, owned);
}

/** The recorded workspace, else the clone of the current lease attempt. */
function currentWorkspaceId(run: FactoryRun): string {
  return (
    run.implementation?.workspaceId ?? workspaceIdFor(run.id, run.implementationLease?.attempt ?? 1)
  );
}

async function withLeaseHeartbeat<T>(
  orchestrator: FactoryOrchestrator,
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    // A lost lease is detected by the fenced writes that follow verification.
    renewal = renewal.then(() => orchestrator.renewImplementationLease(id).then(() => undefined));
    renewal = renewal.catch(() => undefined);
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

async function markWorkspaceFailed(git: FactoryGitMutator, id: string): Promise<void> {
  try {
    await git.fail?.(id);
  } catch {
    // Preserve the stage error when allocation did not create a workspace or cleanup also fails.
  }
}

async function resumeVerification(
  verifying: FactoryRun,
  dependencies: ControlledImplementationDependencies,
  owned: OwnedWorkspace,
): Promise<FactoryRun> {
  if (!verifying.plan || !verifying.branch || !verifying.implementation) {
    throw new Error(`Factory run ${verifying.id} cannot resume verification.`);
  }
  const implementerManifest = stageCapabilitiesFromAudit(verifying.capabilities, 'implementer');
  const verifierManifest = stageCapabilitiesFromAudit(verifying.capabilities, 'verifier');
  assertRepositoryRead(verifierManifest);
  assertRepositoryPathsUnrestricted(verifierManifest);
  assertToolAllowed(verifierManifest, 'bash');
  assertContextSource(verifierManifest, 'workspace');
  assertContextSource(verifierManifest, 'verification-commands');
  const git = bindGitMutator(dependencies.git, implementerManifest);
  const verifier = bindVerifier(dependencies.verifier, verifierManifest);
  owned.id = verifying.implementation.workspaceId;
  const workspace = await git.createWorkspace(owned.id, verifying.branch, dependencies.baseRef);
  const approvedCommands = new Set(verifying.plan.verificationCommands);
  const commands = [
    ...new Set([
      ...verifying.plan.verificationCommands,
      ...(dependencies.additionalVerificationCommands ?? []).filter((command) =>
        approvedCommands.has(command),
      ),
    ]),
  ];
  // A new lease period starts here, and a heartbeat keeps it live while the
  // commands run. No other store write happens during verifier.run.
  await dependencies.orchestrator.renewImplementationLease(verifying.id);
  const verification = await withLeaseHeartbeat(dependencies.orchestrator, verifying.id, () =>
    verifier.run(commands, workspace.path),
  );
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
    await git.push(workspace, verifying.implementation.commitSha);
    await git.complete?.(workspace.id);
  } else {
    await git.fail?.(workspace.id);
  }
  const result = await dependencies.orchestrator.recordVerification(
    verifying.id,
    failure === undefined,
    failure,
  );
  return result;
}
