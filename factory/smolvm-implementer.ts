import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ImplementerRunner } from './agent-implementer.ts';
import type { FactoryGitMutator, FactoryImplementer } from './implementation.ts';
import type { SmolvmExecutionAdapter } from './smolvm.ts';
import { gitArchiveHead, parseWorkspaceRun, type TreeArchiver } from './smolvm-verifier.ts';
import {
  DEFAULT_TREE_ARCHIVE_LIMITS,
  importTree,
  parseTreeArchive,
  type TreeArchiveLimits,
} from './tree-import.ts';

const GUEST_OUTPUT = '/tmp/flowly-candidate.tar';
const execFileAsync = promisify(execFile);

/** The commit the trusted clone's HEAD points at: the base of this attempt. */
export async function gitHeadSha(workspacePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], {
    timeout: 30_000,
  });
  return stdout.trim();
}

export type SmolvmImplementerOptions = {
  vms: Pick<SmolvmExecutionAdapter, 'recover' | 'execute' | 'copyOut' | 'cleanup'>;
  /** Runs the Flue implementer agent on the host; its tools reach the VM. */
  runAgent: ImplementerRunner;
  archive?: TreeArchiver;
  resolveHead?: (workspacePath: string) => Promise<string>;
  limits?: TreeArchiveLimits;
};

/**
 * Git mutator for the experimental smolvm path: every trusted local operation
 * works, but `push` refuses, so a run stops after verification and before any
 * GitHub side effect. The evidence stays in the run store.
 */
export function stopBeforePush(git: FactoryGitMutator): FactoryGitMutator {
  return {
    createWorkspace: (id, branch, baseRef) => git.createWorkspace(id, branch, baseRef),
    commit: (workspace, message) => git.commit(workspace, message),
    isPristine: (workspace, commitSha) => git.isPristine(workspace, commitSha),
    complete: git.complete ? (id) => git.complete!(id) : undefined,
    fail: git.fail ? (id) => git.fail!(id) : undefined,
    async push(workspace, commitSha) {
      throw new Error(
        `FLOWLY_EXECUTOR=smolvm stops before push: commit ${commitSha} on ${workspace.branch} passed verification but was not pushed.`,
      );
    },
  };
}

/**
 * Implementation stage on smolvm. Each call is one phase-boundary attempt:
 * a fresh offline VM gets the committed tree of the trusted clone, the agent
 * edits it through the sandbox driver, and the result returns as a tar that
 * the trusted side validates before it writes the clone. The trusted Git
 * adapter then commits. The VM is deleted afterwards, also on failure.
 */
export function createSmolvmFactoryImplementer(
  options: SmolvmImplementerOptions,
): FactoryImplementer {
  const archive = options.archive ?? gitArchiveHead;
  const limits = options.limits ?? DEFAULT_TREE_ARCHIVE_LIMITS;
  const resolveHead = options.resolveHead ?? gitHeadSha;
  return {
    async implement(input) {
      const { runId, attempt } = parseWorkspaceRun(input.workspace.id);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'flowly-implement-'));
      try {
        const baseSha = await resolveHead(input.workspace.path);
        const basePath = path.join(directory, 'base.tar');
        await archive(input.workspace.path, basePath);
        // recover: discard any VM an interrupted attempt left, then prepare a fresh one.
        const vm = await options.vms.recover({ runId, attempt, archivePath: basePath });
        await input.recordExecution?.({ executor: 'smolvm', vmName: vm.name, baseSha });
        await options.runAgent(input, {
          FLOWLY_SMOLVM_RUN_ID: runId,
          FLOWLY_SMOLVM_ATTEMPT: String(attempt),
        });

        const packed = await options.vms.execute(vm, {
          command: `tar -cf ${GUEST_OUTPUT} -C ${vm.workdir} .`,
        });
        if (packed.exitCode !== 0) {
          throw new Error(
            `Packing the candidate tree in the VM failed with exit code ${packed.exitCode}.`,
          );
        }
        const candidatePath = path.join(directory, 'candidate.tar');
        await options.vms.copyOut(vm, GUEST_OUTPUT, candidatePath);
        const { size } = await stat(candidatePath);
        if (size > limits.maxBytes) {
          throw new Error(`Candidate archive is ${size} bytes; the limit is ${limits.maxBytes}.`);
        }
        const entries = parseTreeArchive(await readFile(candidatePath), limits);
        await importTree(input.workspace.path, entries);
      } finally {
        await rm(directory, { recursive: true, force: true });
        await options.vms.cleanup(runId);
      }
    },
  };
}
