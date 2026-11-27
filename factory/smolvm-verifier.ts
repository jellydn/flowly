import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FactoryVerifier } from './implementation.ts';
import type { ExecutionAdapter } from './execution.ts';
import { UUID } from './smolvm.ts';
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

/** Makes `git archive` write the committed tree as Git checks it out. */
const RAW_ARCHIVE_ATTRIBUTES = '* -export-ignore -export-subst';

/**
 * Archive the committed tree only: no working-tree edits and no `.git`
 * metadata. In-tree `export-ignore` and `export-subst` attributes would drop
 * or rewrite files, and the import would then delete or change them in the
 * clone, so the clone's `info/attributes` (which wins over in-tree files)
 * turns both off. That file is not tracked and changes no other Git output.
 */
export const gitArchiveHead: TreeArchiver = async (workspacePath, archivePath) => {
  const git = (args: string[]) =>
    execFileAsync('git', ['-C', workspacePath, ...args], { timeout: 120_000 });
  const attributesPath = path.resolve(
    workspacePath,
    (await git(['rev-parse', '--git-path', 'info/attributes'])).stdout.trim(),
  );
  const current = await readFile(attributesPath, 'utf8').catch(() => '');
  if (!current.split('\n').includes(RAW_ARCHIVE_ATTRIBUTES)) {
    await mkdir(path.dirname(attributesPath), { recursive: true });
    await writeFile(
      attributesPath,
      `${current}${current && !current.endsWith('\n') ? '\n' : ''}${RAW_ARCHIVE_ATTRIBUTES}\n`,
    );
  }
  await git(['archive', '--format=tar', '-o', archivePath, 'HEAD']);
};

/**
 * Runs plan checks in a fresh offline smolvm VM built from the committed tree,
 * so the evidence applies to exactly the commit that Flowly pushes. The VM has
 * no network, which is at least as strict as any verifier network capability.
 * Every VM of the run is deleted afterwards, also on failure.
 */
export class SmolvmFactoryVerifier implements FactoryVerifier {
  constructor(
    private readonly vms: Pick<ExecutionAdapter, 'recover' | 'execute' | 'cleanup'>,
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
      await this.vms.cleanup(runId, attempt);
    }
  }

  private bound(output: string): string {
    return Buffer.from(output).subarray(0, this.maxOutputBytes).toString('utf8');
  }
}
