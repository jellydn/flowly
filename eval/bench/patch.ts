/**
 * Patch applicability measurement (issue #38).
 *
 * "Patch applicability" asks whether a model's proposed code change applies
 * cleanly to the repository. The benchmark framework wires this as an
 * optional `measurePatch` hook on the runner, so suites opt in per scenario.
 *
 * The bundled check is a conservative, deterministic heuristic: it extracts
 * fenced code blocks from the model answer and passes them to a validator.
 * The default validator is a keyword check (does the answer propose a change
 * to the expected file?), which suites can replace with a real `git apply
 * --check` when a patch string is available.
 */

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

/**
 * Deterministic patch check: a patch "applies" when the answer proposes a
 * change referencing the expected file paths. Suites can supply a stricter
 * validator (e.g. `git apply --check` on a real diff) via `validate`.
 */
export function createPatchCheck(input: {
  validate?: PatchValidator;
} = {}): (scenario: BenchmarkScenario, answer: string) => Promise<MetricPass | null> {
  const validate: PatchValidator =
    input.validate ??
    (async (_patch, expectedPaths) => expectedPaths.length > 0);

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
