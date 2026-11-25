import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxFromDriver,
  type FileStat,
  type SandboxDriver,
  type SandboxFactory,
} from '@flue/runtime';
import type { ExecutionWorkspace } from './execution.ts';
import { SmolvmExecutionAdapter, createSmolvmCommandRunner, parseSmolvmConfig } from './smolvm.ts';

type GuestAdapter = Pick<SmolvmExecutionAdapter, 'execute' | 'copyIn'>;

/**
 * Flue sandbox driver over one smolvm attempt VM. The agent loop and the model
 * key stay in the orchestrator process; every file and shell tool call runs in
 * the offline guest, confined to the repository root.
 */
export function createSmolvmSandboxDriver(
  adapter: GuestAdapter,
  workspace: ExecutionWorkspace,
): SandboxDriver {
  const guestPath = (target: string): string => {
    const resolved = path.posix.resolve(workspace.workdir, target);
    if (resolved !== workspace.workdir && !resolved.startsWith(`${workspace.workdir}/`)) {
      throw new Error(`Path "${target}" is outside the smolvm workspace ${workspace.workdir}.`);
    }
    return resolved;
  };
  const run = async (command: string, target: string) => {
    const result = await adapter.execute(workspace, { command });
    if (result.exitCode !== 0) throw fileError(target, result.stderr);
    return result;
  };

  return {
    async readFile(target) {
      return (await run(`cat -- ${quote(guestPath(target))}`, target)).stdout;
    },
    async readFileBuffer(target) {
      const { stdout } = await run(`base64 < ${quote(guestPath(target))}`, target);
      return new Uint8Array(Buffer.from(stdout, 'base64'));
    },
    async writeFile(target, content) {
      const destination = guestPath(target);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'flowly-smolvm-write-'));
      try {
        const hostPath = path.join(directory, 'content');
        await writeFile(hostPath, content);
        await run(`mkdir -p -- ${quote(path.posix.dirname(destination))}`, target);
        await adapter.copyIn(workspace, hostPath, destination);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async stat(target): Promise<FileStat> {
      const { stdout } = await run(`stat -c '%F|%s|%Y' -- ${quote(guestPath(target))}`, target);
      const [type = '', size = '0', mtime = '0'] = stdout.trim().split('|');
      return {
        isFile: type.startsWith('regular'),
        isDirectory: type === 'directory',
        isSymbolicLink: type === 'symbolic link',
        size: Number(size),
        mtime: new Date(Number(mtime) * 1000),
      };
    },
    async readdir(target) {
      const { stdout } = await run(`ls -A1 -- ${quote(guestPath(target))}`, target);
      return stdout.split('\n').filter(Boolean);
    },
    async exists(target) {
      const file = quote(guestPath(target));
      return (
        (await adapter.execute(workspace, { command: `test -e ${file} || test -L ${file}` }))
          .exitCode === 0
      );
    },
    async mkdir(target, options) {
      await run(`mkdir ${options?.recursive ? '-p ' : ''}-- ${quote(guestPath(target))}`, target);
    },
    async rm(target, options) {
      const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
      await run(`rm ${flags ? `-${flags} ` : ''}-- ${quote(guestPath(target))}`, target);
    },
    async exec(command, options = {}) {
      const result = await adapter.execute(
        { ...workspace, workdir: guestPath(options.cwd ?? workspace.workdir) },
        { command, env: options.env, timeoutMs: options.timeoutMs },
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.timedOut ? 124 : result.exitCode,
      };
    },
  };
}

/**
 * Sandbox for the implementer agent process. The host-side implementer sets
 * FLOWLY_SMOLVM_RUN_ID and FLOWLY_SMOLVM_ATTEMPT; without them the agent keeps
 * its local just-bash sandbox.
 */
export function createSmolvmSandboxFactory(
  env: Record<string, string | undefined>,
): SandboxFactory | undefined {
  const runId = env.FLOWLY_SMOLVM_RUN_ID;
  if (!runId) return undefined;
  const adapter = new SmolvmExecutionAdapter(parseSmolvmConfig(env), createSmolvmCommandRunner());
  const workspace = adapter.attach(runId, Number(env.FLOWLY_SMOLVM_ATTEMPT ?? '1'));
  return {
    createSandbox: async () =>
      sandboxFromDriver(createSmolvmSandboxDriver(adapter, workspace), workspace.workdir),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fileError(target: string, stderr: string): Error {
  const detail = stderr.trim().split('\n').at(-1) ?? '';
  const error = new Error(`smolvm guest file operation failed for "${target}": ${detail}`);
  if (/no such file/i.test(stderr)) (error as NodeJS.ErrnoException).code = 'ENOENT';
  return error;
}
