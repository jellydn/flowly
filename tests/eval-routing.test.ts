import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recommendModelRouting, type RoutingPolicy } from '../eval/framework/routing.ts';
import { buildReport } from '../eval/framework/metrics.ts';
import { createFileBenchmarkStore } from '../eval/framework/store.ts';
import type {
  BenchmarkReport,
  BenchmarkWorkload,
  ScenarioResult,
} from '../eval/framework/types.ts';

const now = Date.parse('2026-10-24T12:00:00Z');
const policy: RoutingPolicy = {
  referenceRunId: 'quality-1',
  workloads: ['repository-question', 'github-issue', 'pull-request-review', 'coding-task'],
  minQualityScore: 0.9,
  maxCostUsdPerScenario: 0.02,
  maxAvgLatencyMs: 200,
  maxAgeHours: 24,
  minRuns: 2,
  minScenarios: 2,
  optimize: 'cost',
};
function report(
  model: string,
  run: number,
  quality: number,
  cost: number,
  latency: number,
): BenchmarkReport {
  const results: ScenarioResult[] = policy.workloads.flatMap(
    (workloadType: BenchmarkWorkload['type']) =>
      [0, 1].map((index) => ({
        id: `${workloadType}-${index}`,
        workloadType,
        prompt: 'Question',
        answer: 'Answer',
        confidence: 'high',
        passed: true,
        toolsUsed: ['read_file'],
        citedSources: ['README.md'],
        errors: [],
        metrics: {
          qualityScore: quality,
          latencyMs: latency + index * 20,
          tokensIn: 100,
          tokensOut: 50,
          costUsd: cost + index * 0.002,
          toolSuccess: { passed: true, detail: '' },
          citationAccuracy: { passed: true, detail: '' },
          retrievalRelevance: { passed: true, detail: '' },
          answerCompleteness: { passed: true, detail: '' },
          patchApplicability: workloadType === 'coding-task' ? { passed: true, detail: '' } : null,
        },
      })),
  );
  return {
    ...buildReport({
      runId: `${model}-${run}`,
      suiteId: 'workloads',
      suiteName: 'Workloads',
      model: { id: model, provider: 'test', label: model },
      mode: 'live',
      lineage: { suiteDigest: 'a'.repeat(64), repositoryDigest: 'b'.repeat(64) },
      results,
    }),
    ranAt: new Date(now - run * 3600000).toISOString(),
  };
}
const reports = () => [
  report('quality', 1, 0.99, 0.015, 100),
  report('quality', 2, 0.98, 0.015, 100),
  report('cheap', 1, 0.92, 0.003, 150),
  report('cheap', 2, 0.94, 0.003, 150),
];

test('routing ranks all four workloads with explicit trade-offs and report lineage', () => {
  const advice = recommendModelRouting(reports(), policy, now);
  assert.equal(advice.advisoryOnly, true);
  for (const decision of advice.decisions) {
    assert.equal(decision.recommendedModel?.id, 'cheap');
    const candidate = decision.candidates.find((item) => item.model.id === 'cheap')!;
    assert.equal(candidate.metrics?.samples, 4);
    assert.equal(candidate.metrics?.avgLatencyMs, 160);
    assert.ok(Math.abs(candidate.metrics!.costUsdPerScenario - 0.004) < 1e-10);
    assert.ok(Math.abs(candidate.metrics!.qualityScore - 0.93) < 1e-10);
    assert.deepEqual(
      candidate.evidence.map((item) => item.runId),
      ['cheap-1', 'cheap-2'],
    );
    assert.equal(candidate.evidence[0].lineage?.suiteDigest, 'a'.repeat(64));
  }
  assert.equal(
    recommendModelRouting(reports(), { ...policy, optimize: 'quality' }, now).decisions[0]
      .recommendedModel?.id,
    'quality',
  );
  assert.equal(
    recommendModelRouting(reports(), { ...policy, optimize: 'latency' }, now).decisions[0]
      .recommendedModel?.id,
    'quality',
  );
  assert.equal(
    recommendModelRouting(reports(), { ...policy, maxCostUsdPerScenario: 0.001 }, now).decisions[0]
      .recommendedModel,
    null,
  );
  assert.equal(
    recommendModelRouting(reports(), { ...policy, maxAvgLatencyMs: 109 }, now).decisions[0]
      .recommendedModel,
    null,
  );
  assert.equal(
    recommendModelRouting(reports(), { ...policy, minQualityScore: 0.99 }, now).decisions[0]
      .recommendedModel,
    null,
    'one lower-quality run cannot be hidden by an aggregate',
  );
});

test('routing fails closed for stale, incompatible, insufficient, simulated, or invalid evidence', () => {
  const changes: Array<(report: BenchmarkReport) => void> = [
    (r) => {
      r.mode = 'deterministic';
    },
    (r) => {
      r.ranAt = new Date(now - 25 * 3600000).toISOString();
    },
    (r) => {
      r.ranAt = new Date(now + 1).toISOString();
    },
    (r) => {
      r.lineage = undefined;
    },
    (r) => {
      r.lineage!.repositoryDigest = 'c'.repeat(64);
    },
    (r) => {
      r.judge = 'different-judge';
    },
    (r) => {
      r.results[0].id = r.results[1].id;
    },
    (r) => {
      r.results[0].metrics.costUsd = Number.NaN;
    },
    (r) => {
      r.results[0].metrics.qualityScore = Number.POSITIVE_INFINITY;
    },
    (r) => {
      r.results[0].passed = false;
    },
    (r) => {
      r.results[0].errors = ['timeout'];
    },
    (r) => {
      r.results[0].metrics.humanAccepted = false;
    },
  ];
  for (const change of changes) {
    const runs = reports().filter((r) => r.model.id === 'quality');
    change(runs[0]);
    assert.equal(recommendModelRouting(runs, policy, now).decisions[0].recommendedModel, null);
  }
  assert.equal(recommendModelRouting([], policy, now).decisions[0].recommendedModel, null);
  assert.equal(
    recommendModelRouting(reports().slice(0, 1), policy, now).decisions[0].recommendedModel,
    null,
  );
  const duplicate = reports().slice(0, 1);
  assert.equal(
    recommendModelRouting([...duplicate, ...duplicate], policy, now).decisions[0].recommendedModel,
    null,
  );
  const coding = reports().slice(0, 2);
  coding[1].results.find((r) => r.workloadType === 'coding-task')!.metrics.patchApplicability =
    null;
  assert.equal(
    recommendModelRouting(coding, policy, now).decisions.find((d) => d.workload === 'coding-task')!
      .recommendedModel,
    null,
  );
  assert.throws(() => recommendModelRouting(reports(), { ...policy, minRuns: 1 }, now));
  const latestChanged = reports();
  const newer = structuredClone(latestChanged[2]);
  newer.runId = 'cheap-newer';
  newer.ranAt = new Date(now).toISOString();
  newer.lineage!.suiteDigest = 'c'.repeat(64);
  assert.equal(
    recommendModelRouting([...latestChanged, newer], policy, now).decisions[0].recommendedModel?.id,
    'quality',
    'an incompatible latest run blocks the cheap model despite two older eligible runs',
  );
  const ambiguous = reports();
  assert.equal(
    recommendModelRouting([...ambiguous, ambiguous[0]], policy, now).decisions[0].recommendedModel,
    null,
  );
});

test('routing CLI reads persisted evidence without mutation and signals no-advice cases', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowly-routing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createFileBenchmarkStore(dir);
  for (const run of reports())
    await store.save({ ...run, ranAt: new Date(Date.now() - 1000).toISOString() });
  await writeFile(
    path.join(dir, 'workloads', 'damaged.json'),
    JSON.stringify({ ...reports()[2], runId: 'damaged', model: null }),
  );
  const before = JSON.stringify(await store.list());
  const file = path.join(dir, 'policy.json');
  await writeFile(file, JSON.stringify(policy));
  const invoke = () =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-recommend.ts', file], {
      encoding: 'utf8',
      env: { ...process.env, FLOWLY_EVAL_RESULTS_DIR: dir },
    });
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decisions[0].recommendedModel.id, 'cheap');
  assert.equal(JSON.stringify(await store.list()), before);
  await writeFile(file, JSON.stringify({ ...policy, maxCostUsdPerScenario: 0 }));
  const blocked = invoke();
  assert.equal(blocked.status, 1);
  assert.ok(
    JSON.parse(blocked.stdout).decisions.every(
      (decision: { recommendedModel: unknown }) => decision.recommendedModel === null,
    ),
  );
  await writeFile(file, '{}');
  assert.equal(invoke().status, 2);
});

test('routing isolates damaged saved reports without hiding damaged model evidence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowly-routing-damaged-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createFileBenchmarkStore(dir);
  for (const run of reports()) await store.save(run);
  const file = path.join(dir, 'workloads', 'damaged.json');
  for (const damage of [
    { model: undefined },
    { model: { id: 42, provider: 'test' } },
    { ranAt: 42 },
    { ranAt: { toString: null, valueOf: null } },
    { results: reports()[2].results.map((result) => ({ ...result, errors: null })) },
  ]) {
    await writeFile(file, JSON.stringify({ ...reports()[2], runId: 'damaged', ...damage }));
    const advice = recommendModelRouting(await store.list(), policy, now);
    const identifiable = 'ranAt' in damage || 'results' in damage;
    assert.equal(advice.decisions[0].recommendedModel?.id, identifiable ? 'quality' : 'cheap');
  }
  await writeFile(
    path.join(dir, 'workloads', 'quality-1.json'),
    JSON.stringify({ ...reports()[0], model: null }),
  );
  assert.ok(
    recommendModelRouting(await store.list(), policy, now).decisions.every(
      (decision) => decision.recommendedModel === null,
    ),
    'a damaged reference cannot be replaced with unrelated evidence',
  );
});
