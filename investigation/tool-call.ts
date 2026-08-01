import {
  executeToolCallWithMetadata,
  type ToolExecutionOutcome,
  type ToolRegistry,
} from './tool-execution.ts';

export { executeToolCall, resolveTool } from './tool-execution.ts';
export type {
  ToolCallResult,
  ToolExecutionOutcome,
  ToolRegistry,
} from './tool-execution.ts';

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
    result: ToolExecutionOutcome,
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

    const result = await executeToolCallWithMetadata(
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
