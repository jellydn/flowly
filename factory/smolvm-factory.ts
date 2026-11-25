import type { ImplementerRunner } from './agent-implementer.ts';
import { FactoryOrchestrator, implementationLeaseLive } from './orchestrator.ts';
import type { FactoryPipelineDependencies } from './run.ts';
import {
  SmolvmExecutionAdapter,
  assertSmolvmAvailable,
  createSmolvmCommandRunner,
  type SmolvmCommandRunner,
  type SmolvmConfig,
} from './smolvm.ts';
import { createSmolvmFactoryImplementer, stopBeforePush } from './smolvm-implementer.ts';
import { SmolvmFactoryVerifier } from './smolvm-verifier.ts';
import type { FactoryRunStore } from './store.ts';

/** The pipeline parts that the executor decides. */
export type FactoryExecutorDependencies = Pick<
  FactoryPipelineDependencies,
  'orchestrator' | 'progress' | 'git' | 'implementer' | 'verifier' | 'learning'
>;

/**
 * Pipeline parts for FLOWLY_EXECUTOR=smolvm. Implementer tools and checks run
 * in offline VMs. The experimental path makes no GitHub writes yet: progress
 * goes to stderr, repository learning is off, and the run stops before push.
 * It first deletes prefixed VMs that no live implementation lease owns.
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
  const workers = new SmolvmExecutionAdapter(config, runner);
  const verifierVms = new SmolvmExecutionAdapter(
    { ...config, prefix: `${config.prefix}-verify` },
    runner,
  );
  const now = Date.now();
  const activeRunIds = new Set(
    (await store.listByRepository(options.repository))
      .filter((run) => implementationLeaseLive(run, now))
      .map((run) => run.id),
  );
  for (const adapter of [workers, verifierVms]) {
    for (const name of await adapter.sweepOrphans(activeRunIds)) {
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
  };
}
