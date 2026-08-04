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
 *   review <runId> --accept <id,...> [--reject <id,...>]
 *                             record human accept/reject verdicts on a saved
 *                             report and recompute the acceptance rate
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
import { createProviderClient, withDefaultPricing } from '../eval/bench/providers.ts';
import type { ModelCallFn } from '../eval/bench/providers.ts';
import { recordHumanAcceptance } from '../eval/bench/metrics.ts';
import type { BenchmarkReport, ModelComparison, ModelSpec } from '../eval/bench/types.ts';
import type { BenchmarkStore } from '../eval/bench/store.ts';
import { capstoneScenarios } from '../eval/capstone-eval.ts';
import type { DecisionFn } from '../investigation/types.ts';

const DEFAULT_CONFIG = 'eval/benchmarks/sample.json';
const DEFAULT_RESULTS_DIR = 'eval/results';

function fail(message: string, code = 1): never {
  console.error(`[flue-eval] ${message}`);
  process.exit(code);
}

/** First positional argument, skipping flags (e.g. `run --json` -> config path). */
function positional(rest: string[]): string | undefined {
  return rest.find((arg) => !arg.startsWith('--'));
}

/** Value following a `--flag` (undefined when the flag or its value is absent). */
function flagValue(rest: string[], flag: string): string | undefined {
  const index = rest.indexOf(flag);
  return index === -1 ? undefined : rest[index + 1];
}

/** Value of a `--flag <csv>` flag as a trimmed, non-empty id list. */
function csvFlag(rest: string[], flag: string): string[] {
  const value = flagValue(rest, flag);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** Load a saved report by runId, exiting with a usage/not-found error otherwise. */
async function loadReportOrExit(
  store: BenchmarkStore,
  runId: string | undefined,
): Promise<BenchmarkReport> {
  if (!runId) usage();
  const report = await store.load(runId);
  if (!report) fail(`No saved report with runId "${runId}".`);
  return report;
}

function usage(): never {
  console.error(`Usage:
  npm run eval -- run <config.json> [--live] [--json]
  npm run eval -- compare <config.json> [--live]
  npm run eval -- leaderboard [--suite <id>]
  npm run eval -- report <runId>
  npm run eval -- review <runId> --accept <id,...> [--reject <id,...>]

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

/** Short label for a scenario's human-verdict state. */
function verdictLabel(accepted: boolean | undefined): string {
  if (accepted === undefined) return 'unreviewed';
  return accepted ? 'accepted' : 'rejected';
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
  const human = report.summary.humanAcceptanceRate;
  lines.push(
    Number.isNaN(human)
      ? 'Human:     not reviewed yet (use `review`)'
      : `Human:     ${(human * 100).toFixed(0)}% accepted`,
  );
  for (const result of report.results) {
    const usageMark = result.metrics.usageSource === 'provider' ? 'billed' : 'est.';
    lines.push(`  [${result.id}] ${result.passed ? '✅' : '❌'} quality=${(result.metrics.qualityScore * 100).toFixed(0)}% latency=${result.metrics.latencyMs}ms tokens=${result.metrics.tokensIn + result.metrics.tokensOut}(${usageMark}) ${verdictLabel(result.metrics.humanAccepted)}`);
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

  // One client per model, resolved from the model spec's provider (its own
  // base URL and key env). Previously a single client built from
  // FLUE_EVAL_MODEL ran every model in the config against the same endpoint,
  // silently ignoring the config's per-model providers.
  const modelCalls = new Map<string, ModelCallFn>();
  if (live) {
    for (const model of models) {
      try {
        modelCalls.set(model.id, createProviderClient(model, process.env));
      } catch (error) {
        fail(
          `Cannot build a live client for model "${model.id}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const reports: BenchmarkReport[] = [];
  const store = createFileBenchmarkStore(resultsDir);

  for (const rawModel of models) {
    const model: ModelSpec = withDefaultPricing(rawModel);
    const report = await runBenchmark(suite, model, {
      mode: live ? 'live' : 'deterministic',
      deciders: live ? undefined : buildDeciders(),
      modelCall: modelCalls.get(model.id),
      repositoryPath: suite.repositoryPath,
    });
    await store.save(report);
    reports.push(report);
  }
  return { suiteName: suite.name, suiteId: suite.id, reports };
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
      const configPath = positional(rest) ?? DEFAULT_CONFIG;
      const live = rest.includes('--live');
      const json = rest.includes('--json');
      const { reports } = await runAll(configPath, live);
      if (json) {
        // Emit a single JSON document: an array when multiple models ran.
        const payload = reports.length === 1 ? reports[0] : reports;
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        for (const report of reports) printReport(report, false);
      }
      return 0;
    }
    case 'compare': {
      const configPath = positional(rest) ?? DEFAULT_CONFIG;
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
      const suiteId = flagValue(rest, '--suite');
      if (rest.includes('--suite') && suiteId === undefined) usage();
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
      const report = await loadReportOrExit(store, positional(rest));
      printReport(report, rest.includes('--json'));
      return 0;
    }
    case 'review': {
      const runId = positional(rest);
      if (!runId) usage();
      const accept = csvFlag(rest, '--accept');
      const reject = csvFlag(rest, '--reject');
      if (accept.length === 0 && reject.length === 0) {
        console.error('[flue-eval] review requires --accept and/or --reject with comma-separated scenario ids.');
        return 2;
      }
      const report = await loadReportOrExit(store, runId);
      const verdicts: Record<string, boolean> = {};
      for (const id of accept) verdicts[id] = true;
      for (const id of reject) verdicts[id] = false;
      const known = new Set(report.results.map((r) => r.id));
      const unknown = Object.keys(verdicts).filter((id) => !known.has(id));
      if (unknown.length > 0) {
        console.error(
          `[flue-eval] Warning: unknown scenario id(s) ignored: ${unknown.join(', ')}`,
        );
      }
      const updated = recordHumanAcceptance(report, verdicts);
      await store.save(updated);
      const rate = updated.summary.humanAcceptanceRate;
      console.error(
        `[flue-eval] Recorded ${accept.length} accept(s), ${reject.length} reject(s) on ${runId}.`,
      );
      printReport(updated, false);
      console.error(`[flue-eval] Human acceptance rate: ${Number.isNaN(rate) ? 'n/a' : `${(rate * 100).toFixed(0)}%`}`);
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
