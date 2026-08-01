import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { markBudgetFreeTool, noInspectionBudget, summarizeInput, wrapWithBudget } from './repository.ts';
import { TOOL_LIMITS } from './contracts.ts';

const {
  maxPathLength: MAX_PATH_LENGTH,
  maxDepth: MAX_DEPTH,
  maxReturnedEntries: MAX_RETURNED_ENTRIES,
} = TOOL_LIMITS;

export function createListFilesTool(
  repository: RepositoryReader,
  budget: StepBudget | undefined,
  debug: DebugLogger,
) {
  const tool = defineTool({
    name: 'list_files',
    description:
      'List files and directories below one repository-relative directory. Use when the repository structure or a file path is unknown. Ignored build, dependency, VCS, and symlink entries are omitted. Returns repository-relative paths plus an inspection budget snapshot.',
    input: v.object({
      path: v.optional(
        v.pipe(v.string(), v.maxLength(MAX_PATH_LENGTH)),
        '.',
      ),
      depth: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DEPTH)),
        2,
      ),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const inspection: InspectionMetadata = budget?.consume('list_files') ?? noInspectionBudget();
      const inputSummary = summarizeInput({
        path: data.path,
        depth: data.depth,
      });
      try {
        const entries = await repository.list(data.path, data.depth);
        const result = {
          path: data.path,
          entries: entries.slice(0, MAX_RETURNED_ENTRIES),
          truncated: entries.length > MAX_RETURNED_ENTRIES,
          inspection,
        };
        debug.log({
          tool: 'list_files',
          status: 'success',
          inputSummary,
          count: result.entries.length,
          inspection,
        });
        return { output: result };
      } catch (error) {
        debug.log({
          tool: 'list_files',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'list_files', inspection);
      }
    },
  });
  return budget === undefined ? markBudgetFreeTool(tool) : tool;
}
