import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { summarizeInput, wrapWithBudget } from './repository.ts';

const MAX_RETURNED_LINES = 400;

export function createReadFileTool(
  repository: RepositoryReader,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'read_file',
    description:
      'Read a bounded line range from one text file inside the configured repository. Use when an exact file path is already known and surrounding context is needed. Returns numbered lines, total line count, and an inspection budget snapshot. At most 400 lines are returned per call.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      startLine: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1)),
        1,
      ),
      endLine: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1)),
      ),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      if (data.endLine !== undefined && data.endLine < data.startLine) {
        throw new Error('endLine must be greater than or equal to startLine.');
      }
      const inspection: InspectionMetadata = budget.consume('read_file');
      const inputSummary = summarizeInput({
        path: data.path,
        startLine: data.startLine,
        endLine: data.endLine,
      });
      try {
        const content = await repository.readText(data.path);
        const lines = content.split(/\r?\n/);
        const requestedEnd =
          data.endLine ?? data.startLine + MAX_RETURNED_LINES - 1;
        const endLine = Math.min(
          requestedEnd,
          data.startLine + MAX_RETURNED_LINES - 1,
          lines.length,
        );
        const selected = lines
          .slice(data.startLine - 1, endLine)
          .map((line, index) => `${data.startLine + index}: ${line}`)
          .join('\n');

        const result = {
          path: data.path,
          startLine: data.startLine,
          endLine,
          totalLines: lines.length,
          content: selected,
          truncated: requestedEnd > endLine || endLine < lines.length,
          inspection,
        };
        debug.log({
          tool: 'read_file',
          status: 'success',
          inputSummary,
          count: endLine - data.startLine + 1,
          inspection,
        });
        return { output: result };
      } catch (error) {
        debug.log({
          tool: 'read_file',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'read_file', inspection);
      }
    },
  });
}
