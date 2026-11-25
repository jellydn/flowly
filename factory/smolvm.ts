import { execFile } from 'node:child_process';
import type {
  ExecutionAdapter,
  ExecutionCommand,
  ExecutionPrepareInput,
  ExecutionResult,
  ExecutionState,
  ExecutionStatus,
  ExecutionWorkspace,
} from './execution.ts';

/**
 * smolvm execution backend. Every run attempt gets one microVM with its own
 * kernel, created WITHOUT `--net`, so the worker has no egress. The base tree
 * enters through `machine cp` as a tar that the guest unpacks with `tar`, so
 * the guest image needs no Git. No host directory is mounted.
 */

export type SmolvmCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Runs `smolvm <args>` on the orchestrator host. Injected so tests use fakes. */
export type SmolvmCommandRunner = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<SmolvmCommandResult>;

export type SmolvmSource = { image: string } | { pack: string };

export type SmolvmConfig = {
  prefix: string;
  source: SmolvmSource;
  cpus: number;
  memoryMb: number;
  commandTimeoutMs: number;
  maxAttempts: number;
};

const WORKDIR = '/work';
const GUEST_ARCHIVE = '/tmp/flowly-source.tar';
const CONTROL_TIMEOUT_MS = 120_000;
/** `machine start` pulls the image on the host the first time, so it gets more time. */
const START_TIMEOUT_MS = 600_000;
const PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
/** Factory run ids are UUIDs; requiring that shape keeps the name filter strict. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN_ID_PATTERN = new RegExp(`^${UUID}$`);
const SECRET_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL/i;
/**
 * smolvm can write WARN and progress lines to stderr and still succeed, so
 * failure is decided only by the exit code. `delete` uses the JSON error
 * format (verified on smolvm 1.37.0) to tell "not found" from other failures.
 */
const ERROR_FORMAT = ['--error-format', 'json'];

type SmolvmMachine = ExecutionStatus & { network: boolean };

/** Parse smolvm executor settings. Only called when FLOWLY_EXECUTOR=smolvm. */
export function parseSmolvmConfig(env: Record<string, string | undefined>): SmolvmConfig {
  const prefix = env.FLOWLY_VM_PREFIX || 'flowly';
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error('FLOWLY_VM_PREFIX must match [a-z][a-z0-9-]{0,30}.');
  }
  const image = env.FLOWLY_VM_IMAGE || undefined;
  const pack = env.FLOWLY_VM_BASE_PACK || undefined;
  if (Boolean(image) === Boolean(pack)) {
    throw new Error(
      'Set exactly one of FLOWLY_VM_IMAGE or FLOWLY_VM_BASE_PACK for the smolvm executor.',
    );
  }
  return {
    prefix,
    source: image ? { image } : { pack: pack! },
    cpus: integer(env.FLOWLY_VM_CPUS, 2, 1, 8, 'FLOWLY_VM_CPUS'),
    memoryMb: integer(env.FLOWLY_VM_MEMORY_MB, 4096, 512, 16_384, 'FLOWLY_VM_MEMORY_MB'),
    commandTimeoutMs: integer(env.FLOWLY_RUN_TIMEOUT, 1800, 1, 7200, 'FLOWLY_RUN_TIMEOUT') * 1000,
    maxAttempts: integer(env.FLOWLY_MAX_ATTEMPTS, 3, 1, 10, 'FLOWLY_MAX_ATTEMPTS'),
  };
}

/** Fail before any side effect when the smolvm CLI cannot run. */
export async function assertSmolvmAvailable(runner: SmolvmCommandRunner): Promise<void> {
  let result: SmolvmCommandResult;
  try {
    result = await runner(['--version'], { timeoutMs: 10_000 });
  } catch (error) {
    throw new Error(
      `FLOWLY_EXECUTOR=smolvm requires the smolvm CLI (brew install smol-machines/tap/smolvm): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `FLOWLY_EXECUTOR=smolvm requires a working smolvm CLI; "smolvm --version" exited ${result.exitCode}.`,
    );
  }
}

/**
 * Real runner. The CLI receives only PATH and HOME, so orchestrator secrets
 * never reach smolvm or the guest.
 */
export function createSmolvmCommandRunner(binary = 'smolvm'): SmolvmCommandRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          timeout: options.timeoutMs ?? CONTROL_TIMEOUT_MS,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
          if (typeof failure.code === 'string') return reject(error);
          resolve({
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout,
            stderr,
            timedOut: failure.killed === true,
          });
        },
      );
    });
}

export class SmolvmExecutionAdapter implements ExecutionAdapter {
  constructor(
    private readonly config: SmolvmConfig,
    private readonly run: SmolvmCommandRunner,
    private readonly now: () => number = Date.now,
  ) {}

  machineName(runId: string, attempt: number): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid factory run id for smolvm: ${runId}`);
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid attempt: ${attempt}`);
    return `${this.config.prefix}-${runId}-a${attempt}`;
  }

  async prepare(input: ExecutionPrepareInput): Promise<ExecutionWorkspace> {
    if (input.attempt > this.config.maxAttempts) {
      throw new Error(
        `Factory run ${input.runId} reached the smolvm attempt limit (${this.config.maxAttempts}).`,
      );
    }
    const name = this.machineName(input.runId, input.attempt);
    const existing = await this.inspect(input.runId, input.attempt);
    if (existing.state !== 'missing') {
      throw new Error(`smolvm machine ${name} already exists (${existing.state}); use recover.`);
    }
    const source =
      'image' in this.config.source
        ? ['--image', this.config.source.image]
        : ['--from', this.config.source.pack];
    try {
      // No `--net`: networking stays off, so candidate code has no egress.
      await this.control([
        'machine',
        'create',
        '--name',
        name,
        ...source,
        '--cpus',
        String(this.config.cpus),
        '--mem',
        String(this.config.memoryMb),
      ]);
      await this.control(['machine', 'start', '--name', name], START_TIMEOUT_MS);
      const created = (await this.list()).find((machine) => machine.name === name);
      if (!created || created.network) {
        throw new Error(`smolvm machine ${name} must exist with networking off.`);
      }
      await this.control(['machine', 'cp', input.archivePath, `${name}:${GUEST_ARCHIVE}`]);
      await this.control([
        'machine',
        'exec',
        '--name',
        name,
        '--',
        'sh',
        '-c',
        `mkdir -p ${WORKDIR} && tar -xf ${GUEST_ARCHIVE} -C ${WORKDIR} && rm ${GUEST_ARCHIVE}`,
      ]);
    } catch (error) {
      await this.deleteMachine(name).catch(() => undefined);
      throw error;
    }
    return { runId: input.runId, attempt: input.attempt, name, workdir: WORKDIR };
  }

  async execute(
    workspace: ExecutionWorkspace,
    command: ExecutionCommand,
  ): Promise<ExecutionResult> {
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SECRET_ENV_PATTERN.test(key)) {
        throw new Error(`Refusing to pass environment variable "${key}" into the smolvm guest.`);
      }
      envArgs.push('-e', `${key}=${value}`);
    }
    const startedAt = this.now();
    const result = await this.run(
      [
        'machine',
        'exec',
        '--name',
        workspace.name,
        '-w',
        workspace.workdir,
        ...envArgs,
        '--',
        'sh',
        '-lc',
        command.command,
      ],
      { timeoutMs: command.timeoutMs ?? this.config.commandTimeoutMs },
    );
    // Exit 1 with NOT_FOUND may also be guest output, so confirm with the host list.
    if (
      result.exitCode === 1 &&
      result.stderr.includes(`Error: vm not found: ${workspace.name}`) &&
      (await this.inspect(workspace.runId, workspace.attempt)).state === 'missing'
    ) {
      throw new Error(`smolvm machine ${workspace.name} no longer exists; recover the run.`);
    }
    return { ...result, durationMs: this.now() - startedAt };
  }

  async inspect(runId: string, attempt: number): Promise<ExecutionStatus> {
    const name = this.machineName(runId, attempt);
    const machine = (await this.list()).find((item) => item.name === name);
    return { name, state: machine?.state ?? 'missing' };
  }

  async recover(input: ExecutionPrepareInput): Promise<ExecutionWorkspace> {
    await this.deleteMachine(this.machineName(input.runId, input.attempt));
    return this.prepare(input);
  }

  async cleanup(runId: string): Promise<void> {
    this.machineName(runId, 1);
    for (const machine of await this.list()) {
      if (this.ownerOf(machine.name) === runId) await this.deleteMachine(machine.name);
    }
  }

  /** Delete prefixed machines that belong to no active run. Returns the deleted names. */
  async sweepOrphans(activeRunIds: ReadonlySet<string>): Promise<string[]> {
    const deleted: string[] = [];
    for (const machine of await this.list()) {
      const runId = this.ownerOf(machine.name);
      if (runId && !activeRunIds.has(runId)) {
        await this.deleteMachine(machine.name);
        deleted.push(machine.name);
      }
    }
    return deleted;
  }

  /** Run id of a machine this executor owns, or undefined for every other VM on the host. */
  private ownerOf(name: string): string | undefined {
    return new RegExp(`^${this.config.prefix}-(${UUID})-a[1-9]\\d*$`).exec(name)?.[1];
  }

  /** `machine ls --json` lists every VM on the host, including other tools' machines. */
  private async list(): Promise<SmolvmMachine[]> {
    const result = await this.control(['machine', 'ls', '--json']);
    return parseMachineList(result.stdout);
  }

  /** Idempotent: a machine that no longer exists counts as deleted. */
  private async deleteMachine(name: string): Promise<void> {
    const args = ['machine', 'delete', '--name', name, '--force', ...ERROR_FORMAT];
    const result = await this.run(args, { timeoutMs: CONTROL_TIMEOUT_MS });
    if (result.exitCode === 0 || isNotFound(result.stderr)) return;
    throw commandError(args, result);
  }

  private async control(
    args: string[],
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<SmolvmCommandResult> {
    const result = await this.run(args, { timeoutMs });
    if (result.exitCode !== 0) throw commandError(args, result);
    return result;
  }
}

/** Parse `smolvm machine ls --json`: a top-level array of every VM on the host. */
export function parseMachineList(stdout: string): SmolvmMachine[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('smolvm machine ls --json did not return an array.');
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') return [];
    const state: ExecutionState =
      record.state === 'running' || record.state === 'paused' || record.state === 'stopped'
        ? record.state
        : 'unknown';
    return [{ name: record.name, state, network: record.network !== false }];
  });
}

/** True when stderr starts with smolvm's `{"error":{"code":"NOT_FOUND",...}}` line. */
function isNotFound(stderr: string): boolean {
  try {
    const parsed = JSON.parse(stderr.trimStart().split('\n', 1)[0]) as {
      error?: { code?: unknown };
    };
    return parsed.error?.code === 'NOT_FOUND';
  } catch {
    return false;
  }
}

function commandError(args: string[], result: SmolvmCommandResult): Error {
  const detail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
  return new Error(
    `smolvm ${args.slice(0, 2).join(' ')} failed with exit code ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}: ${detail}`,
  );
}

function integer(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}].`);
  }
  return value;
}
