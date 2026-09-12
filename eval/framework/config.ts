/**
 * Benchmark config loading: reads a benchmark suite (and optional model list)
 * from JSON or YAML files and validates them, naming the offending field on failure.
 * Mirrors the event-router's loadConfigFromFile (github/events/config.ts).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseBenchmarkConfig, parseModel, parseSuite } from './schema.ts';
import type { BenchmarkSuite, ModelSpec } from './types.ts';

export type LoadResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function parseConfigText(
  text: string,
  label: string,
): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  try {
    const extension = path.extname(label).toLowerCase();
    return {
      ok: true,
      value: extension === '.yaml' || extension === '.yml' ? parseYaml(text) : JSON.parse(text),
    };
  } catch {
    return { ok: false, issues: [`"${label}" is not valid JSON or YAML.`] };
  }
}

/** Load and validate a benchmark suite from a JSON or YAML file. */
export async function loadSuiteFromFile(filePath: string): Promise<LoadResult<BenchmarkSuite>> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      issues: [
        `Cannot read "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const parsed = parseConfigText(text, filePath);
  if (!parsed.ok) return parsed;
  const suite = parseSuite(parsed.value);
  if (!suite.ok) return { ok: false, issues: suite.issues };
  return { ok: true, value: suite.suite };
}

/** Load and validate a single model spec from a JSON or YAML file. */
export async function loadModelFromFile(filePath: string): Promise<LoadResult<ModelSpec>> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      issues: [
        `Cannot read "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const parsed = parseConfigText(text, filePath);
  if (!parsed.ok) return parsed;
  const model = parseModel(parsed.value);
  if (!model.ok) return { ok: false, issues: model.issues };
  return { ok: true, value: model.model };
}

/**
 * Load a full benchmark config (suite + models) from a JSON or YAML file. This is
 * the shape `npm run eval` consumes: `{ "suite": {...}, "models": [...] }`.
 */
export async function loadBenchmarkConfigFromFile(
  filePath: string,
): Promise<
  { ok: true; suite: BenchmarkSuite; models: ModelSpec[] } | { ok: false; issues: string[] }
> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      issues: [
        `Cannot read "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const parsed = parseConfigText(text, filePath);
  if (!parsed.ok) return parsed;
  const config = parseBenchmarkConfig(parsed.value);
  if (!config.ok) return { ok: false, issues: config.issues };
  return { ok: true, suite: config.config.suite, models: config.config.models };
}
