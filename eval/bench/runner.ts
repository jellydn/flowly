/**
 * Benchmark runner: executes a benchmark suite against a model via the
 * repository assistant's investigation pipeline and produces a report.
 *
 * Two execution modes:
 *   - deterministic: scenarios are driven by code-defined decision functions
 *     (no LLM required) — ideal for CI and unit tests.
 *   - live: scenarios gather repository evidence through the investigation
 *     loop, then call a provider model (`modelCall`) with the question and
 *     evidence; the model's reply becomes the answer.
 *
 * Each scenario is scored on four dimensions (tool success, citation
 * accuracy, retrieval relevance, answer completeness). The judge (keyword-
 * based by default, or an LLM judge) turns the dimensions into a 0..1
 * quality score. Patch applicability is an optional measured dimension via
 * the `measurePatch` hook. Token usage and cost prefer provider-reported
 * values in live mode (see ModelCallResult); human acceptance is recorded
 * separately via recordHumanAcceptance (see `flue eval review`).
 */

import { createHash } from 'node:crypto';
import type { RepositoryReader } from '../../tools/repository.ts';
import type { InvestigationResult, DecisionFn } from '../../investigation/types.ts';
import { runInvestigation, buildToolMap } from '../../investigation/loop.ts';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../../tools/repository.ts';
import { createBudgetedInspectionTools } from '../../tools/inspection-registry.ts';
import { estimateCost, buildReport } from './metrics.ts';
import type { Judge } from './judge.ts';
import { createKeywordJudge } from './judge.ts';
import type { ModelCallFn, ModelUsage } from './providers.ts';
import { createModelDecider } from './model-loop.ts';
import type {
  BenchmarkReport,
  BenchmarkScenario,
  BenchmarkSuite,
  MetricPass,
  ModelSpec,
  ScenarioResult,
} from './types.ts';

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
  const inputs = result.callHistory.map((c) => JSON.stringify(c.input)).join(' ');
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

  const toolSuccess = !scenario.requiresToolCall
    ? {
        passed: result.toolsUsed.length === 0,
        detail:
          result.toolsUsed.length === 0
            ? 'No tool call required — correct'
            : `Unexpected tool calls: ${result.toolsUsed.join(', ')}`,
      }
    : result.toolsUsed.length === 0
      ? { passed: false, detail: 'No tools were called' }
      : result.errors.length > 0
        ? { passed: false, detail: `${result.errors.length} tool error(s): ${result.errors[0]}` }
        : {
            passed: true,
            detail: `${result.toolsUsed.length} tool call(s) completed without errors`,
          };

  const citationAccuracy = !scenario.requiresCitation
    ? { passed: true, detail: 'Citation not required' }
    : citedFiles.size === 0
      ? { passed: false, detail: 'No citations in answer' }
      : matches(scenario.expectedSources ?? [], citedFiles)
        ? { passed: true, detail: `Cited expected sources: ${[...citedFiles].join(', ')}` }
        : {
            passed: false,
            detail: `Expected sources not cited. Got: ${[...citedFiles].join(', ') || '(none)'}`,
          };

  const retrievalRelevance =
    !scenario.expectedSources || scenario.expectedSources.length === 0
      ? { passed: true, detail: 'No specific sources expected' }
      : matches(scenario.expectedSources, retrievedFiles)
        ? { passed: true, detail: `Retrieved expected sources: ${[...retrievedFiles].join(', ')}` }
        : {
            passed: false,
            detail: `Expected sources not retrieved. Got: ${[...retrievedFiles].join(', ') || '(none)'}`,
          };

  const expectedKeywords = scenario.expectedKeywords ?? [];
  const haystack = `${result.answer.answer.toLowerCase()} ${result.evidence
    .map((e) => e.excerpt)
    .join(' ')
    .toLowerCase()}`;
  const missing = expectedKeywords.filter((kw) => !haystack.includes(kw.toLowerCase()));
  const answerCompleteness =
    missing.length === 0
      ? {
          passed: true,
          detail:
            expectedKeywords.length === 0
              ? 'No keyword requirements'
              : `All expected keywords present: ${expectedKeywords.join(', ')}`,
        }
      : { passed: false, detail: `Missing keywords: ${missing.join(', ')}` };

  return { toolSuccess, citationAccuracy, retrievalRelevance, answerCompleteness };
}

function buildTools(repository: RepositoryReader, maxSteps: number) {
  const debug = createDebugLogger(false);
  const budget = createStepBudget(maxSteps);
  return {
    budget,
    // The tool set comes from the inspection registry's single source of
    // truth rather than being re-listed here.
    tools: buildToolMap(createBudgetedInspectionTools(repository, budget, debug)),
  };
}

/** Live mode: the model drives the investigation loop, then answers. */
async function runLive(
  scenario: BenchmarkScenario,
  repository: RepositoryReader,
  modelCall: ModelCallFn,
  maxSteps: number,
): Promise<{ result: InvestigationResult; usage?: ModelUsage }> {
  const { budget, tools } = buildTools(repository, maxSteps);
  const toolNames = [...tools.keys()];
  const decide: DecisionFn = createModelDecider({ modelCall, toolNames });

  // Tool-requiring scenarios gather evidence through the model-driven loop;
  // conceptual scenarios answer directly from the model with no tool calls.
  const investigation = scenario.requiresToolCall
    ? await runInvestigation(scenario.prompt, tools, budget, decide)
    : {
        answer: {
          answer: '',
          sources: [],
          confidence: 'Insufficient' as const,
          toolsUsed: [],
          insufficientEvidence: true,
          keyFindings: [],
        },
        iterations: 0,
        evidence: [],
        errors: [],
        toolsUsed: [],
        stopReason: 'no tools required',
        callHistory: [],
      };

  const evidenceText = investigation.evidence.map((e) => e.excerpt).join('\n');
  const prompt = [
    scenario.prompt,
    '',
    evidenceText
      ? `Repository evidence:\n${evidenceText}`
      : '(No repository evidence was retrieved.)',
    '',
    'Answer concisely with file citations when relevant (path/to/file.ts:line).',
  ].join('\n');

  const reply = await modelCall(prompt);

  // Ground citations in what the model cited plus what was actually retrieved.
  const retrievedFiles = investigation.evidence.map((e) => e.filePath);
  const citedInReply = retrievedFiles.filter((file) => reply.content.includes(file));
  const sources = citedInReply.length > 0 ? citedInReply : retrievedFiles;

  return {
    result: {
      answer: {
        answer: reply.content,
        keyFindings: [],
        sources,
        confidence: sources.length >= 2 ? 'High' : sources.length === 1 ? 'Medium' : 'Low',
        toolsUsed: investigation.toolsUsed,
        insufficientEvidence: sources.length === 0,
      },
      iterations: investigation.iterations,
      evidence: investigation.evidence,
      errors: investigation.errors,
      toolsUsed: investigation.toolsUsed,
      stopReason: 'live model answer',
      callHistory: investigation.callHistory,
    },
    usage: reply.usage,
  };
}

/** Run one scenario and produce its result. */
export async function runScenario(input: {
  scenario: BenchmarkScenario;
  repository: RepositoryReader;
  judge: Judge;
  model: ModelSpec;
  maxSteps: number;
  /** Deterministic mode decider. */
  decide?: DecisionFn;
  /** Live mode model call; when present, live mode is used. */
  modelCall?: ModelCallFn;
  /** Optional patch-applicability measurer; defaults to not measured (null). */
  measurePatch?: (scenario: BenchmarkScenario, answer: string) => Promise<MetricPass | null>;
}): Promise<ScenarioResult> {
  const { scenario, repository, judge, model, decide, modelCall } = input;

  const startedAt = Date.now();
  const live = modelCall
    ? await runLive(scenario, repository, modelCall, input.maxSteps)
    : undefined;
  const result =
    live?.result ?? (await runScenarioWithDecider(scenario, repository, decide!, input.maxSteps));
  const latencyMs = Date.now() - startedAt;

  const checks = checkScenario(scenario, result);
  const verdict = await judge.score({ scenario, result });
  const qualityScore = verdict.score;
  // Prefer real provider-reported usage in live mode; fall back to estimates.
  const estimated = estimateTokensFromResult(result);
  const tokensIn = live?.usage?.inputTokens ?? estimated.tokensIn;
  const tokensOut = live?.usage?.outputTokens ?? estimated.tokensOut;
  const costUsd = live?.usage?.billedCostUsd ?? estimateCost(tokensIn, tokensOut, model.pricing);
  const patchApplicability = input.measurePatch
    ? await input.measurePatch(scenario, result.answer.answer)
    : null;

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
      tokensIn,
      tokensOut,
      costUsd,
      usageSource: live?.usage ? 'provider' : 'estimated',
      toolSuccess: checks.toolSuccess,
      citationAccuracy: checks.citationAccuracy,
      retrievalRelevance: checks.retrievalRelevance,
      answerCompleteness: checks.answerCompleteness,
      patchApplicability,
    },
    toolsUsed: result.toolsUsed,
    citedSources: result.answer.sources,
    errors: result.errors,
    answer: result.answer.answer,
    confidence: result.answer.confidence,
    judgeRationale: verdict.rationale,
  };
}

async function runScenarioWithDecider(
  scenario: BenchmarkScenario,
  repository: RepositoryReader,
  decide: DecisionFn,
  maxSteps: number,
): Promise<InvestigationResult> {
  const { budget, tools } = buildTools(repository, maxSteps);
  return runInvestigation(scenario.prompt, tools, budget, decide);
}

export type RunBenchmarkOptions = {
  mode: 'deterministic' | 'live';
  /** Deciders keyed by scenario id (deterministic mode). */
  deciders?: Record<string, DecisionFn>;
  /** Model call function (live mode); required when mode is 'live'. */
  modelCall?: ModelCallFn;
  /** Judge override; defaults to the keyword judge. */
  judge?: Judge;
  /**
   * Label recorded in the report for the judge used (e.g. the judge model
   * id). Ignored when `judge` is not set; the report defaults to 'keyword'.
   */
  judgeId?: string;
  /** Repository path; defaults to the suite's repositoryPath or the sample fixture. */
  repositoryPath?: string;
  /** Per-scenario inspection budget; defaults to the suite maxSteps or 8. */
  maxSteps?: number;
  /** Optional patch-applicability measurer (see eval/bench/patch.ts). */
  measurePatch?: (scenario: BenchmarkScenario, answer: string) => Promise<MetricPass | null>;
};

/** Hash the versioned suite and the exact repository corpus visible to inspection tools. */
export async function createBenchmarkLineage(
  suite: BenchmarkSuite,
  repository: RepositoryReader,
): Promise<NonNullable<BenchmarkReport['lineage']>> {
  const files = [
    ...new Set([...(await repository.sourceFiles()), ...(await repository.documentationFiles())]),
  ].toSorted();
  const corpus = createHash('sha256');
  for (const file of files) {
    corpus
      .update(file)
      .update('\0')
      .update(await repository.readText(file))
      .update('\0');
  }
  return {
    suiteDigest: createHash('sha256').update(stableJson(suite)).digest('hex'),
    repositoryDigest: corpus.digest('hex'),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

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
  const lineage = await createBenchmarkLineage(suite, repository);

  const results: ScenarioResult[] = [];
  for (const scenario of suite.scenarios) {
    const decide = options.mode === 'live' ? undefined : resolveDecider(scenario, options);
    const result = await runScenario({
      scenario,
      repository,
      decide,
      modelCall: options.modelCall,
      judge,
      model,
      maxSteps: scenario.maxSteps ?? options.maxSteps ?? defaultSteps,
      measurePatch: options.measurePatch,
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
    judge: options.judgeId ?? 'keyword',
    lineage,
  });
}

function resolveDecider(scenario: BenchmarkScenario, options: RunBenchmarkOptions): DecisionFn {
  const decider = options.deciders?.[scenario.id];
  if (!decider) {
    throw new Error(
      `No decision function for scenario "${scenario.id}" (mode: ${options.mode}). ` +
        'Provide `deciders` for deterministic mode, or use live mode with a `modelCall`.',
    );
  }
  return decider;
}
