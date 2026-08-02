import type { ToolDefinition } from '@flue/runtime';
import { invokeTool } from '../reliability/tool-invocation.ts';

export {
  invokeTool,
  unwrapToolOutput,
  type ToolInvocation,
} from '../reliability/tool-invocation.ts';

export type ToolRegistry = Map<string, ToolDefinition> | Partial<Record<string, ToolDefinition>>;

export type ToolExecutionMetadata = {
  toolCallId: string;
  startedAt: number;
  durationMs: number;
};

export type ToolCallResult =
  | { ok: true; tool: string; output: unknown }
  | { ok: false; tool: string; error: string };

export type ToolExecutionOutcome =
  | ({ ok: true; tool: string; output: unknown } & { metadata: ToolExecutionMetadata })
  | ({ ok: false; tool: string; error: string } & { metadata: ToolExecutionMetadata });

export function resolveTool(tools: ToolRegistry, toolName: string): ToolDefinition | undefined {
  return tools instanceof Map ? tools.get(toolName) : tools[toolName];
}

/**
 * Execute a tool and retain timing metadata for callers that need observability.
 * Abort signals remain exceptional so cancellation cannot be mistaken for a
 * normal tool failure.
 */
export async function executeToolCallWithMetadata(
  tools: ToolRegistry,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  signal?: AbortSignal,
  preflight?: () => string | undefined,
  onResolved?: () => void,
): Promise<ToolExecutionOutcome> {
  const startedAt = Date.now();
  const finish = <T extends ToolCallResult>(result: T): ToolExecutionOutcome =>
    ({
      ...result,
      metadata: {
        toolCallId,
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    }) as ToolExecutionOutcome;

  try {
    signal?.throwIfAborted();
    const tool = resolveTool(tools, toolName);
    if (!tool) {
      return finish({
        ok: false,
        tool: toolName,
        error: `Unknown or unsupported tool: ${toolName}`,
      });
    }

    const preflightError = preflight?.();
    if (preflightError) {
      return finish({ ok: false, tool: toolName, error: preflightError });
    }

    onResolved?.();
    const output = await invokeTool<unknown>(tool, {
      toolCallId,
      data: input,
      signal,
    });
    signal?.throwIfAborted();
    return finish({ ok: true, tool: toolName, output });
  } catch (error) {
    if (signal?.aborted) throw error;
    return finish({
      ok: false,
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Backward-compatible result shape for investigation adapters. */
export async function executeToolCall(
  tools: ToolRegistry,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  signal?: AbortSignal,
  preflight?: () => string | undefined,
  onResolved?: () => void,
): Promise<ToolCallResult> {
  const { metadata: _metadata, ...result } = await executeToolCallWithMetadata(
    tools,
    toolName,
    input,
    toolCallId,
    signal,
    preflight,
    onResolved,
  );
  return result;
}
