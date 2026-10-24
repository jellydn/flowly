import * as v from 'valibot';
import { computeSummary, evaluateBenchmarkRegression } from './metrics.ts';
import type { BenchmarkReport, BenchmarkWorkload } from './types.ts';

const nonnegative = v.pipe(v.number(), v.finite(), v.minValue(0));
const workload = v.picklist([
  'repository-question',
  'github-issue',
  'pull-request-review',
  'coding-task',
]);
export const routingPolicySchema = v.strictObject({
  referenceRunId: v.pipe(v.string(), v.minLength(1)),
  workloads: v.pipe(v.array(workload), v.minLength(1)),
  minQualityScore: v.pipe(nonnegative, v.maxValue(1)),
  maxCostUsdPerScenario: nonnegative,
  maxAvgLatencyMs: nonnegative,
  maxAgeHours: v.pipe(nonnegative, v.minValue(1)),
  minRuns: v.pipe(nonnegative, v.integer(), v.minValue(2)),
  minScenarios: v.pipe(nonnegative, v.integer(), v.minValue(2)),
  optimize: v.picklist(['cost', 'quality', 'latency']),
});
export type RoutingPolicy = v.InferOutput<typeof routingPolicySchema>;

/** Advice only. Never invokes a model, changes credentials, or writes routing configuration. */
export function recommendModelRouting(
  reports: BenchmarkReport[],
  input: RoutingPolicy,
  now = Date.now(),
) {
  const policy = v.parse(routingPolicySchema, input);
  if (!Number.isFinite(now)) throw new Error('Invalid routing clock');
  const reference = reports.find((report) => report.runId === policy.referenceRunId);
  const fresh = (report: BenchmarkReport) => {
    const time = Date.parse(report.ranAt);
    return Number.isFinite(time) && time <= now && now - time <= policy.maxAgeHours * 3600000;
  };
  const compatible = (report: BenchmarkReport) => {
    if (!reference || report.mode !== 'live') return false;
    try {
      evaluateBenchmarkRegression(reference, report);
      return reference.results.every(
        (result) =>
          (result.workloadType ?? 'repository-question') ===
          (report.results.find((candidate) => candidate.id === result.id)?.workloadType ??
            'repository-question'),
      );
    } catch {
      return false;
    }
  };
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const report of reports) {
    if (seen.has(report.runId)) duplicateIds.add(report.runId);
    seen.add(report.runId);
  }
  const validReference =
    reference && !duplicateIds.has(reference.runId) && fresh(reference) && compatible(reference);
  const groups = new Map<string, BenchmarkReport[]>();
  for (const report of reports) {
    if (report.suiteId !== reference?.suiteId) continue;
    const key = JSON.stringify([report.model.provider, report.model.id]);
    groups.set(key, [...(groups.get(key) ?? []), report]);
  }
  const decisions = [...new Set(policy.workloads)].map((target: BenchmarkWorkload['type']) => {
    const candidates = [...groups.values()].map((group) => {
      group.sort(
        (a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt) || a.runId.localeCompare(b.runId),
      );
      const latest = group[0];
      const reasons: string[] = [];
      if (!validReference)
        reasons.push(
          'Reference evidence is missing, ambiguous, stale, deterministic, or lacks valid lineage/scenarios',
        );
      if (group.some((report) => !Number.isFinite(Date.parse(report.ranAt))))
        reasons.push('Model history contains invalid timestamps');
      if (!fresh(latest) || !compatible(latest))
        reasons.push(
          'Latest model run is stale, future-dated, or incompatible; older successes cannot override it',
        );
      const evidence = group.filter((report) => fresh(report) && compatible(report));
      if (evidence.length < policy.minRuns)
        reasons.push(`Need at least ${policy.minRuns} fresh comparable live runs`);
      if (evidence.some((report) => duplicateIds.has(report.runId)))
        reasons.push('Duplicate run identities are not independent evidence');
      const samples = evidence.flatMap((report) =>
        report.results.filter(
          (result) => (result.workloadType ?? 'repository-question') === target,
        ),
      );
      for (const report of evidence) {
        const selected = report.results.filter(
          (result) => (result.workloadType ?? 'repository-question') === target,
        );
        if (selected.length < policy.minScenarios)
          reasons.push(
            `Run ${report.runId} needs ${policy.minScenarios} distinct ${target} scenarios`,
          );
        if (
          selected.some(
            (result) =>
              !result.passed ||
              result.errors.length > 0 ||
              !result.metrics.toolSuccess.passed ||
              result.metrics.humanAccepted === false ||
              (target === 'coding-task' && result.metrics.patchApplicability?.passed !== true),
          )
        )
          reasons.push(`Run ${report.runId} has failed, rejected, or unverified workload evidence`);
        if (
          selected.some(
            (result) =>
              !Number.isFinite(result.metrics.qualityScore) ||
              result.metrics.qualityScore < 0 ||
              result.metrics.qualityScore > 1 ||
              !Number.isFinite(result.metrics.latencyMs) ||
              result.metrics.latencyMs < 0 ||
              !Number.isFinite(result.metrics.costUsd) ||
              result.metrics.costUsd < 0,
          )
        )
          reasons.push(`Run ${report.runId} has unknown or invalid metrics`);
        const summary = computeSummary(selected);
        if (
          selected.length &&
          (summary.qualityScore < policy.minQualityScore ||
            summary.avgLatencyMs > policy.maxAvgLatencyMs ||
            summary.costUsd / selected.length > policy.maxCostUsdPerScenario)
        )
          reasons.push(`Run ${report.runId} exceeds quality, latency, or cost constraints`);
      }
      const summary = computeSummary(samples);
      const metrics = samples.length
        ? {
            qualityScore: summary.qualityScore,
            avgLatencyMs: summary.avgLatencyMs,
            costUsdPerScenario: summary.costUsd / samples.length,
            samples: samples.length,
          }
        : null;
      return {
        model: { id: latest.model.id, provider: latest.model.provider },
        eligible: reasons.length === 0,
        reasons: [...new Set(reasons)],
        metrics,
        evidence: evidence.map((report) => ({
          runId: report.runId,
          ranAt: report.ranAt,
          suiteId: report.suiteId,
          lineage: report.lineage,
          judge: report.judge ?? 'keyword',
          scenarioIds: report.results
            .filter((result) => (result.workloadType ?? 'repository-question') === target)
            .map((result) => result.id),
        })),
      };
    });
    const eligible = candidates.filter((candidate) => candidate.eligible && candidate.metrics);
    eligible.sort((a, b) => {
      const x = a.metrics!;
      const y = b.metrics!;
      const primary =
        policy.optimize === 'cost'
          ? x.costUsdPerScenario - y.costUsdPerScenario
          : policy.optimize === 'latency'
            ? x.avgLatencyMs - y.avgLatencyMs
            : y.qualityScore - x.qualityScore;
      return (
        primary ||
        y.qualityScore - x.qualityScore ||
        x.costUsdPerScenario - y.costUsdPerScenario ||
        x.avgLatencyMs - y.avgLatencyMs ||
        a.model.id.localeCompare(b.model.id) ||
        a.model.provider.localeCompare(b.model.provider)
      );
    });
    const winner = eligible[0];
    return {
      workload: target,
      recommendedModel: winner?.model ?? null,
      explanation: winner
        ? `Ranks first by ${policy.optimize}, then quality, cost, latency, and model identity; every included run meets constraints. Evidence is benchmark-specific, not a production guarantee.`
        : 'No recommendation: evidence or constraints are insufficient. See candidate rejection reasons.',
      candidates,
    };
  });
  return {
    advisoryOnly: true,
    generatedAt: new Date(now).toISOString(),
    policy,
    reference: reference
      ? {
          runId: reference.runId,
          suiteId: reference.suiteId,
          lineage: reference.lineage,
          mode: reference.mode,
          judge: reference.judge ?? 'keyword',
        }
      : null,
    decisions,
  };
}
