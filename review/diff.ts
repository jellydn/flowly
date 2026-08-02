/**
 * Pure unified-diff parser. Splits `git diff` output into per-file entries
 * with hunk line ranges (in the new/post-change file). Used by the PR-data
 * source and the trusted review publisher to validate inline-comment line
 * numbers against the actual diff.
 *
 * Only the structural metadata (paths, statuses, hunk ranges, line counts)
 * is extracted — full file content is not retained, keeping memory bounded
 * for large diffs.
 */

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type DiffHunk = {
  /** First new-file line number covered by this hunk (1-based). */
  oldStart: number;
  oldEnd: number;
  /** First new-file line number covered by this hunk (1-based). */
  newStart: number;
  /** Last new-file line number covered by this hunk (inclusive). */
  newEnd: number;
};

export type FileDiff = {
  path: string;
  /** Path before a rename/copy, when present. */
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff produced by `git diff`. Returns one {@link FileDiff}
 * per changed file. Malformed or non-diff input yields an empty array.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  if (!diff) return [];
  const lines = diff.split(/\r?\n/);
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let inHunk = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      // Start a new file entry. Path is resolved from the +++ line below.
      if (current) files.push(current);
      current = {
        path: '',
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      inHunk = false;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('copy from ')) {
      current.oldPath = line.slice('copy from '.length);
      continue;
    }

    if (line.startsWith('--- ')) {
      if (line === '--- /dev/null') {
        // new file; path comes from +++ line
      } else {
        current.oldPath = stripPrefix(line.slice(4));
        // For deleted files +++ is /dev/null, so capture the path here as a
        // fallback; +++ will override it for added/modified files.
        if (!current.path) current.path = current.oldPath;
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') {
        current.status = 'deleted';
      } else {
        current.path = stripPrefix(line.slice(4));
      }
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1]);
      const oldCount = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3]);
      const newCount = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      current.hunks.push({
        oldStart,
        oldEnd: oldStart + Math.max(oldCount - 1, 0),
        newStart,
        newEnd: newStart + Math.max(newCount - 1, 0),
      });
      inHunk = true;
      continue;
    }

    if (inHunk && current) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.additions += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.deletions += 1;
      }
    }
  }

  if (current && current.path) files.push(current);

  return files;
}

function stripPrefix(value: string): string {
  if (value.startsWith('b/')) return value.slice(2);
  if (value.startsWith('a/')) return value.slice(2);
  return value;
}

/**
 * Find the hunk whose new-file range contains `line`, or the nearest hunk if
 * `line` falls in a gap. Returns `null` when the file has no hunks (e.g.
 * deleted or binary). Used by the trusted adapter to clamp inline comments to
 * valid diff lines.
 */
export function hunkForLine(
  file: FileDiff,
  line: number,
): DiffHunk | null {
  if (file.hunks.length === 0) return null;

  let best: DiffHunk | null = null;
  let bestDistance = Infinity;

  for (const hunk of file.hunks) {
    if (line >= hunk.newStart && line <= hunk.newEnd) {
      return hunk;
    }
    const distance =
      line < hunk.newStart ? hunk.newStart - line : line - hunk.newEnd;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = hunk;
    }
  }

  return best;
}

/** Look up a file's diff by path. */
export function findFileDiff(files: FileDiff[], path: string): FileDiff | undefined {
  return files.find((f) => f.path === path);
}

/**
 * Truncate a diff string to at most `maxLines` lines, appending a truncation
 * marker when content is dropped. Keeps the output bounded for the model.
 */
export function truncateDiff(diff: string, maxLines: number): { content: string; truncated: boolean; totalLines: number } {
  const lines = diff.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { content: diff, truncated: false, totalLines: lines.length };
  }
  const kept = lines.slice(0, maxLines).join('\n');
  return {
    content: `${kept}\n\n... (diff truncated: ${lines.length - maxLines} lines omitted)`,
    truncated: true,
    totalLines: lines.length,
  };
}
