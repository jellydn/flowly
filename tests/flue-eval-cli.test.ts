import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadBenchmarkConfigFromFile } from '../eval/bench/config.ts';
import { createMemoryBenchmarkStore } from '../eval/bench/store.ts';
import type { BenchmarkReport } from '../eval/bench/types.ts';

test('sample benchmark config loads and validates', async () => {
  const loaded = await loadBenchmarkConfigFromFile('eval/benchmarks/sample.json');
  assert.ok(loaded.ok);
  if (loaded.ok) {
    assert.equal(loaded.suite.id, 'capstone');
    assert.equal(loaded.suite.scenarios.length, 7);
    assert.ok(loaded.models.length >= 3);
    // Scenario ids must match the bundled capstone deciders the CLI wires up.
    assert.deepEqual(
      loaded.suite.scenarios.map((s) => s.id),
      ['cap-1', 'cap-2', 'cap-3', 'cap-4', 'cap-5', 'cap-6', 'cap-7'],
    );
  }
});

test('sample benchmark suite scenario ids match capstone decider ids', async () => {
  const { capstoneScenarios } = await import('../eval/capstone-eval.ts');
  const loaded = await loadBenchmarkConfigFromFile('eval/benchmarks/sample.json');
  assert.ok(loaded.ok);
  if (loaded.ok) {
    const deciderIds = new Set(capstoneScenarios.map((s) => s.id));
    for (const scenario of loaded.suite.scenarios) {
      assert.ok(deciderIds.has(scenario.id), `missing decider for ${scenario.id}`);
    }
  }
});

test('report store round-trips a full report', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flue-eval-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createMemoryBenchmarkStore();

  const report: BenchmarkReport = {
    runId: 'capstone-m-123',
    suiteId: 'capstone',
    suiteName: 'Repository Assistant Capstone',
    model: { id: 'm', provider: 'openrouter', label: 'M' },
    ranAt: '2026-01-01T00:00:00.000Z',
    mode: 'deterministic',
    totalScenarios: 7,
    passed: 6,
    failed: 1,
    results: [],
    summary: {
      qualityScore: 0.86,
      avgLatencyMs: 42,
      totalTokens: 1000,
      costUsd: 0.01,
      toolSuccessRate: 1,
      patchApplicabilityRate: Number.NaN,
      humanAcceptanceRate: Number.NaN,
    },
  };
  await store.save(report);
  const loaded = await store.load('capstone-m-123');
  assert.equal(loaded?.runId, 'capstone-m-123');
  assert.equal(loaded?.summary.qualityScore, 0.86);
});

test('CLI run command is smoke-testable via tsx without an LLM key', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flue-eval-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    'npx',
    ['tsx', 'scripts/flue-eval.ts', 'run', '--json'],
    {
      cwd: process.cwd(),
      env: { ...process.env, FLUE_EVAL_RESULTS_DIR: dir },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as BenchmarkReport;
  assert.equal(output.suiteId, 'capstone');
  assert.equal(output.totalScenarios, 7);
  assert.ok(output.summary.qualityScore > 0);
});
