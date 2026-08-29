import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('parseModelSpecString accepts a provider-qualified id and a JSON spec', async () => {
  const { parseModelSpecString } = await import('../eval/bench/schema.ts');
  const fromId = parseModelSpecString('openrouter/qwen/qwen3-coder');
  assert.ok(fromId.ok);
  if (fromId.ok) {
    assert.equal(fromId.model.id, 'openrouter/qwen/qwen3-coder');
    assert.equal(fromId.model.provider, 'openrouter');
  }
  const fromJson = parseModelSpecString(
    '{"id":"openrouter/qwen/qwen3-coder","provider":"openrouter","apiKeyEnv":"OPENROUTER_API_KEY"}',
  );
  assert.ok(fromJson.ok);
  if (fromJson.ok) {
    assert.equal(fromJson.model.id, 'openrouter/qwen/qwen3-coder');
    assert.equal(fromJson.model.apiKeyEnv, 'OPENROUTER_API_KEY');
  }
  assert.ok(!parseModelSpecString('not-json-{').ok);
  assert.ok(!parseModelSpecString('no-provider').ok);
  assert.ok(!parseModelSpecString('{"id":"x"}').ok);
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

/** Minimal single-scenario suite used by the flag-level CLI tests. */
function minimalConfig(): object {
  return {
    suite: {
      id: 'capstone',
      name: 'Repository Assistant Capstone',
      repositoryPath: 'eval/fixtures/sample-repo',
      maxSteps: 8,
      scenarios: [
        {
          id: 'cap-1',
          prompt: 'What is the purpose of this repository?',
          expectedSources: ['README.md'],
          expectedKeywords: ['authentication', 'configuration'],
          requiresCitation: true,
          requiresToolCall: true,
        },
      ],
    },
    models: [{ id: 'openrouter/qwen/qwen3-coder', provider: 'openrouter', label: 'Qwen3 Coder' }],
  };
}

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
  // Single-model config so stdout is exactly one JSON report.
  const configPath = path.join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      suite: {
        id: 'capstone',
        name: 'Repository Assistant Capstone',
        repositoryPath: 'eval/fixtures/sample-repo',
        maxSteps: 8,
        scenarios: [
          {
            id: 'cap-1',
            prompt: 'What is the purpose of this repository?',
            expectedSources: ['README.md'],
            expectedKeywords: ['authentication', 'configuration'],
            requiresCitation: true,
            requiresToolCall: true,
          },
        ],
      },
      models: [{ id: 'openrouter/qwen/qwen3-coder', provider: 'openrouter', label: 'Qwen3 Coder' }],
    }),
  );
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('npx', ['tsx', 'scripts/flue-eval.ts', 'run', configPath, '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, FLUE_EVAL_RESULTS_DIR: dir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as BenchmarkReport;
  assert.equal(output.suiteId, 'capstone');
  assert.equal(output.totalScenarios, 1);
  assert.equal(output.passed, 1);
  assert.ok(output.summary.qualityScore > 0);
  assert.match(output.lineage?.suiteDigest ?? '', /^[a-f0-9]{64}$/);
});

test('CLI gate exits non-zero when a versioned threshold fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flue-eval-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = minimalConfig() as {
    suite: { gate?: { maxCostUsd: number } };
    models: Array<{ pricing?: { inputPer1kUsd: number; outputPer1kUsd: number } }>;
  };
  config.suite.gate = { maxCostUsd: 0 };
  config.models[0].pricing = { inputPer1kUsd: 1, outputPer1kUsd: 1 };
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    'npx',
    ['tsx', 'scripts/flue-eval.ts', 'gate', configPath, '--no-save'],
    {
      cwd: process.cwd(),
      env: { ...process.env, FLUE_EVAL_RESULTS_DIR: dir },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Gate: Qwen3 Coder — FAIL/);
  assert.match(result.stdout, /FAIL maxCostUsd/);
});

test('CLI --judge-model rejects a malformed spec with exit 2 and no key needed', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flue-eval-judge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(minimalConfig()));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    'npx',
    ['tsx', 'scripts/flue-eval.ts', 'run', configPath, '--judge-model', 'not-json-{'],
    {
      cwd: process.cwd(),
      env: { ...process.env, FLUE_EVAL_RESULTS_DIR: dir },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Invalid --judge-model spec/);
});

test('CLI --judge-model with a valid spec fails with the actionable key error before any run', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flue-eval-judge-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(minimalConfig()));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    'npx',
    [
      'tsx',
      'scripts/flue-eval.ts',
      'run',
      configPath,
      '--judge-model',
      'openrouter/qwen/qwen3-coder',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, FLUE_EVAL_RESULTS_DIR: dir },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  // Wiring reached createProviderClient: without a key it exits 1 with the
  // actionable message instead of silently running the keyword judge.
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No API key for provider "openrouter"/);
});
