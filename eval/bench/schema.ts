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
  apiKeyEnv: v.optional(nonEmpty),
  baseUrl: v.optional(nonEmpty),
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

/**
 * Parse a model spec given on the CLI: either a JSON object (validated like
 * the config's `models[]` entries) or a provider-qualified id string such as
 * `openrouter/qwen/qwen3-coder`, whose first path segment is the provider.
 * Returns field-path issues on failure, mirroring parseModel.
 */
export function parseModelSpecString(
  spec: string,
): { ok: true; model: ModelSpec } | { ok: false; issues: string[] } {
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return {
        ok: false,
        issues: [
          '--judge-model must be a JSON model spec or a provider-qualified model id (e.g. openrouter/qwen/qwen3-coder).',
        ],
      };
    }
    return parseModel(value);
  }
  const provider = trimmed.slice(0, trimmed.indexOf('/'));
  if (!provider || trimmed.indexOf('/') === -1) {
    return {
      ok: false,
      issues: ['--judge-model must include a provider segment (e.g. openrouter/qwen/qwen3-coder).'],
    };
  }
  return { ok: true, model: { id: trimmed, provider } };
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
