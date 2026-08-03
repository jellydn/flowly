import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkScenario,
  createKeywordJudge,
  createLlmJudge,
  createStaticModelCall,
  estimateCost,
  estimateTokens,
  estimateTokensFromResult,
  formatJudgePrompt,
  pricingForProvider,
  runBenchmark,
  withDefaultPricing,
} from '../eval/bench/index.ts';
import type { BenchmarkScenario, BenchmarkSuite, ModelSpec } from '../eval/bench/types.ts';
import type { DecisionFn, InvestigationResult } from '../investigation/types.ts';

const scenario: BenchmarkScenario = {
  id: 'cap-1',
  prompt: 'What is the purpose of this repository?',
  expectedSources: ['README.md'],
  expectedKeywords: ['authentication'],
  requiresCitation: true,
  requiresToolCall: true,
  maxSteps: 8,
};

const model: ModelSpec = {
  id: 'openrouter/qwen/qwen3-coder',
  provider: 'openrouter',
  label: 'Qwen3 Coder',
  pricing: { inputPer1kUsd: 1, outputPer1kUsd: 2 },
};

const suite: BenchmarkSuite = {
  id: 'sample',
  name: 'Sample benchmark',
  repositoryPath: 'eval/fixtures/sample-repo',
  maxSteps: 8,
  scenarios: [scenario],
};

/** Deterministic decider mirroring the capstone cap-1 sequence. */
const cap1Decider: DecisionFn = async (state) => {
  if (state.iteration === 0)
    return { type: 'call', tool: 'retrieve', input: { query: 'purpose overview repository', topK: 5 } };
  if (state.iteration === 1) {
    const ev = state.evidence.find((e) => e.filePath === 'README.md');
    if (ev) return { type: 'call', tool: 'read_file', input: { path: 'README.md', startLine: 1 } };
  }
  return { type: 'stop', reason: 'sufficient evidence' };
};

test('estimateTokens approximates length', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.ok(estimateTokens('x'.repeat(40)) >= 9);
});

test('estimateTokensFromResult sums inputs and outputs', () => {
  const result = {
    answer: { answer: 'a'.repeat(100), sources: [], confidence: 'High' },
    callHistory: [{ tool: 'read_file', input: { path: 'x' }, timestamp: 1 }],
    evidence: [{ filePath: 'x', excerpt: 'e'.repeat(80) }],
  } as unknown as InvestigationResult;
  const usage = estimateTokensFromResult(result);
  assert.ok(usage.tokensIn > 0);
  assert.ok(usage.tokensOut > 0);
});

test('checkScenario passes when all dimensions are satisfied', () => {
  const result = {
    toolsUsed: ['retrieve', 'read_file'],
    errors: [],
    answer: { answer: 'authentication is implemented', sources: ['README.md:1'], confidence: 'High' },
    evidence: [{ filePath: 'README.md', excerpt: 'authentication' }],
  } as unknown as InvestigationResult;
  const checks = checkScenario(scenario, result);
  assert.ok(checks.toolSuccess.passed);
  assert.ok(checks.citationAccuracy.passed);
  assert.ok(checks.retrievalRelevance.passed);
  assert.ok(checks.answerCompleteness.passed);
});

test('checkScenario fails when citations are missing', () => {
  const result = {
    toolsUsed: ['retrieve'],
    errors: [],
    answer: { answer: 'authentication is implemented', sources: [], confidence: 'Low' },
    evidence: [],
  } as unknown as InvestigationResult;
  const checks = checkScenario(scenario, result);
  assert.ok(!checks.citationAccuracy.passed);
  assert.ok(!checks.retrievalRelevance.passed);
});

test('createKeywordJudge scores 1.0 on a perfect result and < 1 on failures', async () => {
  const judge = createKeywordJudge();
  const good = {
    toolsUsed: ['retrieve', 'read_file'],
    errors: [],
    answer: { answer: 'authentication is implemented here', sources: ['README.md:1'], confidence: 'High' },
    evidence: [{ filePath: 'README.md', excerpt: 'authentication' }],
  } as unknown as InvestigationResult;
  const goodVerdict = await judge.score({ scenario, result: good });
  assert.equal(goodVerdict.score, 1);

  const bad = {
    toolsUsed: [],
    errors: ['tool failed'],
    answer: { answer: 'unknown', sources: [], confidence: 'Low' },
    evidence: [],
  } as unknown as InvestigationResult;
  const badVerdict = await judge.score({ scenario, result: bad });
  assert.ok(badVerdict.score < 1);
});

test('createLlmJudge parses JSON verdicts and falls back to neutral', async () => {
  const judge = createLlmJudge(async () => '{"score": 0.8, "rationale": "good"}');
  const verdict = await judge.score({
    scenario,
    result: { answer: { answer: 'a', sources: [] }, evidence: [] } as unknown as InvestigationResult,
  });
  assert.equal(verdict.score, 0.8);

  const flaky = createLlmJudge(async () => 'not json');
  const neutral = await flaky.score({
    scenario,
    result: { answer: { answer: 'a', sources: [] }, evidence: [] } as unknown as InvestigationResult,
  });
  assert.equal(neutral.score, 0.5);
});

test('formatJudgePrompt includes scenario expectations', () => {
  const prompt = formatJudgePrompt(scenario, 'answer text', 'evidence text');
  assert.ok(prompt.includes(scenario.prompt));
  assert.ok(prompt.includes('README.md'));
  assert.ok(prompt.includes('authentication'));
});

test('pricingForProvider returns known pricing and undefined for unknown', () => {
  assert.equal(pricingForProvider('anthropic')?.inputPer1kUsd, 0.003);
  assert.equal(pricingForProvider('not-a-provider'), undefined);
});

test('withDefaultPricing attaches provider pricing and never mutates', () => {
  const plain: ModelSpec = { id: 'm', provider: 'anthropic' };
  const priced = withDefaultPricing(plain);
  assert.equal(priced.pricing?.inputPer1kUsd, 0.003);
  assert.equal(plain.pricing, undefined); // original untouched

  const custom: ModelSpec = { id: 'm', provider: 'anthropic', pricing: { inputPer1kUsd: 9, outputPer1kUsd: 9 } };
  assert.equal(withDefaultPricing(custom).pricing?.inputPer1kUsd, 9); // explicit wins
});

test('estimateCost uses model pricing', () => {
  assert.equal(estimateCost(1000, 500, model.pricing), 2);
});

test('createStaticModelCall returns the fixed reply', async () => {
  const call = createStaticModelCall('hello');
  assert.equal(await call('anything'), 'hello');
});

test('runBenchmark runs deterministically and produces a report', async () => {
  const report = await runBenchmark(suite, model, {
    mode: 'deterministic',
    deciders: { 'cap-1': cap1Decider },
  });
  assert.equal(report.suiteId, 'sample');
  assert.equal(report.mode, 'deterministic');
  assert.equal(report.totalScenarios, 1);
  assert.equal(report.results.length, 1);
  assert.ok(report.results[0].metrics.latencyMs >= 0);
  assert.ok(report.results[0].metrics.tokensIn > 0);
  assert.ok(report.results[0].metrics.costUsd > 0);
  assert.ok(report.summary.qualityScore > 0);
  assert.ok(report.summary.toolSuccessRate >= 0);
  assert.equal(report.model.id, 'openrouter/qwen/qwen3-coder');
});

test('runBenchmark throws a clear error when a decider is missing', async () => {
  await assert.rejects(
    () =>
      runBenchmark(suite, model, {
        mode: 'deterministic',
        deciders: {},
      }),
    /No decision function for scenario "cap-1"/,
  );
});

test('runBenchmark supports live mode with a model call', async () => {
  const report = await runBenchmark(suite, model, {
    mode: 'live',
    modelCall: async () => 'authentication is implemented in src/auth.ts',
  });
  assert.equal(report.mode, 'live');
  assert.equal(report.totalScenarios, 1);
  assert.ok(report.summary.qualityScore > 0);
});
