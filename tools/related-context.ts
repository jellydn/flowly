import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  buildRepositoryRelationshipIndex,
  RELATIONSHIP_TYPES,
  type RelationshipIndexStats,
  type RepositoryRelationshipIndex,
} from '../index/repository-relationship-index.ts';
import { TOOL_LIMITS } from './contracts.ts';
import type { RepositoryReader } from './repository.ts';

type IndexHolder = {
  index: RepositoryRelationshipIndex | undefined;
  building: Promise<RepositoryRelationshipIndex> | undefined;
};

async function ensureIndex(
  holder: IndexHolder,
  repository: RepositoryReader,
): Promise<RepositoryRelationshipIndex> {
  if (holder.index) return holder.index;
  if (holder.building) return holder.building;
  holder.building = buildRepositoryRelationshipIndex(repository).then(
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

export function createRelatedContextTool(repository: RepositoryReader) {
  const holder: IndexHolder = { index: undefined, building: undefined };

  return defineTool({
    name: 'related_context',
    description:
      'Find explicit repository relationships for a known path: imports/imported_by, package dependencies, CODEOWNERS ownership, documentation links, and GitHub issue/PR references. Use this for relational navigation; use retrieve for conceptually similar text and search_code for literal symbols. Returns only cited, repository-derived edges and performs no network or writes.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(TOOL_LIMITS.maxPathLength)),
      relationship: v.optional(v.picklist(RELATIONSHIP_TYPES)),
      limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TOOL_LIMITS.maxSearchMatches)),
        20,
      ),
    }),
    async run({ data, signal }) {
      signal?.throwIfAborted();
      const absolute = await repository.resolve(data.path);
      const normalizedPath = repository.relative(absolute);
      const index = await ensureIndex(holder, repository);
      const nodeIds = [`file:${normalizedPath}`, `directory:${normalizedPath}`];
      const nodeId = nodeIds.find((candidate) => index.hasNode(candidate));
      const relationships = nodeId
        ? index.relationships(nodeId, data.relationship, data.limit)
        : [];
      return {
        output: {
          path: normalizedPath,
          relationship: data.relationship ?? null,
          relationships,
          resultCount: relationships.length,
          diagnostics: [...index.diagnostics],
          indexStats: index.stats satisfies RelationshipIndexStats,
        },
      };
    },
  });
}
