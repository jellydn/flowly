import type { RepositoryReader } from './repository.ts';

const MAX_MATCHES = 50;

type SearchMatch = {
  path: string;
  line: number;
  excerpt: string;
};

type SearchFilesResult = {
  matches: SearchMatch[];
  truncated: boolean;
};

/** Search a known file list while sharing bounds, cancellation, and matching policy. */
export async function searchFiles(
  repository: RepositoryReader,
  files: string[],
  query: string,
  caseSensitive: boolean,
  signal?: AbortSignal,
): Promise<SearchFilesResult> {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const file of files) {
    signal?.throwIfAborted();

    let content: string;
    try {
      content = await repository.readText(file);
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if ((index & 255) === 0) {
        signal?.throwIfAborted();
        await yieldToEventLoop();
      }
      const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
      if (!haystack.includes(needle)) continue;

      matches.push({
        path: file,
        line: index + 1,
        excerpt: lines[index].trim().slice(0, 300),
      });
      if (matches.length >= MAX_MATCHES) {
        return { matches, truncated: true };
      }
    }
  }

  return { matches, truncated: false };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
