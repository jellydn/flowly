#!/usr/bin/env node
/**
 * Drift guard for the codemap layout docs.
 *
 * Asserts that `.planning/codebase/STRUCTURE.md`'s per-directory
 * "Contains:" lists match the real tree in both directions:
 *
 *   1. every documented file/dir exists (no stale entries), and
 *   2. every real source file/dir is documented (new files can't silently
 *      rot the layout docs).
 *
 * It also validates parenthetical subdir lists (e.g. `eval/bench/` and
 * `github/events/` — the lists that twice missed a new module), and checks
 * the documented test-file counts in STRUCTURE.md (tree line and `tests/`
 * section) and `.planning/codebase/TESTING.md` against the real
 * `tests/*.test.ts` files. A missing expected pattern is a hard failure,
 * not a silent pass.
 *
 * Run via `npm run check:docs` (part of `npm run check`, which CI runs).
 * Exit 0 when the docs match the tree, 1 with a per-item list otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const STRUCTURE = '.planning/codebase/STRUCTURE.md';
const TESTING = '.planning/codebase/TESTING.md';

/**
 * The layout sections the guard validates. STRUCTURE.md also contains
 * "Special Directories" headers (`.planning/`, `dist/`, …) that match the
 * same heading syntax; restricting to this allow-list keeps those from
 * being validated as source dirs.
 */
const LAYOUT_DIRS = new Set([
  'agents/',
  'tools/',
  'investigation/',
  'planner/',
  'reliability/',
  'review/',
  'github/',
  'index/',
  'scripts/',
  'eval/',
  'demo/',
  'docs/',
  'tests/',
]);

/** Top-level entries that are generated/ignored and never documented. */
const IGNORED_TOP_LEVEL = new Set([
  '.git',
  '.flue-vite',
  '.freebuff',
  '.worktrees',
  'dist',
  'node_modules',
  'results', // eval/ results dir created by `npm run eval`
]);

/** Sections validated only by count (tests/), not by per-file lists. */
const COUNT_ONLY_SECTIONS = new Set(['tests/']);

/** Shorthand like `doc-aware-demo.ts/.sh` → `doc-aware-demo.ts` + `.sh`. */
function expandShorthand(token: string): string[] {
  const match = token.match(/^(.+?)\.([a-z0-9]{1,5})\/\.([a-z0-9]{1,5})$/);
  if (!match) return [token];
  const [, base, ext1, ext2] = match;
  return [`${base}.${ext1}`, `${base}.${ext2}`];
}

/** Documented top-level names derived from a token (`benchmarks/x.json` → `benchmarks`). */
function topLevelName(token: string): string {
  const first = token.split('/')[0];
  return first.endsWith('/') ? first.slice(0, -1) : first;
}

/** Parse "Contains:" lists per section from STRUCTURE.md. */
function parseContainsLines(text: string): Array<{ dir: string; contains: string }> {
  const sections: Array<{ dir: string; contains: string }> = [];
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const section = line.match(/^\*\*`(.+)`:\*\*$/);
    if (section) {
      current = section[1];
      continue;
    }
    const contains = line.match(/^- Contains: (.*)$/);
    if (contains && current) {
      sections.push({ dir: current, contains: contains[1] });
    }
  }
  return sections;
}

/** Assert a documented path exists; push a clear error otherwise. */
function assertExists(errors: string[], where: string, token: string, full: string, isDirToken: boolean): void {
  try {
    const isDir = statSync(full).isDirectory();
    if (isDirToken && !isDir) {
      errors.push(`${where}: \`${token}\` is documented as a dir but is a file`);
    }
  } catch {
    errors.push(`${where}: documented \`${token}\` does not exist`);
  }
}

/**
 * Validate a `subdir/ (name, name, …)` parenthetical list (e.g. eval/bench,
 * github/events). Only applies to subdirs whose real contents are `.ts`
 * modules; descriptive parentheticals over other formats (e.g. `docs/adr/`
 * `(0001–0004, README, template)` over `.md` files) are skipped.
 */
function validateParenthetical(errors: string[], dir: string, contains: string): void {
  for (const match of contains.matchAll(/`([^`]+\/)`\s*\(([^)]*)\)/g)) {
    const [, subdir, namesRaw] = match;
    const subPath = path.join(dir, subdir);

    let rawEntries: string[] = [];
    try {
      rawEntries = readdirSync(subPath, { withFileTypes: true })
        .filter((e) => !IGNORED_TOP_LEVEL.has(e.name))
        .filter((e) => !e.name.endsWith('.test.ts'))
        .map((e) => e.name);
    } catch {
      rawEntries = [];
    }
    if (rawEntries.length === 0 || !rawEntries.some((n) => n.endsWith('.ts'))) return;

    const names = namesRaw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const realNames = rawEntries.map((n) => (n.endsWith('.ts') ? n.slice(0, -3) : n));

    for (const name of names) {
      try {
        statSync(path.join(subPath, `${name}.ts`));
      } catch {
        errors.push(`${STRUCTURE} ${dir}: \`${subdir}${name}.ts\` is documented but does not exist`);
      }
    }
    for (const real of realNames) {
      if (!names.includes(real)) {
        errors.push(`${STRUCTURE} ${dir}: \`${subdir}${real}.ts\` exists but is not documented`);
      }
    }
  }
}

function main(): void {
  const structure = readFileSync(STRUCTURE, 'utf8');
  const testing = readFileSync(TESTING, 'utf8');
  const errors: string[] = [];

  const sections = parseContainsLines(structure);
  const seenDirs = new Set<string>();
  for (const { dir } of sections) seenDirs.add(dir);

  for (const dir of LAYOUT_DIRS) {
    if (!seenDirs.has(dir)) {
      errors.push(`${STRUCTURE}: no "Contains:" section for \`${dir}\` — parsing broke or the section was removed`);
    }
  }

  const actualTestFiles = readdirSync('tests').filter((f) => f.endsWith('.test.ts'));

  for (const { dir, contains } of sections) {
    if (!LAYOUT_DIRS.has(dir)) continue;

    if (COUNT_ONLY_SECTIONS.has(dir)) {
      // Count check: "Contains: 27 `.test.ts` files + `helpers.ts`".
      const countMatch = contains.match(/(\d+) `\.test\.ts`/);
      if (!countMatch) {
        errors.push(`${STRUCTURE} ${dir}: expected "N \`.test.ts\` files" count pattern not found`);
      } else if (Number(countMatch[1]) !== actualTestFiles.length) {
        errors.push(
          `${STRUCTURE} ${dir}: documents ${countMatch[1]} .test.ts files, found ${actualTestFiles.length}`,
        );
      }
      continue;
    }

    const tokens = [...contains.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const documentedFiles = tokens.flatMap(expandShorthand);
    const documentedTopLevel = new Set(
      documentedFiles.map(topLevelName).filter((n) => !n.startsWith('.')),
    );

    // Direction 1: every documented entry must exist.
    for (const token of documentedFiles) {
      assertExists(errors, `${STRUCTURE} ${dir}`, token, path.join(dir, token), token.endsWith('/'));
    }

    // Parenthetical subdir lists (bench/, events/) — the lists that rotted twice.
    validateParenthetical(errors, dir, contains);

    // Direction 2: every real source entry must be documented.
    const realEntries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !IGNORED_TOP_LEVEL.has(e.name))
      .filter((e) => !e.name.endsWith('.test.ts'))
      .map((e) => e.name);
    for (const entry of realEntries) {
      if (!documentedTopLevel.has(entry)) {
        errors.push(`${STRUCTURE} ${dir}: \`${entry}\` exists but is not documented`);
      }
    }
  }

  // Test counts in the STRUCTURE.md tree block and TESTING.md.
  const treeCount = structure.match(/tests\/\s+# Node test-runner tests \((\d+) files/);
  if (!treeCount) {
    errors.push(`${STRUCTURE}: expected "tests/ # Node test-runner tests (N files + helpers)" pattern not found`);
  } else if (Number(treeCount[1]) !== actualTestFiles.length) {
    errors.push(`${STRUCTURE} tree: documents ${treeCount[1]} test files, found ${actualTestFiles.length}`);
  }
  const testingCount = testing.match(/\*\.test\.ts\s+# (\d+) test files/);
  if (!testingCount) {
    errors.push(`${TESTING}: expected "*.test.ts # N test files" pattern not found`);
  } else if (Number(testingCount[1]) !== actualTestFiles.length) {
    errors.push(`${TESTING}: documents ${testingCount[1]} test files, found ${actualTestFiles.length}`);
  }

  if (errors.length > 0) {
    console.error(`[check-doc-tree] ${errors.length} drift item(s) in layout docs:`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error('[check-doc-tree] Update .planning/codebase/STRUCTURE.md / TESTING.md to match the tree.');
    process.exit(1);
  }

  const documentedFiles = sections
    .filter(({ dir }) => LAYOUT_DIRS.has(dir))
    .flatMap(({ contains }) => [...contains.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  console.error(
    `[check-doc-tree] OK — ${LAYOUT_DIRS.size} sections, ${documentedFiles.length} documented entries, ` +
      `${actualTestFiles.length} test files match the tree.`,
  );
}

main();
