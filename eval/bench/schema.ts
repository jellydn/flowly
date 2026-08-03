/**
 * Valibot schemas for benchmark suites, model specs, and judge configuration.
 *
 * Validation errors are actionable: they name the offending field path, so a
 * misconfigured suite file is caught before any scenario runs. This mirrors
 * the event-router config schema (github/events/config.ts).
 */

import * as v from 'valibot';
import type { BenchmarkScenario, BenchmarkSuite, ModelSpec } from './types.ts';

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const scenarioSchema = v.object({
  id: nonEmpty,
  prompt: nonEmpty,
  expectedSources: v.optional(v.array(nonEmpty)),
  expectedKeywords: v.optional(v.array(nonEmpty)),
  requiresCitation: v.optional(v.boolean()),
  requiresToolCall: v.optional(v.boolean()),
  maxSteps: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(100))),
});

const suiteSchema = v.object({
  id: v.pipe(nonEmpty, v.maxLength(100)),
  name: nonEmpty,
  description: v.optional(nonEmpty),
  maxSteps: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(100))),
  repositoryPath: v.optional(nonEmpty),
  scenarios: v.pipe(v.array(scenarioSchema), v.minLength(1)),
});

const pricingSchema = v.object({
  inputPer1kUsd: v.pipe(v.number(), v.minValue(0)),
  outputPer1kUsd: v.pipe(v.number(), v.minValue(0)),
});

const modelSchema = v.object({
  id: nonEmpty,
  provider: nonEmpty,
  label: v.optional(nonEmpty),
  pricing: v.optional(pricingSchema),
});

/** JSON config that wires a suite to a model list (used by `flue eval`). */
const benchmarkConfigSchema = v.object({
  suite: suiteSchema,
  models: v.pipe(v.array(modelSchema), v.minLength(1)),
});

export type SuiteInput = v.InferOutput<typeof suiteSchema>;
export type ModelInput = v.InferOutput<typeof modelSchema>;
export type BenchmarkConfig = v.InferOutput<typeof benchmarkConfigSchema>;

/** Parse a raw suite value, returning field-path issues on failure. */
export function parseSuite(value: unknown): { ok: true; suite: BenchmarkSuite } | { ok: false; issues: string[] } {
  const result = v.safeParse(suiteSchema, value);
  if (result.success) return { ok: true, suite: result.output as BenchmarkSuite };
  return { ok: false, issues: result.issues.map(formatIssue) };
}

/** Parse a raw model spec value, returning field-path issues on failure. */
export function parseModel(value: unknown): { ok: true; model: ModelSpec } | { ok: false; issues: string[] } {
  const result = v.safeParse(modelSchema, value);
  if (result.success) return { ok: true, model: result.output as ModelSpec };
  return { ok: false, issues: result.issues.map(formatIssue) };
}

/** Parse a full benchmark config (suite + models), returning issues on failure. */
export function parseBenchmarkConfig(
  value: unknown,
): { ok: true; config: BenchmarkConfig } | { ok: false; issues: string[] } {
  const result = v.safeParse(benchmarkConfigSchema, value);
  if (result.success) return { ok: true, config: result.output };
  return { ok: false, issues: result.issues.map(formatIssue) };
}

function formatIssue(issue: { path?: Array<{ key: unknown }>; message: string }): string {
  const path = issue.path?.map((p) => String(p.key)).join('.');
  return `${path ? path : '(root)'}: ${issue.message}`;
}
