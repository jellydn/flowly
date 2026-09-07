import {
  formatRepositoryInstinctContext,
  learnRepositoryInstincts,
  selectRepositoryInstincts,
  setRepositoryInstinctStatus,
} from './engine.ts';
import {
  extractFactoryLearningObservations,
  extractPrReviewLearningObservations,
} from './extractors.ts';
import type { RepositoryMemoryStore } from './store.ts';
import type { FactoryRun } from '../factory/types.ts';
import type { ReviewResult } from '../review/schema.ts';
import type {
  RepositoryInstinct,
  RepositoryLearningPolicy,
  RepositoryLearningStage,
} from './types.ts';

export class RepositoryLearningService {
  constructor(
    private readonly repositoryId: string,
    private readonly policy: RepositoryLearningPolicy,
    private readonly store: RepositoryMemoryStore,
  ) {}

  async observeFactoryRuns(runs: FactoryRun[], now = Date.now()): Promise<void> {
    await this.learn(extractFactoryLearningObservations(runs), now);
  }

  async observePrReview(review: ReviewResult, prNumber: number, now = Date.now()): Promise<void> {
    await this.learn(extractPrReviewLearningObservations(review, prNumber, now), now);
  }

  async instinctsFor(
    stage: RepositoryLearningStage,
    paths: string[],
  ): Promise<RepositoryInstinct[]> {
    return selectRepositoryInstincts(await this.evaluatedState(), stage, paths);
  }

  async contextFor(stage: RepositoryLearningStage, paths: string[]): Promise<string> {
    return formatRepositoryInstinctContext(await this.instinctsFor(stage, paths));
  }

  async verificationCommandsFor(paths: string[]): Promise<string[]> {
    const instincts = await this.instinctsFor('verification', paths);
    return [
      ...new Set(
        instincts.flatMap((instinct) =>
          instinct.evidence.flatMap((evidence) => (evidence.command ? [evidence.command] : [])),
        ),
      ),
    ];
  }

  async list(): Promise<RepositoryInstinct[]> {
    return (await this.evaluatedState())?.instincts ?? [];
  }

  async explain(id: string): Promise<RepositoryInstinct> {
    const instinct = (await this.list()).find((item) => item.id === id);
    if (!instinct) throw new Error(`Repository instinct ${id} does not exist.`);
    return instinct;
  }

  async mark(id: string, status: 'rejected' | 'deprecated'): Promise<void> {
    const state = await this.store.load();
    if (!state) throw new Error('Repository memory is empty.');
    await this.store.save(setRepositoryInstinctStatus(state, id, status));
  }

  private async learn(values: unknown[], now: number): Promise<void> {
    const current = await this.store.load();
    const learned = learnRepositoryInstincts(this.repositoryId, current, values, this.policy, now);
    await this.store.save(learned);
  }

  private async evaluatedState() {
    const state = await this.store.load();
    return state ? learnRepositoryInstincts(this.repositoryId, state, [], this.policy) : null;
  }
}

export type FactoryRepositoryLearning = Pick<
  RepositoryLearningService,
  'contextFor' | 'observeFactoryRuns' | 'verificationCommandsFor'
>;
