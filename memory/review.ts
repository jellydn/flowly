import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { ReviewPublisher } from '../github/adapter.ts';
import type { RepositoryLearningService } from './service.ts';

export function withRepositoryReviewLearning(
  publisher: ReviewPublisher,
  learning: RepositoryLearningService,
  prNumber: number,
): ReviewPublisher {
  return {
    async publish(review, metadata) {
      const result = await publisher.publish(review, metadata);
      try {
        await learning.observePrReview(review, prNumber);
        return result;
      } catch (error) {
        return {
          ...result,
          validationIssues: [
            ...result.validationIssues,
            `Review posted, but repository learning failed: ${safeMessage(error)}`,
          ],
        };
      }
    },
  };
}

export function createGetRepositoryInstinctsTool(learning: RepositoryLearningService) {
  return defineTool({
    name: 'get_repository_instincts',
    description:
      'Return active evidence-backed review instincts that apply to the supplied changed paths. Explicit repository and review instructions always take precedence.',
    input: v.object({
      paths: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
        v.maxLength(100),
      ),
    }),
    async run({ data }) {
      return { output: { context: await learning.contextFor('review', data.paths) } };
    },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
