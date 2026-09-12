import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createFileBenchmarkStore,
  createMemoryBenchmarkStore,
  evaluateBenchmarkGate,
  evaluateBenchmarkRegression,
  estimateCost,
  loadBenchmarkConfigFromFile,
  loadModelFromFile,
  loadSuiteFromFile,
  parseBenchmarkConfig,
  parseModel,
  parseSuite,
  recordHumanAcceptance,
} from '../eval/framework/index.ts';
import { buildReport, computeSummary, scoreScenario } from '../eval/framework/index.ts';
import type { BenchmarkReport, BenchmarkScenario, MetricPass } from '../eval/framework/types.ts';

const pass = (detail: string): MetricPass => ({ passed: true, detail });
const fail = (detail: string): MetricPass => ({ passed: false, detail });

const sampleSuite = {
  id: 'sample',
  name: 'Sample benchmark',
  description: 'A tiny suite for tests',
  maxSteps: 8,
  scenarios: [
    {
      id: 's1',
      prompt: 'Read src/config.ts and explain the port.',
      expectedSources: ['src/config.ts'],
      requiresCitation: true,
      requiresToolCall: true,
    },
  ],
};

const sampleModel = {
  id: 'openrouter/qwen/qwen3-coder',
  provider: 'openrouter',
  label: 'Qwen3 Coder',
};

test('parseSuite accepts a valid suite', () => {
  const result = parseSuite(sampleSuite);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.suite.id, 'sample');
});

test('parseSuite rejects missing scenarios with a field-path issue', () => {
  const result = parseSuite({ id: 'x', name: 'X' });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.includes('scenarios')));
  }
});

test('parseSuite rejects empty scenario ids', () => {
  const result = parseSuite({
    ...sampleSuite,
    scenarios: [{ id: '', prompt: 'p' }],
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.issues.some((i) => i.includes('scenarios.0.id')));
});

test('config schemas reject unknown fields instead of hiding typos', () => {
  assert.ok(!parseSuite({ ...sampleSuite, maxStep: 4 }).ok);
  assert.ok(
    !parseSuite({
      ...sampleSuite,
      scenarios: [{ id: 's1', prompt: 'p', requiresCitations: true }],
    }).ok,
  );
  assert.ok(!parseModel({ ...sampleModel, apiKeyEnvironment: 'OPENROUTER_API_KEY' }).ok);
});

test('parseSuite validates versioned quality gates', () => {
  const valid = parseSuite({ ...sampleSuite, gate: { minQualityScore: 0.9 } });
  assert.ok(valid.ok);
  assert.ok(!parseSuite({ ...sampleSuite, gate: {} }).ok);
  assert.ok(!parseSuite({ ...sampleSuite, gate: { minPassRate: 1.1 } }).ok);
  assert.ok(!parseSuite({ ...sampleSuite, gate: { maxCostUsd: -1 } }).ok);
});

test('parseModel rejects models without a provider', () => {
  const result = parseModel({ id: 'x' });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.issues.some((i) => i.includes('provider')));
});

test('parseBenchmarkConfig requires at least one model', () => {
  const result = parseBenchmarkConfig({ suite: sampleSuite, models: [] });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.issues.some((i) => i.includes('models')));
});

test('parseBenchmarkConfig rejects duplicate model ids', () => {
  const result = parseBenchmarkConfig({ suite: sampleSuite, models: [sampleModel, sampleModel] });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.issues.some((i) => i.includes('Model ids must be unique')));
});

test('parseBenchmarkConfig accepts a full config', () => {
  const result = parseBenchmarkConfig({ suite: sampleSuite, models: [sampleModel] });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.config.models.length, 1);
    assert.equal(result.config.suite.id, 'sample');
  }
});

test('loadSuiteFromFile loads and validates JSON from disk', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'suite.json');
  await writeFile(file, JSON.stringify(sampleSuite));

  const loaded = await loadSuiteFromFile(file);
  assert.ok(loaded.ok);
  if (loaded.ok) assert.equal(loaded.value.id, 'sample');

  await writeFile(file, '{ not json');
  const bad = await loadSuiteFromFile(file);
  assert.ok(!bad.ok);
});

test('loadModelFromFile loads a model spec', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.json');
  await writeFile(file, JSON.stringify(sampleModel));
  const loaded = await loadModelFromFile(file);
  assert.ok(loaded.ok);
  if (loaded.ok) assert.equal(loaded.value.provider, 'openrouter');
});

test('loadBenchmarkConfigFromFile loads suite + models together', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ suite: sampleSuite, models: [sampleModel] }));
  const loaded = await loadBenchmarkConfigFromFile(file);
  assert.ok(loaded.ok);
  if (loaded.ok) {
    assert.equal(loaded.suite.id, 'sample');
    assert.equal(loaded.models[0].id, 'openrouter/qwen/qwen3-coder');
  }
});

test('loadSuiteFromFile reports a readable error for a missing file', async () => {
  const loaded = await loadSuiteFromFile('/nonexistent/suite.json');
  assert.ok(!loaded.ok);
  if (!loaded.ok) assert.ok(loaded.issues[0].includes('Cannot read'));
});

test('estimateCost returns NaN without pricing and computes with pricing', () => {
  assert.ok(Number.isNaN(estimateCost(1000, 500)));
  assert.equal(estimateCost(1000, 1000, { inputPer1kUsd: 1, outputPer1kUsd: 2 }), 3);
});

test('scoreScenario averages the measured dimensions', () => {
  const scenario: BenchmarkScenario = { id: 's1', prompt: 'p' };
  const allPass = scoreScenario(scenario, {
    toolSuccess: pass('ok'),
    citationAccuracy: pass('ok'),
    retrievalRelevance: pass('ok'),
    answerCompleteness: pass('ok'),
  });
  assert.equal(allPass, 1);

  const halfPass = scoreScenario(scenario, {
    toolSuccess: pass('ok'),
    citationAccuracy: fail('no'),
    retrievalRelevance: pass('ok'),
    answerCompleteness: fail('no'),
  });
  assert.equal(halfPass, 0.5);
});

test('computeSummary aggregates reports', () => {
  const results = [
    {
      id: 's1',
      prompt: 'p',
      passed: true,
      metrics: {
        qualityScore: 1,
        latencyMs: 100,
        tokensIn: 1000,
        tokensOut: 500,
        costUsd: 0.1,
        usageSource: 'estimated',
        toolSuccess: pass('ok'),
        citationAccuracy: pass('ok'),
        retrievalRelevance: pass('ok'),
        answerCompleteness: pass('ok'),
        patchApplicability: pass('applies'),
      },
      toolsUsed: ['read_file'],
      citedSources: ['src/config.ts'],
      errors: [],
      answer: 'answer',
      confidence: 'high',
    },
    {
      id: 's2',
      prompt: 'p2',
      passed: false,
      metrics: {
        qualityScore: 0.5,
        latencyMs: 300,
        tokensIn: 2000,
        tokensOut: 1000,
        costUsd: 0.3,
        usageSource: 'estimated',
        toolSuccess: fail('error'),
        citationAccuracy: fail('no citation'),
        retrievalRelevance: pass('ok'),
        answerCompleteness: pass('ok'),
        patchApplicability: null,
      },
      toolsUsed: [],
      citedSources: [],
      errors: ['boom'],
      answer: '',
      confidence: 'low',
    },
  ] as unknown as BenchmarkReport['results'];

  const summary = computeSummary(results);
  assert.equal(summary.qualityScore, 0.75);
  assert.equal(summary.avgLatencyMs, 200);
  assert.equal(summary.totalTokens, 4500);
  assert.equal(summary.costUsd, 0.4);
  assert.equal(summary.toolSuccessRate, 0.5);
  assert.equal(summary.patchApplicabilityRate, 1);
  assert.ok(Number.isNaN(summary.humanAcceptanceRate));
});

test('buildReport computes pass/fail counts and summary', () => {
  const metrics = {
    qualityScore: 1,
    latencyMs: 10,
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.01,
    usageSource: 'estimated' as const,
    toolSuccess: pass('ok'),
    citationAccuracy: pass('ok'),
    retrievalRelevance: pass('ok'),
    answerCompleteness: pass('ok'),
    patchApplicability: null,
  };
  const report = buildReport({
    runId: 'sample-openrouter-qwen-1',
    suiteId: 'sample',
    suiteName: 'Sample benchmark',
    model: { id: 'openrouter/qwen/qwen3-coder', provider: 'openrouter', label: 'Qwen3 Coder' },
    mode: 'deterministic',
    results: [
      {
        id: 's1',
        prompt: 'p',
        passed: true,
        metrics,
        toolsUsed: [],
        citedSources: [],
        errors: [],
        answer: 'a',
        confidence: 'high',
      },
      {
        id: 's2',
        prompt: 'p2',
        passed: false,
        metrics,
        toolsUsed: [],
        citedSources: [],
        errors: ['x'],
        answer: '',
        confidence: 'low',
      },
    ],
  });
  assert.equal(report.totalScenarios, 2);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
});

test('evaluateBenchmarkGate reports every threshold and fails regressions', () => {
  const report = buildReport({
    runId: 'gate-run',
    suiteId: 'sample',
    suiteName: 'Sample',
    model: { id: 'm', provider: 'p', label: 'M' },
    mode: 'deterministic',
    results: [],
  });
  const result = evaluateBenchmarkGate(report, {
    minPassRate: 1,
    minQualityScore: 0,
    maxAvgLatencyMs: 0,
    maxCostUsd: 0,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.checks.map((check) => [check.metric, check.passed]),
    [
      ['minPassRate', false],
      ['minQualityScore', true],
      ['maxAvgLatencyMs', true],
      ['maxCostUsd', true],
    ],
  );
});

test('evaluateBenchmarkGate fails maxCostUsd when cost is unknown', () => {
  const report = buildReport({
    runId: 'unknown-cost',
    suiteId: 'sample',
    suiteName: 'Sample',
    model: { id: 'm', provider: 'p', label: 'M' },
    mode: 'deterministic',
    results: [
      {
        id: 's1',
        prompt: 'p',
        passed: true,
        metrics: {
          qualityScore: 1,
          latencyMs: 10,
          tokensIn: 10,
          tokensOut: 10,
          costUsd: Number.NaN,
          toolSuccess: pass('ok'),
          citationAccuracy: pass('ok'),
          retrievalRelevance: pass('ok'),
          answerCompleteness: pass('ok'),
          patchApplicability: null,
        },
        toolsUsed: [],
        citedSources: [],
        errors: [],
        answer: 'a',
        confidence: 'high',
      },
    ],
  });
  const result = evaluateBenchmarkGate(report, { maxCostUsd: 0.01, minPassRate: 1 });
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.checks.map((check) => [check.metric, check.passed]),
    [
      ['minPassRate', true],
      ['maxCostUsd', false],
    ],
  );
});

function regressionReport(scores = [1, 0.5]): BenchmarkReport {
  return buildReport({
    runId: 'baseline',
    suiteId: 'sample',
    suiteName: 'Sample',
    model: { id: 'v1', provider: 'p', label: 'Version 1' },
    mode: 'live',
    lineage: { suiteDigest: 'a'.repeat(64), repositoryDigest: 'b'.repeat(64) },
    results: scores.map((qualityScore, index) => ({
      id: `s${index}`,
      prompt: 'p',
      passed: qualityScore === 1,
      metrics: {
        qualityScore,
        latencyMs: 10,
        tokensIn: 10,
        tokensOut: 20,
        costUsd: Number.NaN,
        toolSuccess: pass('ok'),
        citationAccuracy: pass('ok'),
        retrievalRelevance: pass('ok'),
        answerCompleteness: pass('ok'),
        patchApplicability: null,
      },
      toolsUsed: [],
      citedSources: [],
      errors: [],
      answer: 'a',
      confidence: 'high',
    })),
  });
}

test('saved-run regression permits model changes, equal scores, and reordered scenarios', () => {
  const baseline = regressionReport();
  const candidate = regressionReport();
  candidate.runId = 'candidate';
  candidate.model.id = 'v2';
  candidate.results.reverse();
  candidate.results[0].metrics.latencyMs = 100;
  const result = evaluateBenchmarkRegression(baseline, candidate);
  assert.equal(result.passed, true);
  assert.equal(result.baselineRunId, 'baseline');
  assert.equal(result.candidateRunId, 'candidate');
  assert.deepEqual(result.regressedScenarioIds, []);
  assert.equal(evaluateBenchmarkRegression(baseline, regressionReport([1, 0.75])).passed, true);
  const fractional = regressionReport([0.1, 0.2, 0.3]);
  const reordered = structuredClone(fractional);
  reordered.results.reverse();
  assert.equal(evaluateBenchmarkRegression(fractional, reordered).passed, true);
});

test('saved-run regression catches scenario losses hidden by aggregate gains or stale summaries', () => {
  const baseline = regressionReport();
  const candidate = regressionReport([0.75, 1]);
  candidate.summary = baseline.summary;
  const result = evaluateBenchmarkRegression(baseline, candidate);
  assert.equal(result.passed, false);
  assert.ok(result.checks.every((check) => check.passed));
  assert.deepEqual(result.regressedScenarioIds, ['s0']);
  const lower = evaluateBenchmarkRegression(baseline, regressionReport([0.75, 0.5]));
  assert.equal(lower.checks.find((check) => check.metric === 'minQualityScore')?.actual, 0.625);
  assert.equal(lower.checks.find((check) => check.metric === 'minQualityScore')?.passed, false);
});

test('saved-run regression detects tool failures even when quality and pass status are unchanged', () => {
  const baseline = regressionReport();
  const candidate = regressionReport();
  candidate.results[1].metrics.toolSuccess = fail('tool failed');
  const result = evaluateBenchmarkRegression(baseline, candidate);
  assert.equal(result.passed, false);
  assert.deepEqual(result.regressedScenarioIds, ['s1']);
  assert.equal(result.checks.find((check) => check.metric === 'minToolSuccessRate')?.actual, 0.5);
});

test('saved-run regression rejects incompatible inputs and missing lineage', () => {
  const baseline = regressionReport();
  const changes: Array<(report: BenchmarkReport) => void> = [
    (r) => {
      r.suiteId = 'other';
    },
    (r) => {
      r.mode = 'deterministic';
    },
    (r) => {
      r.judge = 'other-judge';
    },
    (r) => {
      r.lineage = undefined;
    },
    (r) => {
      r.lineage!.suiteDigest = 'c'.repeat(64);
    },
    (r) => {
      r.lineage!.repositoryDigest = 'c'.repeat(64);
    },
    (r) => {
      r.results[0].id = 'unknown';
    },
    (r) => {
      r.results[0].id = r.results[1].id;
    },
    (r) => {
      r.results.pop();
    },
    (r) => {
      r.totalScenarios = 0;
    },
  ];
  for (const change of changes) {
    const candidate = regressionReport();
    change(candidate);
    assert.throws(() => evaluateBenchmarkRegression(baseline, candidate), /Regression reports/);
    assert.throws(() => evaluateBenchmarkRegression(candidate, baseline), /Regression reports/);
  }
  assert.throws(
    () => evaluateBenchmarkRegression(regressionReport([]), regressionReport([])),
    /non-empty/,
  );
  baseline.judge = undefined;
  assert.equal(evaluateBenchmarkRegression(baseline, regressionReport()).passed, true);
});

test('saved-run regression fails unknown quality rather than accepting it as unchanged', () => {
  const baseline = regressionReport();
  const candidate = regressionReport();
  candidate.results[0].metrics.qualityScore = Number.NaN;
  assert.equal(evaluateBenchmarkRegression(baseline, candidate).passed, false);
  assert.equal(evaluateBenchmarkRegression(candidate, baseline).passed, false);
});

test('memory store saves, loads, lists, and ranks leaderboards', async () => {
  const store = createMemoryBenchmarkStore();
  const base = {
    runId: '',
    suiteId: 'sample',
    suiteName: 'Sample benchmark',
    model: { id: 'm', provider: 'openrouter', label: 'M' },
    ranAt: '2026-01-01T00:00:00.000Z',
    mode: 'deterministic' as const,
    totalScenarios: 1,
    passed: 1,
    failed: 0,
    results: [],
    summary: {
      qualityScore: 1,
      avgLatencyMs: 10,
      totalTokens: 100,
      costUsd: 0.01,
      toolSuccessRate: 1,
      patchApplicabilityRate: Number.NaN,
      humanAcceptanceRate: Number.NaN,
    },
  };

  const good: BenchmarkReport = {
    ...base,
    runId: 'a',
    ranAt: '2026-01-02T00:00:00.000Z',
    summary: { ...base.summary, qualityScore: 1 },
  };
  const bad: BenchmarkReport = {
    ...base,
    runId: 'b',
    ranAt: '2026-01-01T00:00:00.000Z',
    summary: { ...base.summary, qualityScore: 0.2 },
  };

  await store.save(good);
  await store.save(bad);

  assert.deepEqual((await store.load('a'))?.runId, 'a');
  assert.equal(await store.load('nope'), null);

  const list = await store.list();
  assert.deepEqual(
    list.map((r) => r.runId),
    ['a', 'b'],
  ); // newest first

  const board = await store.leaderboard('sample');
  assert.deepEqual(
    board.map((e) => e.modelId),
    ['m', 'm'],
  );
  assert.equal(board[0].qualityScore, 1);
  assert.equal(board[1].qualityScore, 0.2);
});

test('file store persists reports across instances', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report: BenchmarkReport = {
    runId: 'r1',
    suiteId: 'sample',
    suiteName: 'Sample benchmark',
    model: { id: 'm', provider: 'openrouter', label: 'M' },
    ranAt: '2026-01-01T00:00:00.000Z',
    mode: 'deterministic',
    totalScenarios: 1,
    passed: 1,
    failed: 0,
    results: [
      {
        id: 's1',
        prompt: 'p',
        passed: true,
        metrics: {
          qualityScore: 1,
          latencyMs: 10,
          tokensIn: 10,
          tokensOut: 10,
          costUsd: Number.NaN,
          toolSuccess: pass('ok'),
          citationAccuracy: pass('ok'),
          retrievalRelevance: pass('ok'),
          answerCompleteness: pass('ok'),
          patchApplicability: null,
        },
        toolsUsed: [],
        citedSources: [],
        errors: [],
        answer: 'a',
        confidence: 'high',
      },
    ],
    summary: {
      qualityScore: 1,
      avgLatencyMs: 10,
      totalTokens: 100,
      costUsd: Number.NaN,
      toolSuccessRate: 1,
      patchApplicabilityRate: Number.NaN,
      humanAcceptanceRate: Number.NaN,
    },
  };

  const first = createFileBenchmarkStore(dir);
  await first.save(report);

  const second = createFileBenchmarkStore(dir);
  const loaded = await second.load('r1');
  assert.deepEqual(loaded?.runId, 'r1');
  assert.ok(loaded && Number.isNaN(loaded.results[0].metrics.costUsd));
  assert.ok(loaded && Number.isNaN(recordHumanAcceptance(loaded, { s1: true }).summary.costUsd));
  assert.ok(loaded && Number.isNaN(loaded.summary.costUsd));
  assert.ok(loaded && Number.isNaN(loaded.summary.patchApplicabilityRate));
  assert.ok(loaded && Number.isNaN(loaded.summary.humanAcceptanceRate));
  assert.equal((await second.leaderboard('sample')).length, 1);
});

test('file store rejects path-traversal suite and run ids', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createFileBenchmarkStore(dir);
  const report: BenchmarkReport = {
    runId: '../escape',
    suiteId: 'sample',
    suiteName: 'Sample benchmark',
    model: { id: 'm', provider: 'openrouter', label: 'M' },
    ranAt: '2026-01-01T00:00:00.000Z',
    mode: 'deterministic',
    totalScenarios: 1,
    passed: 1,
    failed: 0,
    results: [],
    summary: {
      qualityScore: 1,
      avgLatencyMs: 10,
      totalTokens: 100,
      costUsd: 0.01,
      toolSuccessRate: 1,
      patchApplicabilityRate: Number.NaN,
      humanAcceptanceRate: Number.NaN,
    },
  };
  await assert.rejects(() => store.save(report), /Unsafe benchmark report identity/);
  await assert.rejects(
    () => store.save({ ...report, runId: 'r1', suiteId: '..' }),
    /Unsafe benchmark report identity/,
  );
  await assert.rejects(
    () => store.save({ ...report, runId: 'r1', suiteId: 'foo/bar' }),
    /Unsafe benchmark report identity/,
  );
});
