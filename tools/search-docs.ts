import type { RepositoryReader } from './repository.ts';
import { createSearchTool } from './search.ts';

/**
 * Raw `search_docs` tool: a pure repository operation. It performs no budget
 * accounting, debug logging, or error wrapping — the tool-composition seam
 * (`withInspectionBudget` or the reliability wrapper) owns those concerns.
 */
export function createSearchDocsTool(repository: RepositoryReader) {
  return createSearchTool(repository, {
    name: 'search_docs',
    scope: 'documentation',
    description:
      'Search documentation files (Markdown, text, README, AGENTS, CHANGELOG, docs/**) for a literal string. Use when looking for documented architecture, configuration, or design explanations whose path is unknown. Returns matching repository-relative paths, line numbers, and line excerpts, plus an inspection budget snapshot. Excludes dependencies and generated build output. Results are leads—read the matching documentation before drawing conclusions.',
  });
}
