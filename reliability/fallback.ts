import type { ToolDefinition } from '@flue/runtime';
import type { DebugLogger, InspectionMetadata, StepBudget } from '../tools/repository.ts';
import { isBudgetFreeTool } from '../tools/repository.ts';
import { runReliableAttempt } from './resilient-tool.ts';
import { classifyError } from './errors.ts';
import type { ReliabilityLogger } from './observability.ts';
import type { FailureInjector } from './failure-injection.ts';
import { noFailureInjection } from './failure-injection.ts';
import type { RetryConfig, SleepFn } from './retry.ts';

/**
 * Fallback behaviour: when `search_code` repeatedly fails, attempt a direct
 * `read_file` if the requested path is known (e.g. from a plan step or a
 * previous partial result). If both fail, return a clear partial-response
 * message explaining what could not be retrieved.
 *
 * The fallback is implemented as a tool wrapper around search_code that
 * transparently falls back to read_file. It consumes exactly one inspection
 * step for each logical attempt; retry attempts are handled internally by the
 * shared resilience module. Raw tools passed here must be budget-free.
 */

export type FallbackOptions = {
  injector?: FailureInjector;
  sleep?: SleepFn;
  signal?: AbortSignal;
};

export type FallbackResult = {
  primaryTool: string;
  primarySucceeded: boolean;
  fallbackUsed: boolean;
  fallbackSucceeded: boolean;
  result: unknown;
  partialMessage?: string;
  inspection: InspectionMetadata;
};

/**
 * Attempt search_code; if it fails, attempt read_file with the known path;
 * if both fail, return a partial-response message. Never fabricates data.
 */
export async function executeWithFallback(
  primaryTool: ToolDefinition,
  fallbackTool: ToolDefinition | undefined,
  input: Record<string, unknown>,
  knownPath: string | undefined,
  operation: string,
  budget: StepBudget,
  debug: DebugLogger,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
  options: FallbackOptions = {},
): Promise<FallbackResult> {
  options.signal?.throwIfAborted();
  if (!isBudgetFreeTool(primaryTool)) {
    throw new Error('Primary fallback tool must be marked as budget-free.');
  }
  if (fallbackTool && !isBudgetFreeTool(fallbackTool)) {
    throw new Error('Fallback tool must be marked as budget-free.');
  }
  const rawPrimaryTool = primaryTool;
  const rawFallbackTool = fallbackTool;
  let inspection: InspectionMetadata;
  try {
    inspection = budget.consume(rawPrimaryTool.name);
  } catch (error) {
    return {
      primaryTool: rawPrimaryTool.name,
      primarySucceeded: false,
      fallbackUsed: false,
      fallbackSucceeded: false,
      result: null,
      partialMessage: error instanceof Error ? error.message : String(error),
      inspection: budget.snapshot(),
    };
  }

  // Try primary (search_code) through the shared resilience module.
  try {
    const result = await runReliableAttempt(
      rawPrimaryTool,
      input,
      operation,
      retryConfig,
      reliabilityLog,
      options.injector ?? noFailureInjection,
      options.sleep,
      { inspection, debug, signal: options.signal },
    );

    reliabilityLog.log({
      operation: `${operation}:fallback`,
      attempt: 1,
      maxAttempts: 1,
      durationMs: 0,
      retried: false,
      fallbackUsed: false,
      outcome: 'success',
    });

    return {
      primaryTool: rawPrimaryTool.name,
      primarySucceeded: true,
      fallbackUsed: false,
      fallbackSucceeded: false,
      result,
      inspection,
    };
  } catch (primaryError) {
    if (options.signal?.aborted) throw primaryError;
    const classifiedPrimary = classifyError(primaryError);

    // Don't fallback for permanent errors (auth, permission, not found)
    if (!classifiedPrimary.retryable) {
      reliabilityLog.log({
        operation: `${operation}:fallback`,
        attempt: 1,
        maxAttempts: 1,
        durationMs: 0,
        errorCategory: classifiedPrimary.category,
        retried: false,
        fallbackUsed: false,
        outcome: 'fallback_failed',
        message: classifiedPrimary.userMessage,
      });

      return {
        primaryTool: rawPrimaryTool.name,
        primarySucceeded: false,
        fallbackUsed: false,
        fallbackSucceeded: false,
        result: null,
        partialMessage: classifiedPrimary.userMessage,
        inspection,
      };
    }

    // Try fallback (read_file) if we have a known path
    if (rawFallbackTool && knownPath) {
      try {
        options.signal?.throwIfAborted();
        if (budget.remaining <= 0) {
          return {
            primaryTool: rawPrimaryTool.name,
            primarySucceeded: false,
            fallbackUsed: false,
            fallbackSucceeded: false,
            result: null,
            partialMessage: 'The inspection budget is exhausted before the fallback could run.',
            inspection: budget.snapshot(),
          };
        }
        const fallbackInspection = budget.consume(rawFallbackTool.name);
        const fallbackResult = await runReliableAttempt(
          rawFallbackTool,
          { path: knownPath, startLine: 1 },
          `${operation}:fallback`,
          retryConfig,
          reliabilityLog,
          options.injector ?? noFailureInjection,
          options.sleep,
          { inspection: fallbackInspection, debug, signal: options.signal },
        );

        reliabilityLog.log({
          operation: `${operation}:fallback`,
          attempt: 1,
          maxAttempts: 1,
          durationMs: 0,
          retried: false,
          fallbackUsed: true,
          outcome: 'fallback_success',
        });

        return {
          primaryTool: rawPrimaryTool.name,
          primarySucceeded: false,
          fallbackUsed: true,
          fallbackSucceeded: true,
          result: fallbackResult,
          partialMessage:
            'Repository search is temporarily unavailable. I used direct file reading as a fallback and found partial context.',
          inspection: fallbackInspection,
        };
      } catch (fallbackError) {
        if (options.signal?.aborted) throw fallbackError;
        const classifiedFallback = classifyError(fallbackError);
        reliabilityLog.log({
          operation: `${operation}:fallback`,
          attempt: 1,
          maxAttempts: 1,
          durationMs: 0,
          errorCategory: classifiedFallback.category,
          retried: false,
          fallbackUsed: true,
          outcome: 'fallback_failed',
          message: classifiedFallback.userMessage,
        });

        return {
          primaryTool: rawPrimaryTool.name,
          primarySucceeded: false,
          fallbackUsed: true,
          fallbackSucceeded: false,
          result: null,
          partialMessage:
            'Repository search is temporarily unavailable and the fallback file read also failed. I could not verify the answer. You can retry the request.',
          inspection: budget.snapshot(),
        };
      }
    }

    // No fallback available or no known path
    reliabilityLog.log({
      operation: `${operation}:fallback`,
      attempt: 1,
      maxAttempts: 1,
      durationMs: 0,
      errorCategory: classifiedPrimary.category,
      retried: false,
      fallbackUsed: false,
      outcome: 'fallback_failed',
      message: classifiedPrimary.userMessage,
    });

    return {
      primaryTool: rawPrimaryTool.name,
      primarySucceeded: false,
      fallbackUsed: false,
      fallbackSucceeded: false,
      result: null,
      partialMessage: `${classifiedPrimary.userMessage} You can retry the request.`,
      inspection,
    };
  }
}

/** User-facing messages for common failure scenarios. */
export const FALLBACK_MESSAGES = {
  searchFailed: 'Repository search is temporarily unavailable. I could not verify the answer.',
  fallbackSucceeded: 'I found partial context using a fallback, but the primary search failed.',
  bothFailed:
    'Repository search and the fallback file read both failed. I could not retrieve the information. You can retry the request.',
  partial: 'I found partial context, but one supporting file could not be loaded.',
} as const;
