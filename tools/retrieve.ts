import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import {
  markBudgetFreeTool,
  noInspectionBudget,
  summarizeInput,
  wrapWithBudget,
} from './repository.ts';
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
  holder.building = buildRepositoryIndex(repository).then((index) => {
    holder.index = index;
    holder.building = undefined;
    return index;
  });
  return holder.building;
}

/**
 * retrieve — semantic retrieval over the repository index. Use as a first
 * step when you need to find relevant files for a conceptual or multi-faceted
 * question. Returns ranked chunks with file paths, line ranges, relevance
 * scores, and source type (documentation or code). Combine with read_file to
 * confirm findings. Consumes one inspection budget slot.
 */
export function createRetrieveTool(
  repository: RepositoryReader,
  budget: StepBudget | undefined,
  debug: DebugLogger,
) {
  const holder: IndexHolder = { index: undefined, building: undefined };

  const tool = defineTool({
    name: 'retrieve',
    description:
      'Retrieve relevant repository chunks using TF-IDF semantic search over a pre-built index. Use as a first step for conceptual or multi-faceted questions (e.g., "explain the architecture", "identify the highest-risk issue"). Returns ranked chunks with file paths, line ranges, relevance scores (0-1), and source type. Combine with read_file to confirm findings. Index covers both source code and documentation files.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(MAX_QUERY_LENGTH)),
      topK: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_RESULTS)), 5),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const inspection: InspectionMetadata = budget?.consume('retrieve') ?? noInspectionBudget();
      const inputSummary = summarizeInput({ query: data.query, topK: data.topK });
      try {
        const index = await ensureIndex(holder, repository);
        const results: RetrievalResult[] = index.retrieve(data.query, data.topK);
        const result = {
          query: data.query,
          results,
          resultCount: results.length,
          indexStats: index.stats,
          inspection,
        };
        debug.log({
          tool: 'retrieve',
          status: 'success',
          inputSummary,
          count: results.length,
          inspection,
        });
        return { output: result };
      } catch (error) {
        if (signal?.aborted) throw error;
        debug.log({
          tool: 'retrieve',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'retrieve', inspection);
      }
    },
  });
  return budget === undefined ? markBudgetFreeTool(tool) : tool;
}
