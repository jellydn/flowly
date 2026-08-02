import type { RepositoryReader } from './repository.ts';
import { searchFiles, type SearchFilesResult } from './search-utils.ts';

export type SearchScope = 'source' | 'documentation';

export type RepositorySearchOptions = {
  scope: SearchScope;
  path: string;
  query: string;
  caseSensitive: boolean;
  signal?: AbortSignal;
};

/**
 * Search one bounded repository scope. Candidate traversal remains delegated
 * to RepositoryReader, so an index can be added later without changing the
 * search tool interface.
 */
export async function searchRepository(
  repository: RepositoryReader,
  options: RepositorySearchOptions,
): Promise<SearchFilesResult & { filesSearched: number }> {
  options.signal?.throwIfAborted();
  const files =
    options.scope === 'source'
      ? await repository.sourceFiles(options.path)
      : await repository.documentationFiles(options.path);
  const result = await searchFiles(
    repository,
    files,
    options.query,
    options.caseSensitive,
    options.signal,
  );
  return { ...result, filesSearched: files.length };
}
