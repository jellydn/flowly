import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader } from './repository.ts';
import { searchRepository, type SearchScope } from './repository-search.ts';
import { TOOL_LIMITS } from './contracts.ts';

export type SearchToolOptions = {
  name: 'search_code' | 'search_docs';
  scope: SearchScope;
  description: string;
};

/**
 * Build either search tool from one scope-parameterized implementation.
 * search_code and search_docs differ only in the scope they search (source
 * versus documentation files) and their model-facing description; the input
 * schema, run loop, and result shape are shared.
 */
export function createSearchTool(repository: RepositoryReader, options: SearchToolOptions) {
  return defineTool({
    name: options.name,
    description: options.description,
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(TOOL_LIMITS.maxQueryLength)),
      path: v.optional(v.pipe(v.string(), v.maxLength(TOOL_LIMITS.maxPathLength)), '.'),
      caseSensitive: v.optional(v.boolean(), false),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const { matches, truncated, filesSearched } = await searchRepository(repository, {
        scope: options.scope,
        path: data.path,
        query: data.query,
        caseSensitive: data.caseSensitive,
        signal,
      });
      return {
        output: {
          query: data.query,
          path: data.path,
          matches,
          filesSearched,
          truncated,
        },
      };
    },
  });
}
