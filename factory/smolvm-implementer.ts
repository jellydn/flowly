import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImplementerRunner } from './agent-implementer.ts';
import type { FactoryImplementer } from './implementation.ts';
import type { SmolvmExecutionAdapter } from './smolvm.ts';
import { gitArchiveHead, parseWorkspaceRun, type TreeArchiver } from './smolvm-verifier.ts';
import {
  DEFAULT_TREE_ARCHIVE_LIMITS,
  importTree,
  parseTreeArchive,
  type TreeArchiveLimits,
} from './tree-import.ts';

const GUEST_OUTPUT = '/tmp/flowly-candidate.tar';

export type SmolvmImplementerOptions = {
  vms: Pick<SmolvmExecutionAdapter, 'recover' | 'execute' | 'copyOut' | 'cleanup'>;
  /** Runs the Flue implementer agent on the host; its tools reach the VM. */
  runAgent: ImplementerRunner;
  archive?: TreeArchiver;
  limits?: TreeArchiveLimits;
};

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
  return {
    async implement(input) {
      const { runId, attempt } = parseWorkspaceRun(input.workspace.id);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'flowly-implement-'));
      try {
        const basePath = path.join(directory, 'base.tar');
        await archive(input.workspace.path, basePath);
        // recover: discard any VM an interrupted attempt left, then prepare a fresh one.
        const vm = await options.vms.recover({ runId, attempt, archivePath: basePath });
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
