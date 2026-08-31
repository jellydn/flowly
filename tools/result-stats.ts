/**
 * Shared helpers for reading tool output shapes. The reliability wrapper and
 * the planner both count the substantive items in a tool result (matches,
 * entries, lines, chunks), so the shape reads live here instead of being
 * duplicated in each module.
 */

/**
 * Count the substantive items in a tool output by tool name, or `undefined`
 * when the output has no countable field. Returns the array length for
 * `search_code` / `search_docs` / `list_files` / `retrieve` and the total line
 * count for `read_file`.
 */
export function countToolResult(toolName: string, output: unknown): number | undefined {
  if (toolName === 'search_code' || toolName === 'search_docs') {
    const matches = (output as { matches?: unknown[] })?.matches;
    return Array.isArray(matches) ? matches.length : undefined;
  }
  if (toolName === 'list_files') {
    const entries = (output as { entries?: unknown[] })?.entries;
    return Array.isArray(entries) ? entries.length : undefined;
  }
  if (toolName === 'read_file') {
    return (output as { totalLines?: number })?.totalLines;
  }
  if (toolName === 'retrieve' || toolName === 'related_context') {
    const results = (output as { results?: unknown[] })?.results;
    const relationships = (output as { relationships?: unknown[] })?.relationships;
    const value = toolName === 'retrieve' ? results : relationships;
    return Array.isArray(value) ? value.length : undefined;
  }
  return undefined;
}
