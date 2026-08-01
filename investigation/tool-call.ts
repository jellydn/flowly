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
