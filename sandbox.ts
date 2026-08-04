import { bash, type SandboxFactory } from '@flue/runtime';
import { Bash } from 'just-bash';

const isolatedMemorySandbox = bash(() => new Bash());

// Keep the complete Flue factory, including newer runtime adapter fields, while
// removing its default model-facing filesystem and shell tools. Repository
// access is available only through this project's five custom, bounded tools.
export const restrictedSandbox: SandboxFactory = {
  ...isolatedMemorySandbox,
  createSessionEnv: isolatedMemorySandbox.createSessionEnv?.bind(isolatedMemorySandbox),
  tools: () => [],
};
