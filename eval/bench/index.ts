/**
 * Model evaluation benchmark framework — core module (issue #38).
 *
 * The framework mirrors OpenRouter ORI Eval's model-comparison UX: named
 * benchmark suites of scenarios run against one or more models, producing
 * reports with quality scores, latency, token usage, cost, tool-call success
 * rate, and patch applicability. Reports persist so models can be compared on
 * a leaderboard and regressions across model versions can be caught.
 *
 * Modules:
 *   types.ts     – the data model (suites, scenarios, reports, leaderboards)
 *   schema.ts    – Valibot validation with actionable field-path issues
 *   config.ts    – loading suites/models/config from JSON files
 *   metrics.ts   – cost estimation, quality scoring, report aggregation
 *   store.ts     – memory and file-backed report persistence
 */

export * from './types.ts';
export { parseSuite, parseModel, parseBenchmarkConfig } from './schema.ts';
export type { SuiteInput, ModelInput, BenchmarkConfig } from './schema.ts';
export { loadSuiteFromFile, loadModelFromFile, loadBenchmarkConfigFromFile } from './config.ts';
export type { LoadResult } from './config.ts';
export { estimateCost, computeSummary, scoreScenario, buildReport } from './metrics.ts';
export { createMemoryBenchmarkStore, createFileBenchmarkStore } from './store.ts';
export type { BenchmarkStore } from './store.ts';
export {
  estimateTokens,
  estimateTokensFromResult,
  checkScenario,
  runScenario,
  runBenchmark,
} from './runner.ts';
export type { ScenarioChecks, RunBenchmarkOptions } from './runner.ts';
export { createPatchCheck, extractFencedBlocks } from './patch.ts';
export type { PatchValidator } from './patch.ts';
export { createKeywordJudge, createLlmJudge, formatJudgePrompt } from './judge.ts';
export type { Judge, JudgeInput, JudgeVerdict } from './judge.ts';
export {
  PROVIDER_PRICING,
  pricingForProvider,
  withDefaultPricing,
  createStaticModelCall,
  createOpenAiCompatibleClient,
} from './providers.ts';
export type { ModelCallFn } from './providers.ts';
