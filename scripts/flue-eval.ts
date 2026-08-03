#!/usr/bin/env node
/**
 * `flue eval` — model evaluation benchmark CLI (issue #38).
 *
 * Runs named benchmark suites against one or more models, persists reports,
 * and compares models on quality, latency, token usage, and cost. Inspired
 * by OpenRouter ORI Eval's model-comparison UX.
 *
 * Subcommands:
 *   run <config.json>         run every model in the config (deterministic by
 *                             default, --live for provider-backed runs)
 *   compare <config.json>     run + print a side-by-side model comparison
 *   leaderboard [--suite id]  list best saved reports, ranked by quality
 *   report <runId>            print one saved report
 *
 * Deterministic mode uses the bundled capstone decision functions — no LLM
 * key required, so CI runs are reproducible. `--live` uses a provider model
 * call (see `createOpenAiCompatibleClient` in eval/bench/providers.ts).
 *
 * Environment:
 *   FLUE_EVAL_RESULTS_DIR – results directory (default eval/results)
 *   OPENROUTER_API_KEY / FLUE_EVAL_API_KEY – key for --live OpenAI-compatible
 *                                            calls (default openrouter)
 *   FLUE_EVAL_MODEL       – model spec for --live (default
 *                           openrouter/qwen/qwen3-coder)
 *
 * Exit codes: 0 success, 1 config/run errors, 2 usage errors.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadBenchmarkConfigFromFile } from '../eval/bench/config.ts';
import { createFileBenchmarkStore } from '../eval/bench/store.ts';
import { runBenchmark } from '../eval/bench/runner.ts';
import { withDefaultPricing, createOpenAiCompatibleClient } from '../eval/bench/providers.ts';
import type { BenchmarkReport, ModelComparison, ModelSpec } from '../eval/bench/types.ts';
import { capstoneScenarios } from '../eval/capstone-eval.ts';
import type { DecisionFn } from '../investigation/types.ts';

const DEFAULT_CONFIG = 'eval/benchmarks/sample.json';
const DEFAULT_RESULTS_DIR = 'eval/results';

function fail(message: string, code = 1): never {
  console.error(`[flue-eval] ${message}`);
  process.exit(code);
}

function usage(): never {
  console.error(`Usage:
  npm run eval -- run <config.json> [--live] [--json]
  npm run eval -- compare <config.json> [--live]
  npm run eval -- leaderboard [--suite <id>]
  npm run eval -- report <runId>

Deterministic mode (default) uses the bundled capstone deciders and needs no
LLM key. Pass --live to run provider-backed model calls.`);
  process.exit(2);
}

/** Deciders keyed by scenario id, reusing the bundled capstone scenarios. */
function buildDeciders(): Record<string, DecisionFn> {
  const deciders: Record<string, DecisionFn> = {};
  for (const scenario of capstoneScenarios) {
    deciders[scenario.id] = scenario.decide;
  }
  return deciders;
}

function printReport(report: BenchmarkReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  lines.push(`Benchmark: ${report.suiteName} (${report.suiteId})`);
  lines.push(`Model:     ${report.model.label ?? report.model.id} (${report.model.provider})`);
  lines.push(`Mode:      ${report.mode}`);
  lines.push(`Result:    ${report.passed}/${report.totalScenarios} passed`);
  lines.push(`Quality:   ${(report.summary.qualityScore * 100).toFixed(0)}%`);
  lines.push(`Latency:   ${report.summary.avgLatencyMs}ms avg`);
  lines.push(`Tokens:    ${report.summary.totalTokens}`);
  lines.push(`Cost:      $${report.summary.costUsd.toFixed(4)}`);
  lines.push(`Tool OK:   ${(report.summary.toolSuccessRate * 100).toFixed(0)}%`);
  for (const result of report.results) {
    lines.push(`  [${result.id}] ${result.passed ? '✅' : '❌'} quality=${(result.metrics.qualityScore * 100).toFixed(0)}% latency=${result.metrics.latencyMs}ms tokens=${result.metrics.tokensIn + result.metrics.tokensOut}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function runAll(
  configPath: string,
  live: boolean,
): Promise<{ suiteName: string; suiteId: string; reports: BenchmarkReport[] }> {
  const loaded = await loadBenchmarkConfigFromFile(configPath);
  if (!loaded.ok) {
    for (const issue of loaded.issues) console.error(`  - ${issue}`);
    fail(`Invalid benchmark config (${configPath})`);
  }
  const { suite, models } = loaded;
  const resultsDir = process.env.FLUE_EVAL_RESULTS_DIR ?? DEFAULT_RESULTS_DIR;
  await mkdir(resultsDir, { recursive: true });

  const modelCall = live ? createLiveModelCall() : undefined;
  const reports: BenchmarkReport[] = [];
  const store = createFileBenchmarkStore(resultsDir);

  for (const rawModel of models) {
    const model: ModelSpec = withDefaultPricing(rawModel);
    const report = await runBenchmark(suite, model, {
      mode: live ? 'live' : 'deterministic',
      deciders: live ? undefined : buildDeciders(),
      modelCall,
      repositoryPath: suite.repositoryPath,
    });
    await store.save(report);
    reports.push(report);
  }
  return { suiteName: suite.name, suiteId: suite.id, reports };
}

function createLiveModelCall() {
  const apiKey = process.env.FLUE_EVAL_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) fail('--live requires FLUE_EVAL_API_KEY or OPENROUTER_API_KEY');
  const baseUrl = process.env.FLUE_EVAL_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const model = process.env.FLUE_EVAL_MODEL ?? 'openrouter/qwen/qwen3-coder';
  return createOpenAiCompatibleClient({ apiKey, baseUrl, model });
}

function printComparison(comparison: ModelComparison): void {
  const lines: string[] = [];
  lines.push(`Comparison: ${comparison.suiteName} (${comparison.suiteId})`);
  lines.push(
    `${'Model'.padEnd(32)} ${'Passed'.padEnd(10)} ${'Quality'.padEnd(8)} ${'Latency'.padEnd(10)} ${'Tokens'.padEnd(8)} ${'Cost'}`,
  );
  for (const entry of comparison.models) {
    lines.push(
      `${(entry.model.label ?? entry.model.id).padEnd(32)} ${`${entry.passed}/${entry.total}`.padEnd(10)} ${`${(entry.summary.qualityScore * 100).toFixed(0)}%`.padEnd(8)} ${`${entry.summary.avgLatencyMs}ms`.padEnd(10)} ${String(entry.summary.totalTokens).padEnd(8)} $${entry.summary.costUsd.toFixed(4)}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  const resultsDir = process.env.FLUE_EVAL_RESULTS_DIR ?? DEFAULT_RESULTS_DIR;
  const store = createFileBenchmarkStore(resultsDir);

  switch (command) {
    case 'run': {
      const configPath = rest[0] ?? DEFAULT_CONFIG;
      const live = rest.includes('--live');
      const json = rest.includes('--json');
      const { reports } = await runAll(configPath, live);
      for (const report of reports) printReport(report, json);
      return 0;
    }
    case 'compare': {
      const configPath = rest[0] ?? DEFAULT_CONFIG;
      const live = rest.includes('--live');
      const { suiteName, suiteId, reports } = await runAll(configPath, live);
      const comparison: ModelComparison = {
        suiteId,
        suiteName,
        models: reports.map((report) => ({
          model: report.model,
          runId: report.runId,
          passed: report.passed,
          total: report.totalScenarios,
          summary: report.summary,
        })),
      };
      printComparison(comparison);
      return 0;
    }
    case 'leaderboard': {
      const suiteId = rest.includes('--suite') ? rest[rest.indexOf('--suite') + 1] : undefined;
      if (rest.includes('--suite') && !suiteId) usage();
      const rows = await store.leaderboard(suiteId);
      if (rows.length === 0) {
        console.error('[flue-eval] No saved reports yet. Run `npm run eval -- run` first.');
        return 1;
      }
      const lines: string[] = [];
      lines.push(
        `${'Model'.padEnd(32)} ${'Suite'.padEnd(20)} ${'Quality'.padEnd(8)} ${'Latency'.padEnd(10)} ${'Cost'.padEnd(12)} ${'Run'}`,
      );
      for (const row of rows) {
        lines.push(
          `${row.modelLabel.padEnd(32)} ${row.suiteId.padEnd(20)} ${`${(row.qualityScore * 100).toFixed(0)}%`.padEnd(8)} ${`${row.avgLatencyMs}ms`.padEnd(10)} $${row.costUsd.toFixed(4).padEnd(8)} ${row.runId}`,
        );
      }
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'report': {
      const runId = rest[0];
      if (!runId) usage();
      const report = await store.load(runId);
      if (!report) {
        console.error(`[flue-eval] No saved report with runId "${runId}".`);
        return 1;
      }
      printReport(report, rest.includes('--json'));
      return 0;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(`[flue-eval] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
