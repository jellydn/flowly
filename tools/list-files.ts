import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader } from './repository.ts';
import { TOOL_LIMITS } from './contracts.ts';

const {
  maxPathLength: MAX_PATH_LENGTH,
  maxDepth: MAX_DEPTH,
  maxReturnedEntries: MAX_RETURNED_ENTRIES,
} = TOOL_LIMITS;

/**
 * Raw `list_files` tool: a pure repository operation. It performs no budget
 * accounting, debug logging, or error wrapping — the tool-composition seam
 * (`withInspectionBudget` or the reliability wrapper) owns those concerns.
 */
export function createListFilesTool(repository: RepositoryReader) {
  return defineTool({
    name: 'list_files',
    description:
      'List files and directories below one repository-relative directory. Use when the repository structure or a file path is unknown. Ignored build, dependency, VCS, and symlink entries are omitted. Returns repository-relative paths plus an inspection budget snapshot.',
    input: v.object({
      path: v.optional(v.pipe(v.string(), v.maxLength(MAX_PATH_LENGTH)), '.'),
      depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DEPTH)), 2),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const entries = await repository.list(data.path, data.depth);
      return {
        output: {
          path: data.path,
          entries: entries.slice(0, MAX_RETURNED_ENTRIES),
          truncated: entries.length > MAX_RETURNED_ENTRIES,
        },
      };
    },
  });
}
