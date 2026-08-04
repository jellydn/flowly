import type { ToolDefinition } from '@flue/runtime';
import { createListFilesTool } from './list-files.ts';
import { createReadFileTool } from './read-file.ts';
import { createSearchCodeTool } from './search-code.ts';
import { createSearchDocsTool } from './search-docs.ts';
import { createRetrieveTool } from './retrieve.ts';
import type { DebugLogger, RepositoryReader, StepBudget } from './repository.ts';
import type { FailureInjector } from '../reliability/failure-injection.ts';
import type { ReliabilityLogger } from '../reliability/observability.ts';
import type { RetryConfig, SleepFn } from '../reliability/retry.ts';
import { createReliableInspectionTool } from '../reliability/resilient-tool.ts';

export type InspectionToolName = 'list_files' | 'read_file' | 'search_code' | 'search_docs' | 'retrieve';

export type InspectionRegistryOptions = {
  repository: RepositoryReader;
  budget: StepBudget;
  debug: DebugLogger;
  retryConfig: RetryConfig;
  reliabilityLog: ReliabilityLogger;
  injector?: FailureInjector;
  sleep?: SleepFn;
};

export type InspectionRegistry = {
  readonly tools: Readonly<Record<InspectionToolName, ToolDefinition>>;
  readonly list: readonly ToolDefinition[];
  get(name: InspectionToolName): ToolDefinition;
};

type RawToolFactory = (repository: RepositoryReader) => ToolDefinition;

const TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_code',
  'search_docs',
  'retrieve',
] as const satisfies readonly InspectionToolName[];

const rawToolFactories: Readonly<Record<InspectionToolName, RawToolFactory>> = {
  list_files: (repository) => createListFilesTool(repository),
  read_file: (repository) => createReadFileTool(repository),
  search_code: (repository) => createSearchCodeTool(repository),
  search_docs: (repository) => createSearchDocsTool(repository),
  retrieve: (repository) => createRetrieveTool(repository),
};

/**
 * Build the four inspection tools once, applying the same reliability policy
 * to every raw tool. The returned list is the single registration source for
 * live agent composition; the named map remains convenient for deterministic
 * callers and tests.
 */
export function createInspectionRegistry(options: InspectionRegistryOptions): InspectionRegistry {
  const tools = {} as Record<InspectionToolName, ToolDefinition>;
  for (const name of TOOL_NAMES) {
    const factory = rawToolFactories[name];
    tools[name] = createReliableInspectionTool(
      () => factory(options.repository),
      options.budget,
      options.debug,
      options.retryConfig,
      options.reliabilityLog,
      options.injector,
      options.sleep,
    );
  }

  const list = TOOL_NAMES.map((name) => tools[name]);
  return {
    tools,
    list,
    get(name) {
      return tools[name];
    },
  };
}
