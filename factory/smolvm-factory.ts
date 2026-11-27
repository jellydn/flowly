import type { ImplementerRunner } from './agent-implementer.ts';
import { FactoryOrchestrator, implementationLeaseLive } from './orchestrator.ts';
import { FactoryDraftPrPublisher } from './publisher.ts';
import type { FactoryPipelineDependencies } from './run.ts';
import {
  SmolvmExecutionAdapter,
  assertSmolvmAvailable,
  createSmolvmCommandRunner,
  smolvmRepositoryPrefix,
  type SmolvmCommandRunner,
  type SmolvmConfig,
} from './smolvm.ts';
import { createSmolvmFactoryImplementer, stopBeforePush } from './smolvm-implementer.ts';
import { SmolvmFactoryVerifier } from './smolvm-verifier.ts';
import type { FactoryRunStore } from './store.ts';

/** The pipeline parts that the executor decides. */
export type FactoryExecutorDependencies = Pick<
  FactoryPipelineDependencies,
  'orchestrator' | 'progress' | 'git' | 'implementer' | 'verifier' | 'learning' | 'publisher'
>;

const NO_GITHUB_WRITES =
  'FLOWLY_EXECUTOR=smolvm makes no GitHub writes: draft PR publication is off.';

/**
 * Pipeline parts for FLOWLY_EXECUTOR=smolvm. Implementer tools and checks run
 * in offline VMs. The experimental path makes no GitHub writes yet: progress
 * goes to stderr, repository learning is off, the run stops before push, and
 * the publisher refuses, also for a stored run that already reached review.
 * VM names carry a repository hash, so this repository's orphan sweep sees
 * only its own VMs. The sweep first deletes the VMs that no live lease owns.
 */
export async function createSmolvmFactoryDependencies(options: {
  config: SmolvmConfig;
  store: FactoryRunStore;
  repository: string;
  git: FactoryPipelineDependencies['git'];
  runAgent: ImplementerRunner;
  runner?: SmolvmCommandRunner;
  log?: (line: string) => void;
}): Promise<FactoryExecutorDependencies> {
  const { config, store } = options;
  const log = options.log ?? ((line: string) => console.error(`[flowly-factory] ${line}`));
  const runner = options.runner ?? createSmolvmCommandRunner();
  await assertSmolvmAvailable(runner);
  const prefix = smolvmRepositoryPrefix(config.prefix, options.repository);
  const workers = new SmolvmExecutionAdapter({ ...config, prefix }, runner);
  const verifierVms = new SmolvmExecutionAdapter({ ...config, prefix: `${prefix}-verify` }, runner);
  // Read the run again for each listed VM: a run claimed after the list is
  // seen as live, because its lease is saved before its VM is created.
  const isActive = async (runId: string) => {
    const run = await store.load(runId);
    return run !== null && implementationLeaseLive(run, Date.now());
  };
  for (const adapter of [workers, verifierVms]) {
    for (const name of await adapter.sweepOrphans(isActive)) {
      log(`deleted orphan smolvm machine ${name}`);
    }
  }
  return {
    orchestrator: new FactoryOrchestrator(store, { maxAttempts: config.maxAttempts }),
    progress: {
      async publish(task, body) {
        log(`issue #${task.issueNumber}: ${body}`);
      },
    },
    git: stopBeforePush(options.git),
    implementer: createSmolvmFactoryImplementer({ vms: workers, runAgent: options.runAgent }),
    verifier: new SmolvmFactoryVerifier(verifierVms),
    learning: undefined,
    publisher: new FactoryDraftPrPublisher({
      owner: options.repository.split('/')[0],
      repo: options.repository.split('/')[1],
      async findPullRequestsByHead() {
        throw new Error(NO_GITHUB_WRITES);
      },
      async createDraftPullRequest() {
        throw new Error(NO_GITHUB_WRITES);
      },
    }),
  };
}
