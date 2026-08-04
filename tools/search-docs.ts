import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader } from './repository.ts';
import { searchRepository } from './repository-search.ts';
import { TOOL_LIMITS } from './contracts.ts';

/**
 * Raw `search_docs` tool: a pure repository operation. It performs no budget
 * accounting, debug logging, or error wrapping — the tool-composition seam
 * (`withInspectionBudget` or the reliability wrapper) owns those concerns.
 */
export function createSearchDocsTool(repository: RepositoryReader) {
  return defineTool({
    name: 'search_docs',
    description:
      'Search documentation files (Markdown, text, README, AGENTS, CHANGELOG, docs/**) for a literal string. Use when looking for documented architecture, configuration, or design explanations whose path is unknown. Returns matching repository-relative paths, line numbers, and line excerpts, plus an inspection budget snapshot. Excludes dependencies and generated build output. Results are leads—read the matching documentation before drawing conclusions.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(TOOL_LIMITS.maxQueryLength)),
      path: v.optional(v.pipe(v.string(), v.maxLength(TOOL_LIMITS.maxPathLength)), '.'),
      caseSensitive: v.optional(v.boolean(), false),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const { matches, truncated, filesSearched } = await searchRepository(repository, {
        scope: 'documentation',
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
