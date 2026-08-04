import { defineTool, type ToolDefinition } from '@flue/runtime';
import type { DebugLogger, StepBudget } from '../tools/repository.ts';
import { executeWithFallback, type FallbackOptions, type FallbackResult } from './fallback.ts';
import { markSealed } from './resilient-tool.ts';
import type { ReliabilityLogger } from './observability.ts';
import type { RetryConfig } from './retry.ts';

/**
 * Derive a candidate file path from a search tool input, or undefined when the
 * input does not name a concrete file. Search tools accept a `path` scope that
 * defaults to `.`; a value like `src/auth.ts` is the known path the fallback
 * read should open, while `.`, empty, and directory-scoped values are not.
 */
export function deriveKnownPath(input: Record<string, unknown>): string | undefined {
  const path = input['path'];
  if (typeof path !== 'string' || path === '' || path === '.' || path.endsWith('/')) {
    return undefined;
  }
  return path;
}

/**
 * Compose a search tool (`search_code` or `search_docs`) with a `read_file`
 * fallback: when the search fails transiently, read the known path directly
 * instead. Both tools must be raw (budget-free, unsealed); the returned tool
 * owns budget consumption and reliability and is sealed against re-wrapping.
 *
 * Output shapes:
 * - primary success → the search result unchanged;
 * - fallback success → the read result plus `fallbackUsed: true` and the
 *   partial message explaining why the fallback ran;
 * - both failed → `{ fallbackUsed: true, partialMessage, inspection }`.
 */
export function withSearchReadFallback(
  searchTool: ToolDefinition,
  readFileTool: ToolDefinition,
  budget: StepBudget,
  debug: DebugLogger,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
  options: FallbackOptions = {},
): ToolDefinition {
  if (searchTool.name !== 'search_code' && searchTool.name !== 'search_docs') {
    throw new Error('withSearchReadFallback requires a search tool (search_code or search_docs).');
  }

  return markSealed(
    defineTool({
      name: searchTool.name,
      description: searchTool.description,
      input: searchTool.input,
      output: searchTool.output,
      async run({ data, signal }) {
        signal?.throwIfAborted();
        const input = data as Record<string, unknown>;
        const result = await executeWithFallback(
          searchTool,
          readFileTool,
          input,
          deriveKnownPath(input),
          'search_with_fallback',
          budget,
          debug,
          retryConfig,
          reliabilityLog,
          { ...options, signal },
        );
        return { output: shapeFallbackOutput(result) };
      },
    }),
  );
}

function shapeFallbackOutput(result: FallbackResult): unknown {
  if (result.primarySucceeded) {
    return result.result;
  }
  if (result.fallbackSucceeded) {
    return {
      ...(result.result && typeof result.result === 'object'
        ? (result.result as Record<string, unknown>)
        : {}),
      fallbackUsed: true,
      note: result.partialMessage,
    };
  }
  // The fallback either ran and failed, or never ran (permanent primary
  // error, no known path, or budget exhaustion). Preserve the distinction
  // reported by executeWithFallback so callers can tell them apart.
  return {
    fallbackUsed: result.fallbackUsed,
    partialMessage:
      result.partialMessage ?? 'Search failed and the fallback file read also failed.',
    inspection: result.inspection,
  };
}
