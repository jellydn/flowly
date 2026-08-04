import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader } from './repository.ts';
import { TOOL_LIMITS } from './contracts.ts';
import {
  buildRepositoryIndex,
  type RepositoryIndex,
  type RetrievalResult,
} from '../index/repository-indexer.ts';

const { maxQueryLength: MAX_QUERY_LENGTH, maxSearchMatches: MAX_RESULTS } = TOOL_LIMITS;

/**
 * Lazy index holder. The index is built on first retrieval call and reused
 * for subsequent calls. This avoids blocking agent startup with index
 * construction while keeping retrieval fast after the first call.
 */
type IndexHolder = {
  index: RepositoryIndex | undefined;
  building: Promise<RepositoryIndex> | undefined;
};

async function ensureIndex(holder: IndexHolder, repository: RepositoryReader): Promise<RepositoryIndex> {
  if (holder.index) return holder.index;
  if (holder.building) return holder.building;
  // On failure, clear the memoized promise so a later call retries the build
  // instead of being stuck on the same rejected promise forever (which would
  // defeat the reliability seam's retries and permanently brick retrieve).
  holder.building = buildRepositoryIndex(repository).then(
    (index) => {
      holder.index = index;
      holder.building = undefined;
      return index;
    },
    (error: unknown) => {
      holder.building = undefined;
      throw error;
    },
  );
  return holder.building;
}

/**
 * Raw `retrieve` tool: a pure repository operation. It performs no budget
 * accounting, debug logging, or error wrapping — the tool-composition seam
 * (`withInspectionBudget` or the reliability wrapper) owns those concerns.
 *
 * retrieve — semantic retrieval over the repository index. Use as a first
 * step when you need to find relevant files for a conceptual or multi-faceted
 * question. Returns ranked chunks with file paths, line ranges, relevance
 * scores, and source type (documentation or code). Combine with read_file to
 * confirm findings. Budget consumption is owned by the composition seam.
 */
export function createRetrieveTool(repository: RepositoryReader) {
  const holder: IndexHolder = { index: undefined, building: undefined };

  return defineTool({
    name: 'retrieve',
    description:
      'Retrieve relevant repository chunks using TF-IDF semantic search over a pre-built index. Use as a first step for conceptual or multi-faceted questions (e.g., "explain the architecture", "identify the highest-risk issue"). Returns ranked chunks with file paths, line ranges, relevance scores (0-1), and source type. Combine with read_file to confirm findings. Index covers both source code and documentation files.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(MAX_QUERY_LENGTH)),
      topK: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_RESULTS)), 5),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const index = await ensureIndex(holder, repository);
      const results: RetrievalResult[] = index.retrieve(data.query, data.topK);
      return {
        output: {
          query: data.query,
          results,
          resultCount: results.length,
          indexStats: index.stats,
        },
      };
    },
  });
}
