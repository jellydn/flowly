'use agent';
import { bash, useModel, useSandbox } from '@flue/runtime';
import { Bash, ReadWriteFs } from 'just-bash';
import { createSmolvmSandboxFactory } from '../factory/smolvm-sandbox.ts';

export const description =
  'Implements one approved factory plan inside an isolated writable repository clone. It cannot publish or merge.';

export function FactoryImplementer() {
  useModel(process.env.FACTORY_IMPLEMENTER_MODEL ?? 'openrouter/qwen/qwen3-coder');
  // FLOWLY_EXECUTOR=smolvm: tool calls run in the run's offline VM; the model loop stays here.
  const smolvm = createSmolvmSandboxFactory(process.env);
  if (smolvm) {
    useSandbox(smolvm);
  } else {
    const workspace = process.env.FACTORY_WORKSPACE_PATH;
    if (!workspace)
      throw new Error('FACTORY_WORKSPACE_PATH is required for the factory implementer.');
    useSandbox(
      bash(
        () =>
          new Bash({
            fs: new ReadWriteFs({ root: workspace }),
            executionLimitProfile: 'hardened',
          }),
      ),
    );
  }

  return `
You are Flowly's implementation stage. You receive only the issue and an
approved structured plan. Work exclusively inside the current isolated clone.
Read the repository and applicable AGENTS.md files before editing. Make the
smallest complete change that satisfies every acceptance criterion. You may
use bounded shell and filesystem tools inside this clone. The sandbox has no
network or host filesystem access outside the clone. Never inspect secrets,
change Git remotes, commit, push, publish, approve, or merge. Trusted factory
adapters own Git and GitHub mutation after you finish. Conclude only after the
working tree contains the complete implementation.
`;
}

FactoryImplementer.durability = { maxAttempts: 1, timeoutMs: 20 * 60_000 };
