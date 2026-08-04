import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkScenario,
  createKeywordJudge,
  createLlmJudge,
  createLlmJudgeFromSpec,
  createOpenAiCompatibleClient,
  createPatchCheck,
  createStaticModelCall,
  estimateCost,
  estimateTokens,
  estimateTokensFromResult,
  extractFencedBlocks,
  formatJudgePrompt,
  pricingForProvider,
  recordHumanAcceptance,
  runBenchmark,
  withDefaultPricing,
} from '../eval/bench/index.ts';
import type { BenchmarkReport, BenchmarkScenario, BenchmarkSuite, ModelSpec } from '../eval/bench/types.ts';
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

test('createLlmJudgeFromSpec builds a judge through the provider registry', async () => {
  const model: ModelSpec = { id: 'openrouter/qwen/qwen3-coder', provider: 'openrouter' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    async text() {
      return '';
    },
    async json() {
      return { choices: [{ message: { content: '{"score": 0.9, "rationale": "good"}' } }] };
    },
  })) as unknown as typeof fetch;
  try {
    const judge = createLlmJudgeFromSpec(model, { OPENROUTER_API_KEY: 'sk-test' });
    const verdict = await judge.score({
      scenario,
      result: { answer: { answer: 'a', sources: [] }, evidence: [] } as unknown as InvestigationResult,
    });
    assert.equal(verdict.score, 0.9);
    assert.equal(verdict.rationale, 'good');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createLlmJudgeFromSpec throws without a key', () => {
  const model: ModelSpec = { id: 'openai/gpt-4o', provider: 'openai' };
  assert.throws(
    () => createLlmJudgeFromSpec(model, {}),
    /No API key for provider "openai"/,
  );
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
  const result = await call('anything');
  assert.equal(result.content, 'hello');
  assert.equal(result.usage, undefined);
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
  assert.equal(report.results[0].metrics.usageSource, 'estimated');
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

test('runBenchmark live mode drives the loop then invokes the answer call', async () => {
  let calls = 0;
  const report = await runBenchmark(suite, model, {
    mode: 'live',
    modelCall: async (prompt) => {
      calls += 1;
      assert.ok(prompt.includes(scenario.prompt)); // question is threaded into the prompt
      // First call is the loop decider: stop immediately with no tool calls.
      if (calls === 1) return { content: '{"action":"stop","reason":"answer directly"}' };
      // Second call is the final answer.
      return { content: 'authentication is implemented in src/auth.ts' };
    },
  });
  assert.equal(report.mode, 'live');
  assert.equal(report.totalScenarios, 1);
  // One decider call (stop) + one answer call.
  assert.equal(calls, 2, 'modelCall drives the loop, then answers');
  assert.ok(report.results[0].answer.includes('src/auth.ts'));
  // No usage reported: metrics fall back to estimates.
  assert.equal(report.results[0].metrics.usageSource, 'estimated');
  assert.ok(report.results[0].metrics.tokensIn > 0);
});

test('runBenchmark live mode uses provider-reported tokens and billed cost', async () => {
  const report = await runBenchmark(suite, model, {
    mode: 'live',
    modelCall: async () => ({
      content: 'authentication is implemented in src/auth.ts',
      usage: { inputTokens: 120, outputTokens: 40, billedCostUsd: 0.00042 },
    }),
  });
  const metrics = report.results[0].metrics;
  assert.equal(metrics.usageSource, 'provider');
  assert.equal(metrics.tokensIn, 120);
  assert.equal(metrics.tokensOut, 40);
  // Billed cost wins over the pricing-table estimate.
  assert.equal(metrics.costUsd, 0.00042);
});

test('reports record the judge used', async () => {
  const keyword = await runBenchmark(suite, model, {
    mode: 'deterministic',
    deciders: { 'cap-1': cap1Decider },
  });
  assert.equal(keyword.judge, 'keyword');

  const llm = await runBenchmark(suite, model, {
    mode: 'deterministic',
    deciders: { 'cap-1': cap1Decider },
    judge: createLlmJudge(async () => '{"score": 0.7, "rationale": "ok"}'),
    judgeId: 'judge-model-x',
  });
  assert.equal(llm.judge, 'judge-model-x');
});

test('createOpenAiCompatibleClient parses usage and billed cost from the response', async () => {
  const client = createOpenAiCompatibleClient({
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/api/v1',
    model: 'm',
  });
  const result = await withMockFetch(
    {
      choices: [{ message: { content: 'the answer' } }],
      usage: { prompt_tokens: 77, completion_tokens: 23, total_cost: 0.00111 },
    },
    () => client('prompt'),
  );
  assert.equal(result.content, 'the answer');
  assert.deepEqual(result.usage, {
    inputTokens: 77,
    outputTokens: 23,
    billedCostUsd: 0.00111,
  });
});

test('createOpenAiCompatibleClient omits usage when the provider reports none', async () => {
  const client = createOpenAiCompatibleClient({
    apiKey: 'sk-test',
    baseUrl: 'https://example.test/api/v1',
    model: 'm',
  });
  const result = await withMockFetch(
    { choices: [{ message: { content: 'the answer' } }] },
    () => client('prompt'),
  );
  assert.equal(result.usage, undefined);
});

/** Run `fn` with global fetch stubbed to return `body`, restoring it after. */
async function withMockFetch<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      async text() {
        return '';
      },
      async json() {
        return body;
      },
    })) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('recordHumanAcceptance recomputes the acceptance rate without mutating input', () => {
  const original = reportNoHuman();
  const updated = recordHumanAcceptance(original, { 'cap-1': true });
  // Input report untouched.
  assert.equal(original.results[0].metrics.humanAccepted, undefined);
  assert.equal(updated.results[0].metrics.humanAccepted, true);
  assert.equal(updated.summary.humanAcceptanceRate, 1);
  // Unreviewed runs still report NaN.
  assert.ok(Number.isNaN(original.summary.humanAcceptanceRate));
});

test('recordHumanAcceptance ignores unknown ids and counts reviewed scenarios only', () => {
  const report = reportNoHuman();
  const updated = recordHumanAcceptance(report, { 'cap-1': false, nope: true });
  assert.equal(updated.results[0].metrics.humanAccepted, false);
  assert.equal(updated.summary.humanAcceptanceRate, 0);
});

function reportNoHuman(): BenchmarkReport {
  return {
    runId: 'run-1',
    suiteId: 'sample',
    suiteName: 'Sample benchmark',
    model: { id: 'm', provider: 'openrouter', label: 'M' },
    ranAt: new Date().toISOString(),
    mode: 'deterministic',
    totalScenarios: 1,
    passed: 1,
    failed: 0,
    results: [
      {
        id: 'cap-1',
        prompt: 'p',
        passed: true,
        metrics: {
          qualityScore: 1,
          latencyMs: 10,
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.01,
          usageSource: 'estimated',
          toolSuccess: { passed: true, detail: 'ok' },
          citationAccuracy: { passed: true, detail: 'ok' },
          retrievalRelevance: { passed: true, detail: 'ok' },
          answerCompleteness: { passed: true, detail: 'ok' },
          patchApplicability: null,
        },
        toolsUsed: [],
        citedSources: [],
        errors: [],
        answer: 'a',
        confidence: 'High',
      },
    ],
    summary: {
      qualityScore: 1,
      avgLatencyMs: 10,
      totalTokens: 150,
      costUsd: 0.01,
      toolSuccessRate: 1,
      patchApplicabilityRate: Number.NaN,
      humanAcceptanceRate: Number.NaN,
    },
  };
}

test('extractFencedBlocks pulls code blocks from an answer', () => {
  const blocks = extractFencedBlocks('Here is a patch:\n```ts\nconst x = 1;\n```\nand more');
  assert.deepEqual(blocks, ['const x = 1;']);
});

test('createPatchCheck reports not measured without expected files', async () => {
  const check = createPatchCheck();
  const plain: BenchmarkScenario = { id: 's', prompt: 'p' };
  const result = await check(plain, 'no patch here');
  assert.equal(result, null);
});

test('createPatchCheck fails without a fenced block and passes with one', async () => {
  const check = createPatchCheck();
  const noBlock = await check(scenario, 'just prose, no code fence');
  assert.ok(noBlock && !noBlock.passed);

  const withBlock = await check(scenario, 'Here:\n```ts\n// change auth.ts\n```');
  assert.ok(withBlock && withBlock.passed);
});
