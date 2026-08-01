import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { markBudgetFreeTool, noInspectionBudget, summarizeInput, wrapWithBudget } from './repository.ts';

const MAX_MATCHES = 50;

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
        const needle = data.caseSensitive
          ? data.query
          : data.query.toLowerCase();
        const matches: Array<{ path: string; line: number; excerpt: string }> =
          [];

        for (const file of files) {
          signal?.throwIfAborted();
          let content: string;
          try {
            content = await repository.readText(file);
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const haystack = data.caseSensitive
              ? lines[index]
              : lines[index].toLowerCase();
            if (haystack.includes(needle)) {
              matches.push({
                path: file,
                line: index + 1,
                excerpt: lines[index].trim().slice(0, 300),
              });
              if (matches.length >= MAX_MATCHES) break;
            }
          }
          if (matches.length >= MAX_MATCHES) break;
        }

        const result = {
          query: data.query,
          path: data.path,
          matches,
          filesSearched: files.length,
          truncated: matches.length >= MAX_MATCHES,
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
