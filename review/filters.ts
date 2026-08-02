/**
 * Generated, lockfile, snapshot, and vendored-file detection. The reviewer
 * skips these to focus on hand-written source. Skipped files are still listed
 * by `list_changed_files` (marked `skip: true`) so the agent can see the full
 * PR surface, but they are not read or reviewed.
 */

import path from 'node:path';

/** Lockfiles that change mechanically and never need human review. */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'go.sum',
  'go.mod', // go.sum's pair; reviewed only for dep bumps, skipped by default
  'flake.lock',
  'mix.lock',
  'gradle.lockfile',
  'pipenv.lock',
  'conda-lock.yml',
]);

/** Path segments indicating vendored or third-party code. */
const VENDORED_SEGMENTS = new Set([
  'vendor',
  'vendors',
  'vendored',
  'third_party',
  'third-party',
  'node_modules',
]);

/** Extensions/basenames indicating generated or minified output. */
const GENERATED_PATTERNS = [
  /\.min\.js$/i,
  /\.min\.css$/i,
  /\.generated\./i,
  /\.gen\./i,
  /__generated__\//i,
  /\.pb\.go$/i, // protobuf-generated Go
  /_pb2\.py$/i,
  /\.g\.dart$/i,
];

const SNAPSHOT_PATTERNS = [/__snapshots__\//i, /\.snap$/i];

export type SkipReason = 'lockfile' | 'vendored' | 'generated' | 'snapshot' | 'binary';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg', // treated as non-reviewable text in some repos, but skipped by default
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.class',
  '.jar',
  '.wasm',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.pyc',
]);

export type FileSkipResult = {
  skip: boolean;
  reason?: SkipReason;
};

/** Decide whether a changed file should be reviewed. */
export function classifyFile(pathStr: string): FileSkipResult {
  const base = path.basename(pathStr);
  const ext = path.extname(pathStr).toLowerCase();
  const segments = pathStr.split('/').map((s) => s.toLowerCase());

  if (LOCKFILE_NAMES.has(base.toLowerCase())) {
    return { skip: true, reason: 'lockfile' };
  }

  if (segments.some((seg) => VENDORED_SEGMENTS.has(seg))) {
    return { skip: true, reason: 'vendored' };
  }

  if (GENERATED_PATTERNS.some((re) => re.test(pathStr))) {
    return { skip: true, reason: 'generated' };
  }

  if (SNAPSHOT_PATTERNS.some((re) => re.test(pathStr))) {
    return { skip: true, reason: 'snapshot' };
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return { skip: true, reason: 'binary' };
  }

  return { skip: false };
}

/** Convenience predicate. */
export function shouldSkipFile(pathStr: string): boolean {
  return classifyFile(pathStr).skip;
}
