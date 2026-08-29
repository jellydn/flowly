/**
 * Benchmark metric computation: cost estimation from token usage and model
 * pricing, per-scenario quality scoring, and report aggregation.
 */

import type {
  BenchmarkGate,
  BenchmarkGateCheck,
  BenchmarkGateResult,
  BenchmarkReport,
  BenchmarkScenario,
  BenchmarkSummary,
  MetricPass,
  ModelPricing,
  ScenarioResult,
} from './types.ts';

/** Evaluate one report against the suite's versioned acceptance thresholds. */
export function evaluateBenchmarkGate(
  report: BenchmarkReport,
  gate: BenchmarkGate,
): BenchmarkGateResult {
  const passRate = report.totalScenarios === 0 ? 0 : report.passed / report.totalScenarios;
  const checks: BenchmarkGateCheck[] = [];
  const minimums: Array<[BenchmarkGateCheck['metric'], number, number | undefined]> = [
    ['minPassRate', passRate, gate.minPassRate],
    ['minQualityScore', report.summary.qualityScore, gate.minQualityScore],
    ['minToolSuccessRate', report.summary.toolSuccessRate, gate.minToolSuccessRate],
  ];
  const maximums: Array<[BenchmarkGateCheck['metric'], number, number | undefined]> = [
    ['maxAvgLatencyMs', report.summary.avgLatencyMs, gate.maxAvgLatencyMs],
    ['maxCostUsd', report.summary.costUsd, gate.maxCostUsd],
  ];
  for (const [metric, actual, threshold] of minimums) {
    if (threshold !== undefined)
      checks.push({ metric, passed: actual >= threshold, actual, threshold });
  }
  for (const [metric, actual, threshold] of maximums) {
    if (threshold !== undefined)
      checks.push({ metric, passed: actual <= threshold, actual, threshold });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

/** Estimate USD cost from token usage and per-1K pricing. */
export function estimateCost(tokensIn: number, tokensOut: number, pricing?: ModelPricing): number {
  if (!pricing) return 0;
  return (tokensIn / 1000) * pricing.inputPer1kUsd + (tokensOut / 1000) * pricing.outputPer1kUsd;
}

const passRate = (
  results: ScenarioResult[],
  pick: (r: ScenarioResult) => MetricPass | null,
): number => {
  const measured = results.map(pick).filter((p): p is MetricPass => p !== null);
  if (measured.length === 0) return Number.NaN;
  return measured.filter((p) => p.passed).length / measured.length;
};

/** Compute the aggregate summary for a set of scenario results. */
export function computeSummary(results: ScenarioResult[]): BenchmarkSummary {
  if (results.length === 0) {
    return {
      qualityScore: 0,
      avgLatencyMs: 0,
      totalTokens: 0,
      costUsd: 0,
      toolSuccessRate: 0,
      patchApplicabilityRate: Number.NaN,
      humanAcceptanceRate: Number.NaN,
    };
  }
  return {
    qualityScore: results.reduce((sum, r) => sum + r.metrics.qualityScore, 0) / results.length,
    avgLatencyMs: Math.round(
      results.reduce((sum, r) => sum + r.metrics.latencyMs, 0) / results.length,
    ),
    totalTokens: results.reduce((sum, r) => sum + r.metrics.tokensIn + r.metrics.tokensOut, 0),
    costUsd: results.reduce((sum, r) => sum + r.metrics.costUsd, 0),
    toolSuccessRate: passRate(results, (r) => r.metrics.toolSuccess),
    patchApplicabilityRate: passRate(results, (r) => r.metrics.patchApplicability),
    // Only reviewed scenarios count; unreviewed runs report NaN.
    humanAcceptanceRate: passRate(results, (r) =>
      r.metrics.humanAccepted === undefined
        ? null
        : { passed: r.metrics.humanAccepted, detail: '' },
    ),
  };
}

/**
 * Record a human accept/reject verdict per scenario and return a new report
 * with the updated acceptance rate. Unknown scenario ids are ignored; existing
 * verdicts are overwritten. The input report is not mutated.
 */
export function recordHumanAcceptance(
  report: BenchmarkReport,
  verdicts: Record<string, boolean>,
): BenchmarkReport {
  const results = report.results.map((r) => {
    const verdict = verdicts[r.id];
    return verdict === undefined ? r : { ...r, metrics: { ...r.metrics, humanAccepted: verdict } };
  });
  return { ...report, results, summary: computeSummary(results) };
}

/**
 * Score a scenario 0..1 by averaging its measured metric dimensions.
 * Dimensions marked "not required" by the scenario pass automatically.
 */
export function scoreScenario(
  scenario: BenchmarkScenario,
  metricPasses: Record<
    'toolSuccess' | 'citationAccuracy' | 'retrievalRelevance' | 'answerCompleteness',
    MetricPass
  >,
): number {
  const dimensions: MetricPass[] = [
    metricPasses.toolSuccess,
    metricPasses.citationAccuracy,
    metricPasses.retrievalRelevance,
    metricPasses.answerCompleteness,
  ];
  const passed = dimensions.filter((d) => d.passed).length;
  return passed / dimensions.length;
}

/** Build a report shell from scenarios and results (used by the runner). */
export function buildReport(input: {
  runId: string;
  suiteId: string;
  suiteName: string;
  model: { id: string; provider: string; label: string };
  mode: 'deterministic' | 'live';
  results: ScenarioResult[];
  judge?: 'keyword' | string;
  lineage?: BenchmarkReport['lineage'];
}): BenchmarkReport {
  const passed = input.results.filter((r) => r.passed).length;
  return {
    runId: input.runId,
    suiteId: input.suiteId,
    suiteName: input.suiteName,
    model: input.model,
    ranAt: new Date().toISOString(),
    mode: input.mode,
    totalScenarios: input.results.length,
    passed,
    failed: input.results.length - passed,
    results: input.results,
    summary: computeSummary(input.results),
    judge: input.judge ?? 'keyword',
    lineage: input.lineage,
  };
}
