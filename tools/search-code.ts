import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { markBudgetFreeTool, noInspectionBudget, summarizeInput, wrapWithBudget } from './repository.ts';
import { searchFiles } from './search-utils.ts';

export function createSearchCodeTool(
  repository: RepositoryReader,
  budget: StepBudget | undefined,
  debug: DebugLogger,
) {
  const tool = defineTool({
    name: 'search_code',
    description:
      'Search first-party text and source files for a literal string. Use when looking for a symbol, phrase, configuration, or implementation whose path is unknown. Returns matching repository-relative paths, line numbers, and line excerpts, plus an inspection budget snapshot. Excludes dependencies and generated build output. Results are leads, not proof—read the matching files before drawing conclusions.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
      path: v.optional(v.pipe(v.string(), v.maxLength(500)), '.'),
      caseSensitive: v.optional(v.boolean(), false),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const inspection: InspectionMetadata = budget?.consume('search_code') ?? noInspectionBudget();
      const inputSummary = summarizeInput({
        query: data.query,
        path: data.path,
        caseSensitive: data.caseSensitive,
      });
      try {
        const files = await repository.sourceFiles(data.path);
        const { matches, truncated } = await searchFiles(
          repository,
          files,
          data.query,
          data.caseSensitive,
          signal,
        );

        const result = {
          query: data.query,
          path: data.path,
          matches,
          filesSearched: files.length,
          truncated,
          inspection,
        };
        debug.log({
          tool: 'search_code',
          status: 'success',
          inputSummary,
          count: result.matches.length,
          inspection,
        });
        return { output: result };
      } catch (error) {
        if (signal?.aborted) throw error;
        debug.log({
          tool: 'search_code',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'search_code', inspection);
      }
    },
  });
  return budget === undefined ? markBudgetFreeTool(tool) : tool;
}
