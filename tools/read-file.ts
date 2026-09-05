import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader } from './repository.ts';
import { TOOL_LIMITS } from './contracts.ts';

const { maxPathLength: MAX_PATH_LENGTH, maxReturnedLines: MAX_RETURNED_LINES } = TOOL_LIMITS;

/**
 * Raw `read_file` tool: a pure repository operation. It performs no budget
 * accounting, debug logging, or error wrapping — the tool-composition seam
 * (`withInspectionBudget` or the reliability wrapper) owns those concerns.
 */
export function createReadFileTool(repository: RepositoryReader) {
  return defineTool({
    name: 'read_file',
    description: `Read a bounded line range from one text file inside the configured repository. Use when an exact file path is already known and surrounding context is needed. Returns numbered lines, total line count, and an inspection budget snapshot. At most ${MAX_RETURNED_LINES} lines are returned per call.`,
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
      endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      if (data.endLine !== undefined && data.endLine < data.startLine) {
        throw new Error('endLine must be greater than or equal to startLine.');
      }
      const content = await repository.readText(data.path);
      const lines = content.split(/\r?\n/);
      const requestedEnd = data.endLine ?? data.startLine + MAX_RETURNED_LINES - 1;
      const endLine = Math.min(requestedEnd, data.startLine + MAX_RETURNED_LINES - 1, lines.length);
      const selected = lines
        .slice(data.startLine - 1, endLine)
        .map((line, index) => `${data.startLine + index}: ${line}`)
        .join('\n');

      return {
        output: {
          path: data.path,
          startLine: data.startLine,
          endLine,
          totalLines: lines.length,
          content: selected,
          truncated: requestedEnd > endLine || endLine < lines.length,
        },
      };
    },
  });
}
