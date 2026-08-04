import type { ErrorCategory } from './errors.ts';

/**
 * The shared env-gated stderr sink behind both loggers. One implementation
 * owns the enabled check and stderr write; the debug and reliability loggers
 * are thin formatters over it.
 */
export type LineLogger = {
  log(line: string): void;
};

/**
 * Env-gated stderr logger. Both {@link createDebugLogger} (tools/repository)
 * and {@link createReliabilityLogger} build on this single sink, so the
 * enabled gate and output target live in exactly one place.
 */
export function createLineLogger(enabled: boolean, prefix: string): LineLogger {
  return {
    log(line) {
      if (enabled) console.error(`${prefix} ${line}`);
    },
  };
}

/**
 * Structured event emitted by the retry and fallback layers for observability.
 * Never contains secrets, file contents, or absolute paths.
 */
export type ReliabilityEvent = {
  operation: string;
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  errorCategory?: ErrorCategory;
  retried: boolean;
  fallbackUsed: boolean;
  outcome: 'success' | 'error' | 'fallback_success' | 'fallback_failed' | 'partial';
  message?: string;
};

export type ReliabilityLogger = {
  log(event: ReliabilityEvent): void;
};

/**
 * Safe structured logger. Controlled by REPO_ASSISTANT_DEBUG. Logs one JSON
 * line per event to stderr. Never logs secrets, file contents, or absolute
 * paths—only the operation name, attempt counts, duration, error category,
 * and outcome.
 */
export function createReliabilityLogger(enabled: boolean): ReliabilityLogger {
  const sink = createLineLogger(enabled, '[repo-assistant:reliability]');
  return {
    log(event) {
      const safe = {
        operation: event.operation,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        durationMs: Math.round(event.durationMs),
        errorCategory: event.errorCategory ?? null,
        retried: event.retried,
        fallbackUsed: event.fallbackUsed,
        outcome: event.outcome,
      };
      sink.log(JSON.stringify(safe));
    },
  };
}
