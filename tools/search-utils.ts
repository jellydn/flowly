import type { RepositoryReader } from './repository.ts';
import { TOOL_LIMITS } from './contracts.ts';

const MAX_MATCHES = TOOL_LIMITS.maxSearchMatches;
const MAX_EXCERPT_LENGTH = TOOL_LIMITS.maxSearchExcerptLength;

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

    const content = await repository.readText(file);
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
        excerpt: lines[index].trim().slice(0, MAX_EXCERPT_LENGTH),
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
