import { defineTool, type ToolDefinition } from '@flue/runtime';
import { invokeTool } from './tool-invocation.ts';
import type { DebugLogger, InspectionMetadata, StepBudget } from '../tools/repository.ts';
import { summarizeInput, wrapWithBudget } from '../tools/repository.ts';
import { classifyError, type ReliabilityError } from './errors.ts';
import { runWithRetry, type RetryConfig, type SleepFn, defaultSleep } from './retry.ts';
import type { ReliabilityLogger } from './observability.ts';
import type { FailureInjector } from './failure-injection.ts';
import { noFailureInjection } from './failure-injection.ts';
import {
  validateListResult,
  validateReadResult,
  validateRetrieveResult,
  validateSearchDocsResult,
  validateSearchResult,
  type ValidationResult,
} from './validation.ts';

export type ToolValidator<T> = (output: unknown) => ValidationResult<T>;

/** Shared error for attempts to compose a tool that is already sealed. */
const SEALED_TOOL_MESSAGE =
  'Tool is already composed (with reliability or an inspection budget); cannot compose again.';

/**
 * Tools that have already been composed (with an inspection budget and/or
 * reliability) and must not be composed again. Raw inspection tools are
 * budget-free by construction; this set only guards against double-wrapping.
 */
const sealedTools = new WeakSet<object>();

/** True when the tool has already been composed with a budget or reliability. */
export function isSealedTool(tool: object): boolean {
  return sealedTools.has(tool);
}

function markSealed<T extends object>(tool: T): T {
  sealedTools.add(tool);
  return tool;
}

const validators: Record<string, ToolValidator<unknown>> = {
  list_files: validateListResult,
  read_file: validateReadResult,
  search_code: validateSearchResult,
  search_docs: validateSearchDocsResult,
  retrieve: validateRetrieveResult,
};

/** Factory for a raw inspection tool. Raw tools are pure repository operations. */
export type InspectionToolFactory = () => ToolDefinition;

/**
 * Build a reliable inspection tool from its raw factory. Budget consumption
 * belongs to this seam; raw tools perform only the repository operation.
 */
export function createReliableInspectionTool(
  factory: InspectionToolFactory,
  budget: StepBudget,
  debug: DebugLogger,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
  injector: FailureInjector = noFailureInjection,
  sleep: SleepFn = defaultSleep,
): ToolDefinition {
  const rawTool = factory();
  return wrapToolWithReliability(
    rawTool,
    budget,
    debug,
    retryConfig,
    reliabilityLog,
    injector,
    sleep,
  );
}

/**
 * Wrap a raw tool with inspection-budget accounting: consume exactly one step
 * per logical call, attach the budget snapshot to the output, debug-log, and
 * wrap failures with the post-consumption snapshot. This is the standalone
 * composition seam for callers that want bounded inspection without the
 * reliability wrapper (PR reviewer, demos, tests, deterministic eval runs).
 */
export function withInspectionBudget(
  rawTool: ToolDefinition,
  budget: StepBudget,
  debug: DebugLogger,
): ToolDefinition {
  if (isSealedTool(rawTool)) {
    throw new Error(SEALED_TOOL_MESSAGE);
  }
  return markSealed(
    defineTool({
      name: rawTool.name,
      description: rawTool.description,
      input: rawTool.input,
      output: rawTool.output,
      async run({ data, signal }) {
        signal?.throwIfAborted();

        // Consume budget once for this logical call. Consumption happens
        // before the raw tool runs, so a call that fails input validation
        // (e.g. read_file's endLine < startLine check) still consumes one
        // step.
        const inspection: InspectionMetadata = budget.consume(rawTool.name);
        const inputSummary = summarizeInput(data);

        try {
          const rawOutput = await invokeTool<unknown>(rawTool, {
            toolCallId: `budgeted-${rawTool.name}`,
            data: data as Record<string, unknown>,
            signal,
          });
          const result = attachInspection(rawOutput, inspection);
          debug.log({
            tool: rawTool.name,
            status: 'success',
            inputSummary,
            count: countResult(rawTool.name, result),
            inspection,
          });
          return { output: result };
        } catch (error) {
          if (signal?.aborted) throw error;
          debug.log({
            tool: rawTool.name,
            status: 'error',
            inputSummary,
            inspection,
          });
          throw wrapWithBudget(error, rawTool.name, inspection);
        }
      },
    }),
  );
}

/**
 * Wrap an existing tool's `run` with retry, timeout, output validation, and
 * failure injection. The wrapper consumes exactly one inspection step per
 * *logical* call (not per retry attempt), so retries do not multiply budget
 * consumption.
 */
export type ReliableAttemptOptions = {
  inspection?: InspectionMetadata;
  debug?: DebugLogger;
  signal?: AbortSignal;
};

export async function runReliableAttempt(
  rawTool: ToolDefinition,
  data: Record<string, unknown>,
  operation: string,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
  injector: FailureInjector = noFailureInjection,
  sleep: SleepFn = defaultSleep,
  options: ReliableAttemptOptions = {},
): Promise<unknown> {
  if (isSealedTool(rawTool)) {
    throw new Error(SEALED_TOOL_MESSAGE);
  }

  const result = await runWithRetry(
    operation,
    async (retrySignal) => {
      const combinedSignal = options.signal
        ? AbortSignal.any([retrySignal, options.signal])
        : retrySignal;

      if (injector.shouldTimeout(rawTool.name)) {
        await new Promise<void>((_, reject) => {
          const onAbort = () => {
            combinedSignal.removeEventListener('abort', onAbort);
            reject(new Error('timeout: operation aborted'));
          };
          if (combinedSignal.aborted) {
            onAbort();
          } else {
            combinedSignal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }

      const injected = injector.maybeFail(rawTool.name, 0);
      if (injected) throw injected;

      const rawOutput = await invokeTool<unknown>(rawTool, {
        toolCallId: `retry-${rawTool.name}`,
        data,
        signal: combinedSignal,
      });

      if (injector.shouldMalform(rawTool.name)) {
        return {
          __malformed: true,
          garbage: '###not-json###',
          partial: 'garbled',
        };
      }
      return rawOutput;
    },
    retryConfig,
    reliabilityLog,
    sleep,
    options.signal,
  );

  const normalizedResult = options.inspection
    ? attachInspection(result, options.inspection)
    : result;
  const validator = validators[rawTool.name];
  if (validator) {
    const validation = validator(normalizedResult);
    if (!validation.ok) throw validation.error;
  }
  if (options.debug && options.inspection) {
    options.debug.log({
      tool: rawTool.name,
      status: 'success',
      inputSummary: summarizeInput(data),
      count: countResult(rawTool.name, normalizedResult),
      inspection: options.inspection,
    });
  }
  return normalizedResult;
}

export function wrapToolWithReliability(
  rawTool: ToolDefinition,
  budget: StepBudget,
  debug: DebugLogger,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
  injector: FailureInjector = noFailureInjection,
  sleep: SleepFn = defaultSleep,
): ToolDefinition {
  if (isSealedTool(rawTool)) {
    throw new Error(SEALED_TOOL_MESSAGE);
  }
  return markSealed(
    defineTool({
      name: rawTool.name,
      description: rawTool.description,
      input: rawTool.input,
      output: rawTool.output,
      async run({ data, signal }) {
        signal?.throwIfAborted();

        // Consume budget once for this logical call (not per retry)
        const inspection: InspectionMetadata = budget.consume(rawTool.name);
        const inputSummary = summarizeInput(data);

        try {
          const result = await runReliableAttempt(
            rawTool,
            data as Record<string, unknown>,
            rawTool.name,
            retryConfig,
            reliabilityLog,
            injector,
            sleep,
            { signal, inspection, debug },
          );

          return { output: result };
        } catch (error) {
          if (signal?.aborted) throw error;

          debug.log({
            tool: rawTool.name,
            status: 'error',
            inputSummary,
            inspection,
          });

          const classified = classifyError(error);
          throw wrapWithBudget(new SafeToolError(rawTool.name, classified), rawTool.name, inspection);
        }
      },
    }),
  );
}

/**
 * Error that exposes a user-safe message without stack traces, provider
 * internals, or API keys. The original error is preserved as `cause`.
 */
export class SafeToolError extends Error {
  constructor(
    readonly toolName: string,
    readonly reliabilityError: ReliabilityError,
  ) {
    super(`${toolName}: ${reliabilityError.userMessage}`, { cause: reliabilityError });
    this.name = 'SafeToolError';
  }
}

/**
 * Attach the budget snapshot to a raw tool payload. Raw tools no longer emit
 * `inspection`, so this always stamps the snapshot the seam consumed.
 */
function attachInspection(result: unknown, inspection: InspectionMetadata): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), inspection };
  }
  return result;
}

function countResult(toolName: string, result: unknown): number | undefined {
  if (toolName === 'search_code' || toolName === 'search_docs') {
    const matches = (result as { matches?: unknown[] })?.matches;
    return Array.isArray(matches) ? matches.length : undefined;
  }
  if (toolName === 'list_files') {
    const entries = (result as { entries?: unknown[] })?.entries;
    return Array.isArray(entries) ? entries.length : undefined;
  }
  if (toolName === 'read_file') {
    const total = (result as { totalLines?: number })?.totalLines;
    return total;
  }
  if (toolName === 'retrieve') {
    const results = (result as { results?: unknown[] })?.results;
    return Array.isArray(results) ? results.length : undefined;
  }
  return undefined;
}
