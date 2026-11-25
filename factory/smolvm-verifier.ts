import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FactoryVerifier } from './implementation.ts';
import { UUID, type SmolvmExecutionAdapter } from './smolvm.ts';
import { assertVerificationCommands, type VerificationCommandResult } from './verification.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const WORKSPACE_ID_PATTERN = new RegExp(`^(${UUID})(?:-a([1-9]\\d*))?$`);

/** Run id and attempt from a factory workspace id (`<runId>` or `<runId>-a<N>`). */
export function parseWorkspaceRun(workspaceId: string): { runId: string; attempt: number } {
  const match = WORKSPACE_ID_PATTERN.exec(workspaceId);
  if (!match) throw new Error(`Cannot derive a factory run id from workspace ${workspaceId}.`);
  return { runId: match[1], attempt: Number(match[2] ?? '1') };
}

export type TreeArchiver = (workspacePath: string, archivePath: string) => Promise<void>;

/** Archive the committed tree only: no working-tree edits and no `.git` metadata. */
export const gitArchiveHead: TreeArchiver = async (workspacePath, archivePath) => {
  await execFileAsync(
    'git',
    ['-C', workspacePath, 'archive', '--format=tar', '-o', archivePath, 'HEAD'],
    {
      timeout: 120_000,
    },
  );
};

/**
 * Runs plan checks in a fresh offline smolvm VM built from the committed tree,
 * so the evidence applies to exactly the commit that Flowly pushes. The VM has
 * no network, which is at least as strict as any verifier network capability.
 * Every VM of the run is deleted afterwards, also on failure.
 */
export class SmolvmFactoryVerifier implements FactoryVerifier {
  constructor(
    private readonly vms: Pick<SmolvmExecutionAdapter, 'recover' | 'execute' | 'cleanup'>,
    private readonly archive: TreeArchiver = gitArchiveHead,
    private readonly maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  ) {}

  async run(commands: string[], workspacePath: string): Promise<VerificationCommandResult[]> {
    assertVerificationCommands(commands);
    const { runId, attempt } = parseWorkspaceRun(path.basename(workspacePath));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flowly-verify-'));
    try {
      const archivePath = path.join(directory, 'tree.tar');
      await this.archive(workspacePath, archivePath);
      const workspace = await this.vms.recover({ runId, attempt, archivePath });
      const results: VerificationCommandResult[] = [];
      for (const command of commands) {
        const result = await this.vms.execute(workspace, { command });
        results.push({
          command,
          exitCode: result.timedOut ? 124 : result.exitCode,
          stdout: this.bound(result.stdout),
          stderr: this.bound(result.stderr),
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        });
      }
      return results;
    } finally {
      await rm(directory, { recursive: true, force: true });
      await this.vms.cleanup(runId);
    }
  }

  private bound(output: string): string {
    return Buffer.from(output).subarray(0, this.maxOutputBytes).toString('utf8');
  }
}
