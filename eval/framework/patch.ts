/**
 * Patch applicability measurement (issue #38).
 *
 * "Patch applicability" asks whether a model's proposed code change applies
 * cleanly to the repository. The benchmark framework wires this as an
 * default `git apply --check` measurement for coding-task workloads. A caller
 * can replace it through the runner's optional `measurePatch` hook.
 *
 * `createPatchCheck` remains as a lightweight programmatic seam for callers
 * that need their own validator.
 */

import { spawn } from 'node:child_process';
import type { BenchmarkScenario, MetricPass } from './types.ts';

export type PatchValidator = (patch: string, expectedPaths: string[]) => Promise<boolean>;

/** Extract fenced code blocks (``` ... ```) from a model answer. */
export function extractFencedBlocks(answer: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(answer)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/** Extract a unified diff from a diff/patch fence or an unfenced answer. */
export function extractUnifiedDiff(answer: string): string | null {
  const fenced = /```(?:diff|patch)\n([\s\S]*?)```/i.exec(answer)?.[1]?.trim();
  if (fenced?.startsWith('diff --git ')) return `${fenced}\n`;
  const start = answer.indexOf('diff --git ');
  return start === -1
    ? null
    : `${answer
        .slice(start)
        .replace(/```\s*$/, '')
        .trim()}\n`;
}

/**
 * Check a coding-task answer with `git apply --check`. The command reads the
 * patch from stdin and does not change the working tree.
 */
export function createGitPatchCheck(
  repositoryPath: string,
): (scenario: BenchmarkScenario, answer: string) => Promise<MetricPass | null> {
  return async (scenario, answer) => {
    if (scenario.workload?.type !== 'coding-task') return null;
    const patch = extractUnifiedDiff(answer);
    if (!patch) return { passed: false, detail: 'No unified diff found in the answer' };

    return new Promise((resolve) => {
      const child = spawn(
        'git',
        ['-C', repositoryPath, 'apply', '--check', '--whitespace=nowarn', '-'],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let error = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        error += chunk;
      });
      child.on('error', (cause) => {
        resolve({ passed: false, detail: `Patch check could not run: ${cause.message}` });
      });
      child.on('close', (code) => {
        resolve(
          code === 0
            ? { passed: true, detail: 'Unified diff passes git apply --check' }
            : {
                passed: false,
                detail: `Unified diff does not apply: ${error.trim().split('\n')[0] || 'git apply failed'}`,
              },
        );
      });
      child.stdin.end(patch);
    });
  };
}

/**
 * Deterministic patch check: a patch "applies" when the answer proposes a
 * change referencing the expected file paths. Suites can supply a stricter
 * validator (e.g. `git apply --check` on a real diff) via `validate`.
 */
export function createPatchCheck(
  input: {
    validate?: PatchValidator;
  } = {},
): (scenario: BenchmarkScenario, answer: string) => Promise<MetricPass | null> {
  const validate: PatchValidator =
    input.validate ??
    (async (patch, expectedPaths) => expectedPaths.some((expected) => patch.includes(expected)));

  return async (scenario, answer) => {
    const expectedPaths = scenario.expectedSources ?? [];
    if (expectedPaths.length === 0) return null; // not measured: no expected files
    const blocks = extractFencedBlocks(answer);
    const patch = blocks.join('\n');
    if (patch.length === 0) {
      return { passed: false, detail: 'No fenced code block (patch) in the answer' };
    }
    const applies = await validate(patch, expectedPaths);
    return applies
      ? { passed: true, detail: `Proposed patch covers ${expectedPaths.join(', ')}` }
      : { passed: false, detail: 'Proposed patch does not apply to the expected files' };
  };
}
