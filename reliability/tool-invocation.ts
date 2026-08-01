/**
 * Compatibility exports for callers that used the old reliability location.
 * ToolExecution owns the Flue v2 context and envelope seam now.
 */
export {
  invokeTool,
  unwrapToolOutput,
  type ToolInvocation,
} from '../investigation/tool-execution.ts';
