/**
 * Review-specific tool factories for the PR reviewer agent. Each tool is a
 * thin, trusted wrapper over a {@link PrDataSource} or {@link ReviewPublisher}.
 *
 * The agent calls these tools; the tools perform the git/GitHub work in trusted
 * code. The model never receives a generic shell, the GitHub token, or
 * unrestricted filesystem access — only the validated, bounded outputs these
 * tools return.
 */

import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { ReviewPublisher } from '../github/adapter.ts';
import type { ReviewLimits } from './limits.ts';
import { reviewResultSchema, type ReviewResult } from './schema.ts';
import type {
  ChangedFile,
  GetDiffResult,
  PrDataSource,
  PrMetadata,
  ReadChangedFileResult,
} from './pr-data.ts';
import type { DiffHunk } from './diff.ts';

const MAX_PATH_LENGTH = 500;

export function createGetPrMetadataTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'get_pr_metadata',
    description:
      'Load pull-request metadata: number, title, body, author, base/head SHAs, and the changed-file list (with skip flags for lockfiles, generated, vendored, and binary files). Call this first to understand the PR scope.',
    input: v.object({}),
    async run() {
      const metadata: PrMetadata = await dataSource.getMetadata();
      return { output: metadata };
    },
  });
}

export function createGetPrDiffTool(
  dataSource: PrDataSource,
  limits: ReviewLimits,
) {
  return defineTool({
    name: 'get_pr_diff',
    description: `Return the unified diff for the whole PR, truncated to at most ${limits.maxDiffLines} lines. Use this to see exactly what changed. Skip-reviewed files (lockfiles, generated, snapshots, vendored) are still present in the diff but should not be analyzed.`,
    input: v.object({}),
    async run() {
      const diff: GetDiffResult = await dataSource.getDiff(limits.maxDiffLines);
      return { output: diff };
    },
  });
}

export function createListChangedFilesTool(
  dataSource: PrDataSource,
  limits: ReviewLimits,
) {
  return defineTool({
    name: 'list_changed_files',
    description: `List the files changed in this PR with per-file additions, deletions, status, and a skip flag. Capped at ${limits.maxFiles} files; the rest are summarized. Use this to pick which files to inspect closely.`,
    input: v.object({}),
    async run() {
      const all = await dataSource.listChangedFiles();
      const reviewed = all.slice(0, limits.maxFiles);
      const skippedCount = all.filter((f) => f.skip).length;
      return {
        output: {
          files: reviewed,
          totalFiles: all.length,
          truncated: all.length > limits.maxFiles,
          skippedByFilter: skippedCount,
        },
      };
    },
  });
}

export function createReadChangedFileTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'read_changed_file',
    description:
      'Read a bounded line range (≤400 lines) from the post-PR version of a changed file. Use after list_changed_files to inspect surrounding context for a finding. Returns numbered lines and the total line count.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
      endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    async run({ data }) {
      if (data.endLine !== undefined && data.endLine < data.startLine) {
        throw new Error('endLine must be greater than or equal to startLine.');
      }
      const result: ReadChangedFileResult = await dataSource.readChangedFile(
        data.path,
        data.startLine,
        data.endLine,
      );
      return { output: result };
    },
  });
}

export function createGetDiffHunksTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'get_diff_hunks',
    description:
      'Return the diff hunk line ranges (new-file side) for one changed file. Use to confirm which line numbers are valid for inline findings before calling submit_review.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH)),
    }),
    async run({ data }) {
      const hunks: DiffHunk[] = await dataSource.getDiffHunks(data.path);
      return { output: { path: data.path, hunks } };
    },
  });
}

export function createSubmitReviewTool(
  publisher: ReviewPublisher,
) {
  return defineTool({
    name: 'submit_review',
    description:
      'Submit the final PR review. Accepts a structured ReviewResult (summary, verdict, findings). The trusted publisher validates paths/lines against the PR diff and posts one GitHub review with inline comments. Verdict is COMMENT or REQUEST_CHANGES — never APPROVE. Call this exactly once when the review is complete. When there are no blocking issues, use verdict COMMENT with an empty findings array.',
    input: reviewResultSchema,
    async run({ data }) {
      const result: ReviewResult = data;
      const published = await publisher.publish(result);
      return {
        output: {
          ...published,
          message: `Review posted (${published.submittedFindings} inline finding(s), ${published.skippedFindings} skipped). ${published.htmlUrl}`,
        },
        terminate: true,
      };
    },
  });
}
