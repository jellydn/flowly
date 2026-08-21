import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 1_000;

export type VerificationCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type FactoryVerificationOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
};

/** Executes planner-selected repository checks sequentially in the isolated clone. */
export class FactoryVerificationRunner {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: FactoryVerificationOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Factory verification timeout must be a positive integer.');
    }
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new Error('Factory verification output limit must be a positive integer.');
    }
    this.env = options.env ?? safeEnvironment();
  }

  async run(commands: string[], workspacePath: string): Promise<VerificationCommandResult[]> {
    if (commands.length === 0 || commands.length > MAX_COMMANDS) {
      throw new Error(
        `Factory plans must contain between 1 and ${MAX_COMMANDS} verification commands.`,
      );
    }
    const results: VerificationCommandResult[] = [];
    for (const command of commands) {
      assertCommand(command);
      results.push(await this.runCommand(command, workspacePath));
    }
    return results;
  }

  private runCommand(command: string, cwd: string): Promise<VerificationCommandResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        detached: true,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk, this.maxOutputBytes);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk, this.maxOutputBytes);
      });
      child.once('error', reject);
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child.pid);
      }, this.timeoutMs);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
    });
  }
}

function assertCommand(command: string): void {
  if (!command.trim() || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) {
    throw new Error('Factory verification command is empty or exceeds its allowed size.');
  }
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const remaining = limit - current.length;
  return remaining <= 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
}

function terminateProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The process may have exited between the timeout and signal delivery.
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    CI: 'true',
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  };
}
