import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createFileBenchmarkStore,
  createMemoryBenchmarkStore,
  evaluateBenchmarkGate,
  estimateCost,
  loadBenchmarkConfigFromFile,
  loadModelFromFile,
  loadSuiteFromFile,
  parseBenchmarkConfig,
  parseModel,
  parseSuite,
} from '../eval/bench/index.ts';
import { buildReport, computeSummary, scoreScenario } from '../eval/bench/index.ts';
import type { BenchmarkReport, BenchmarkScenario, MetricPass } from '../eval/bench/types.ts';

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

test('estimateCost returns 0 without pricing and computes with pricing', () => {
  assert.equal(estimateCost(1000, 500), 0);
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

  const first = createFileBenchmarkStore(dir);
  await first.save(report);

  const second = createFileBenchmarkStore(dir);
  assert.deepEqual((await second.load('r1'))?.runId, 'r1');
  assert.equal((await second.leaderboard('sample')).length, 1);
});
