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

/**
 * search_docs — search documentation files (Markdown, text, README, AGENTS,
 * SOUL, CHANGELOG, docs/**) for a literal string. Use when looking for
 * documented architecture, configuration guides, or design explanations whose
 * path is unknown. Excludes dependencies, build output, and generated
 * directories. Returns matching repository-relative paths, line numbers, and
 * line excerpts, plus an inspection budget snapshot. Results are leads, not
 * proof—read the matching docs before drawing conclusions.
 */
export function createSearchDocsTool(
  repository: RepositoryReader,
  budget: StepBudget | undefined,
  debug: DebugLogger,
) {
  const tool = defineTool({
    name: 'search_docs',
    description:
      'Search documentation files (Markdown, text, README, AGENTS, CHANGELOG, docs/**) for a literal string. Use when looking for documented architecture, configuration, or design explanations whose path is unknown. Returns matching repository-relative paths, line numbers, and line excerpts, plus an inspection budget snapshot. Excludes dependencies and generated build output. Results are leads—read the matching documentation before drawing conclusions.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
      path: v.optional(v.pipe(v.string(), v.maxLength(500)), '.'),
      caseSensitive: v.optional(v.boolean(), false),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const inspection: InspectionMetadata = budget?.consume('search_docs') ?? noInspectionBudget();
      const inputSummary = summarizeInput({
        query: data.query,
        path: data.path,
        caseSensitive: data.caseSensitive,
      });
      try {
        const files = await repository.documentationFiles(data.path);
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
          tool: 'search_docs',
          status: 'success',
          inputSummary,
          count: result.matches.length,
          inspection,
        });
        return { output: result };
      } catch (error) {
        if (signal?.aborted) throw error;
        debug.log({
          tool: 'search_docs',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'search_docs', inspection);
      }
    },
  });
  return budget === undefined ? markBudgetFreeTool(tool) : tool;
}
