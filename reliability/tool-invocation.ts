import type { ToolDefinition } from '@flue/runtime';

type ToolContext = Parameters<ToolDefinition['run']>[0];

export type ToolInvocation = {
  toolCallId: string;
  data: Record<string, unknown>;
  signal?: AbortSignal;
};

const silentLog = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Invoke a Flue v2 tool through one normalized context seam and return its
 * payload rather than the framework's `{ output: value }` envelope.
 *
 * The framework-specific cast is intentionally isolated here. Callers only
 * provide a tool, a stable call id, and input data.
 */
export async function invokeTool<T>(
  tool: ToolDefinition,
  invocation: ToolInvocation,
): Promise<T> {
  const context = {
    toolCallId: invocation.toolCallId,
    log: silentLog,
    data: invocation.data,
    signal: invocation.signal,
  } as ToolContext;
  const raw = await tool.run(context) as unknown;

  return unwrapToolOutput<T>(raw);
}

/** Unwrap a Flue v2 tool result while tolerating legacy raw payloads. */
export function unwrapToolOutput<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'output' in raw) {
    return (raw as { output: T }).output;
  }
  return raw as T;
}
