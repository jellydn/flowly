import type { ToolDefinition } from '@flue/runtime';
import { invokeTool } from '../reliability/tool-invocation.ts';

export type ToolRegistry =
  | Map<string, ToolDefinition>
  | Partial<Record<string, ToolDefinition>>;

export function resolveTool(
  tools: ToolRegistry,
  toolName: string,
): ToolDefinition | undefined {
  return tools instanceof Map ? tools.get(toolName) : tools[toolName];
}

export type ToolCallResult =
  | { ok: true; tool: string; output: unknown }
  | { ok: false; tool: string; error: string };

type WithMetadata<Metadata> = [Metadata] extends [never]
  ? { metadata?: never }
  : { metadata: Metadata };

export type ToolExecutionCall<Metadata = never> = {
  type: 'call';
  tool: string;
  input: Record<string, unknown>;
  toolCallId: string;
  preflight?: () => string | undefined;
  onResolved?: () => void;
} & WithMetadata<Metadata>;

export type ToolExecutionAction<Metadata = never> =
  | ToolExecutionCall<Metadata>
  | ({ type: 'skip'; tool: string; reason: string } & WithMetadata<Metadata>)
  | { type: 'stop'; reason: string };

export type ExecutionLoopAdapter<Result, Metadata = never> = {
  next(iteration: number):
    | Promise<ToolExecutionAction<Metadata>>
    | ToolExecutionAction<Metadata>;
  onResult(
    action: ToolExecutionCall<Metadata>,
    result: ToolCallResult,
  ): string | undefined;
  onSkip?(action: Extract<ToolExecutionAction<Metadata>, { type: 'skip' }>): void;
  finish(reason: string, iterations: number): Result;
};

/**
 * Run one bounded execution protocol for planner and investigation adapters.
 * The adapters choose what to do and interpret results; this module owns
 * iteration limits, cancellation, invocation, and the common call seam.
 */
export async function runExecutionLoop<Result, Metadata = never>(
  tools: ToolRegistry,
  adapter: ExecutionLoopAdapter<Result, Metadata>,
  options: { maxIterations: number; signal?: AbortSignal },
): Promise<Result> {
  let iteration = 0;

  while (iteration < options.maxIterations) {
    options.signal?.throwIfAborted();
    const action = await adapter.next(iteration);
    options.signal?.throwIfAborted();

    if (action.type === 'stop') {
      return adapter.finish(action.reason, iteration);
    }
    if (action.type === 'skip') {
      adapter.onSkip?.(action);
      iteration += 1;
      continue;
    }

    const result = await executeToolCall(
      tools,
      action.tool,
      action.input,
      action.toolCallId,
      options.signal,
      action.preflight,
      action.onResolved,
    );
    const stopReason = adapter.onResult(action, result);
    iteration += 1;
    if (stopReason) return adapter.finish(stopReason, iteration);
  }

  return adapter.finish('max iterations reached', iteration);
}

/**
 * Resolve and invoke one repository tool through the common call/result seam.
 * Callers keep their own policy (planning status, duplicate blocking, or
 * evidence extraction) while lookup, invocation, envelope handling, and error
 * normalization live here.
 */
export async function executeToolCall(
  tools: ToolRegistry,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  signal?: AbortSignal,
  preflight?: () => string | undefined,
  onResolved?: () => void,
): Promise<ToolCallResult> {
  const tool = resolveTool(tools, toolName);
  if (!tool) {
    return {
      ok: false,
      tool: toolName,
      error: `Unknown or unsupported tool: ${toolName}`,
    };
  }

  const preflightError = preflight?.();
  if (preflightError) {
    return { ok: false, tool: toolName, error: preflightError };
  }

  onResolved?.();
  try {
    const output = await invokeTool<unknown>(tool, {
      toolCallId,
      data: input,
      signal,
    });
    signal?.throwIfAborted();
    return { ok: true, tool: toolName, output };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ok: false,
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
