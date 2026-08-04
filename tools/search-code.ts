import type { RepositoryReader } from './repository.ts';
import { createSearchTool } from './search.ts';

/**
 * Raw `search_code` tool: a pure repository operation. It performs no budget
 * accounting, debug logging, or error wrapping — the tool-composition seam
 * (`withInspectionBudget` or the reliability wrapper) owns those concerns.
 */
export function createSearchCodeTool(repository: RepositoryReader) {
  return createSearchTool(repository, {
    name: 'search_code',
    scope: 'source',
    description:
      'Search first-party text and source files for a literal string. Use when looking for a symbol, phrase, configuration, or implementation whose path is unknown. Returns matching repository-relative paths, line numbers, and line excerpts, plus an inspection budget snapshot. Excludes dependencies and generated build output. Results are leads, not proof—read the matching files before drawing conclusions.',
  });
}
