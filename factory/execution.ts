/**
 * Execution backend contract for factory runs (ADR 0012 rejected Sprites; the
 * smolvm executor replaces it). `local` keeps the existing in-process path and
 * stays the default. Backends run untrusted candidate commands only; the
 * orchestrator keeps model calls, Git mutation, and publication.
 */

export const FACTORY_EXECUTORS = ['local', 'smolvm'] as const;
export type FactoryExecutor = (typeof FACTORY_EXECUTORS)[number];

/** Select the execution backend. An unknown value fails; there is no silent fallback. */
export function parseFactoryExecutor(env: Record<string, string | undefined>): FactoryExecutor {
  const value = env.FLOWLY_EXECUTOR;
  if (value === undefined || value === '') return 'local';
  if ((FACTORY_EXECUTORS as readonly string[]).includes(value)) return value as FactoryExecutor;
  throw new Error(
    `FLOWLY_EXECUTOR must be one of ${FACTORY_EXECUTORS.join(', ')}; got "${value}".`,
  );
}

/** One run attempt's isolated execution environment. */
export type ExecutionWorkspace = {
  runId: string;
  attempt: number;
  /** Backend resource name, such as the VM name. */
  name: string;
  /** Repository root inside the environment. */
  workdir: string;
};

export type ExecutionPrepareInput = {
  runId: string;
  attempt: number;
  /** Trusted `git archive` tarball of the pinned base SHA, on the orchestrator host. */
  archivePath: string;
};

export type ExecutionCommand = {
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type ExecutionState = 'running' | 'paused' | 'stopped' | 'missing' | 'unknown';

export type ExecutionStatus = { name: string; state: ExecutionState };

export interface ExecutionAdapter {
  /** Create a fresh environment that holds only the archived base tree. */
  prepare(input: ExecutionPrepareInput): Promise<ExecutionWorkspace>;
  /** Run one bounded command in the repository root. */
  execute(workspace: ExecutionWorkspace, command: ExecutionCommand): Promise<ExecutionResult>;
  inspect(runId: string, attempt: number): Promise<ExecutionStatus>;
  /** The workspace of an existing attempt environment. No side effect. */
  attach(runId: string, attempt: number): ExecutionWorkspace;
  /** Copy one host file into the environment. */
  copyIn(workspace: ExecutionWorkspace, hostPath: string, guestPath: string): Promise<void>;
  /** Copy one environment file to the host. The caller treats its content as untrusted. */
  copyOut(workspace: ExecutionWorkspace, guestPath: string, hostPath: string): Promise<void>;
  /**
   * Phase-boundary recovery: discard any environment left by this attempt and
   * prepare it again. It never resumes inside an interrupted command.
   */
  recover(input: ExecutionPrepareInput): Promise<ExecutionWorkspace>;
  /**
   * Delete the run's environments. Idempotent. With `upToAttempt`, only that
   * attempt and earlier ones, so a stale attempt cannot delete a newer one.
   */
  cleanup(runId: string, upToAttempt?: number): Promise<void>;
}
