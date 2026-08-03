/**
 * Benchmark runner: executes a benchmark suite against a model via the
 * repository assistant's investigation pipeline and produces a report.
 *
 * Two execution modes:
 *   - deterministic: scenarios are driven by code-defined decision functions
 *     (no LLM required) — ideal for CI and unit tests.
 *   - live: scenarios are driven by a model call function (provider-backed),
 *     measuring real latency, token usage, and cost.
 *
 * Each scenario is scored on four dimensions (tool success, citation
 * accuracy, retrieval relevance, answer completeness). The judge (keyword-
 * based by default, or an LLM judge) turns the dimensions into a 0..1
 * quality score. Patch applicability and human acceptance are optional
 * measured dimensions, reported as NaN when not measured.
 */

import type { RepositoryReader } from '../../tools/repository.ts';
import type { InvestigationResult, DecisionFn } from '../../investigation/types.ts';
import { runInvestigation, buildToolMap } from '../../investigation/loop.ts';
import { createDebugLogger, createRepositoryReader, createStepBudget } from '../../tools/repository.ts';
import { createListFilesTool } from '../../tools/list-files.ts';
import { createReadFileTool } from '../../tools/read-file.ts';
import { createSearchCodeTool } from '../../tools/search-code.ts';
import { createSearchDocsTool } from '../../tools/search-docs.ts';
import { createRetrieveTool } from '../../tools/retrieve.ts';
import { estimateCost, scoreScenario, buildReport } from './metrics.ts';
import type { Judge } from './judge.ts';
import { createKeywordJudge } from './judge.ts';
import type { BenchmarkReport, BenchmarkScenario, BenchmarkSuite, ModelSpec, ScenarioResult } from './types.ts';

/** Approximate tokens from text length (4 chars/token heuristic). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * Estimate token usage from an investigation result. Tokens-in approximates
 * the question plus tool inputs; tokens-out approximates the answer plus
 * evidence excerpts. Exact usage is only available from live model calls.
 */
export function estimateTokensFromResult(result: InvestigationResult): {
  tokensIn: number;
  tokensOut: number;
} {
  const inputs = result.callHistory
    .map((c) => JSON.stringify(c.input))
    .join(' ');
  const evidence = result.evidence.map((e) => e.excerpt).join(' ');
  return {
    tokensIn: estimateTokens(`${result.answer.answer} ${inputs}`),
    tokensOut: estimateTokens(`${result.answer.answer} ${evidence}`),
  };
}

/** Per-scenario metric checks shared by the keyword judge and the runner. */
export type ScenarioChecks = {
  toolSuccess: { passed: boolean; detail: string };
  citationAccuracy: { passed: boolean; detail: string };
  retrievalRelevance: { passed: boolean; detail: string };
  answerCompleteness: { passed: boolean; detail: string };
};

/** Check the four quality dimensions for one scenario + investigation result. */
export function checkScenario(
  scenario: BenchmarkScenario,
  result: InvestigationResult,
): ScenarioChecks {
  const citedFiles = new Set(result.answer.sources.map((s) => s.split(':')[0]));
  const retrievedFiles = new Set(result.evidence.map((e) => e.filePath));

  const matches = (expected: string[], actual: Set<string>): boolean =>
    expected.some((e) => [...actual].some((a) => a === e || a.startsWith(e)));

  const toolSuccess =
    !scenario.requiresToolCall
      ? { passed: result.toolsUsed.length === 0, detail: result.toolsUsed.length === 0 ? 'No tool call required — correct' : `Unexpected tool calls: ${result.toolsUsed.join(', ')}` }
      : result.toolsUsed.length === 0
        ? { passed: false, detail: 'No tools were called' }
        : result.errors.length > 0
          ? { passed: false, detail: `${result.errors.length} tool error(s): ${result.errors[0]}` }
          : { passed: true, detail: `${result.toolsUsed.length} tool call(s) completed without errors` };

  const citationAccuracy = !scenario.requiresCitation
    ? { passed: true, detail: 'Citation not required' }
    : citedFiles.size === 0
      ? { passed: false, detail: 'No citations in answer' }
      : matches(scenario.expectedSources ?? [], citedFiles)
        ? { passed: true, detail: `Cited expected sources: ${[...citedFiles].join(', ')}` }
        : { passed: false, detail: `Expected sources not cited. Got: ${[...citedFiles].join(', ') || '(none)'}` };

  const retrievalRelevance = !scenario.expectedSources || scenario.expectedSources.length === 0
    ? { passed: true, detail: 'No specific sources expected' }
    : matches(scenario.expectedSources, retrievedFiles)
      ? { passed: true, detail: `Retrieved expected sources: ${[...retrievedFiles].join(', ')}` }
      : { passed: false, detail: `Expected sources not retrieved. Got: ${[...retrievedFiles].join(', ') || '(none)'}` };

  const expectedKeywords = scenario.expectedKeywords ?? [];
  const haystack = `${result.answer.answer.toLowerCase()} ${result.evidence
    .map((e) => e.excerpt)
    .join(' ')
    .toLowerCase()}`;
  const missing = expectedKeywords.filter((kw) => !haystack.includes(kw.toLowerCase()));
  const answerCompleteness =
    missing.length === 0
      ? { passed: true, detail: expectedKeywords.length === 0 ? 'No keyword requirements' : `All expected keywords present: ${expectedKeywords.join(', ')}` }
      : { passed: false, detail: `Missing keywords: ${missing.join(', ')}` };

  return { toolSuccess, citationAccuracy, retrievalRelevance, answerCompleteness };
}

/** Run one scenario and produce its result. */
export async function runScenario(input: {
  scenario: BenchmarkScenario;
  repository: RepositoryReader;
  decide: DecisionFn;
  judge: Judge;
  model: ModelSpec;
  maxSteps: number;
}): Promise<ScenarioResult> {
  const { scenario, repository, decide, judge, model } = input;
  const debug = createDebugLogger(false);
  const budget = createStepBudget(input.maxSteps);
  const tools = buildToolMap({
    list_files: createListFilesTool(repository, budget, debug),
    read_file: createReadFileTool(repository, budget, debug),
    search_code: createSearchCodeTool(repository, budget, debug),
    search_docs: createSearchDocsTool(repository, budget, debug),
    retrieve: createRetrieveTool(repository, budget, debug),
  });

  const startedAt = Date.now();
  const result = await runInvestigation(scenario.prompt, tools, budget, decide);
  const latencyMs = Date.now() - startedAt;

  const checks = checkScenario(scenario, result);
  const verdict = await judge.score({ scenario, result });
  const qualityScore = verdict.score;
  const usage = estimateTokensFromResult(result);
  const costUsd = estimateCost(usage.tokensIn, usage.tokensOut, model.pricing);

  const passed =
    checks.toolSuccess.passed &&
    checks.citationAccuracy.passed &&
    checks.retrievalRelevance.passed &&
    checks.answerCompleteness.passed;

  return {
    id: scenario.id,
    prompt: scenario.prompt,
    passed,
    metrics: {
      qualityScore,
      latencyMs,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd,
      toolSuccess: checks.toolSuccess,
      citationAccuracy: checks.citationAccuracy,
      retrievalRelevance: checks.retrievalRelevance,
      answerCompleteness: checks.answerCompleteness,
      patchApplicability: null,
    },
    toolsUsed: result.toolsUsed,
    citedSources: result.answer.sources,
    errors: result.errors,
    answer: result.answer.answer,
    confidence: result.answer.confidence,
    judgeRationale: verdict.rationale,
  };
}

export type RunBenchmarkOptions = {
  mode: 'deterministic' | 'live';
  /** Deciders keyed by scenario id (deterministic mode). */
  deciders?: Record<string, DecisionFn>;
  /** Model call function (live mode). */
  modelCall?: (prompt: string) => Promise<string>;
  /** Judge override; defaults to the keyword judge. */
  judge?: Judge;
  /** Repository path; defaults to the suite's repositoryPath or the sample fixture. */
  repositoryPath?: string;
  /** Per-scenario inspection budget; defaults to the suite maxSteps or 8. */
  maxSteps?: number;
};

/**
 * Run a benchmark suite against a model, returning a full report.
 * The report is saved to the store when one is provided.
 */
export async function runBenchmark(
  suite: BenchmarkSuite,
  model: ModelSpec,
  options: RunBenchmarkOptions,
): Promise<BenchmarkReport> {
  const repository = await createRepositoryReader(
    options.repositoryPath ?? suite.repositoryPath ?? 'eval/fixtures/sample-repo',
  );
  const judge = options.judge ?? createKeywordJudge();
  const defaultSteps = suite.maxSteps ?? 8;

  const results: ScenarioResult[] = [];
  for (const scenario of suite.scenarios) {
    const decide = resolveDecider(scenario, options);
    const result = await runScenario({
      scenario,
      repository,
      decide,
      judge,
      model,
      maxSteps: scenario.maxSteps ?? options.maxSteps ?? defaultSteps,
    });
    results.push(result);
  }

  const runId = `${suite.id}-${model.id.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;
  return buildReport({
    runId,
    suiteId: suite.id,
    suiteName: suite.name,
    model: { id: model.id, provider: model.provider, label: model.label ?? model.id },
    mode: options.mode,
    results,
  });
}

function resolveDecider(
  scenario: BenchmarkScenario,
  options: RunBenchmarkOptions,
): DecisionFn {
  if (options.mode === 'live' && options.modelCall) {
    return async (state) => {
      // In live mode the investigation is bounded: retrieve once, then stop
      // so the model call decides the final answer. The model-call function
      // itself is invoked by the CLI layer, not inside the loop.
      if (state.iteration === 0) {
        return { type: 'call', tool: 'retrieve', input: { query: state.question, topK: 5 } };
      }
      return { type: 'stop', reason: 'live answer produced' };
    };
  }
  const decider = options.deciders?.[scenario.id];
  if (!decider) {
    throw new Error(
      `No decision function for scenario "${scenario.id}" in deterministic mode. ` +
        'Provide `deciders` or use live mode.',
    );
  }
  return decider;
}
