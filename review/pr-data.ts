/**
 * PR data source — the trusted read boundary for pull-request metadata, the
 * unified diff, changed-file lists, diff hunks, and changed-file contents.
 *
 * The agent's review tools call this interface; they never invoke `git` or
 * the GitHub API directly from the sandbox. A real {@link createGitDataSource}
 * runs `git diff` via `child_process` and reads the PR title/body from
 * {@link GitHubClient}. Tests inject an in-memory fake.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitHubClient } from '../github/client.ts';
import type { ReviewStateStore } from './review-state-store.ts';
import {
  type DiffHunk,
  type FileDiff,
  findFileDiff,
  parseUnifiedDiff,
  truncateDiff,
} from './diff.ts';
import { classifyFile, type SkipReason } from './filters.ts';
import type { ReviewState } from './review-state.ts';

const execFileAsync = promisify(execFile);

export type ChangedFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  skip: boolean;
  skipReason?: SkipReason;
};

export type PrMetadata = {
  number: number;
  title: string;
  body: string;
  author: string;
  baseSha: string;
  headSha: string;
  changedFiles: ChangedFile[];
};

export type ReadChangedFileResult = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
};

export type GetDiffResult = {
  content: string;
  truncated: boolean;
  totalLines: number;
};

export type IncrementalDiffResult = {
  isFirstReview: boolean;
  previousReviewedSha: string | null;
  content: string;
  truncated: boolean;
  totalLines: number;
};

export interface PrDataSource {
  getMetadata(): Promise<PrMetadata>;
  getDiff(maxLines: number): Promise<GetDiffResult>;
  listChangedFiles(): Promise<ChangedFile[]>;
  getDiffHunks(filePath: string): Promise<DiffHunk[]>;
  readChangedFile(
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<ReadChangedFileResult>;
  /** Load the previous review state from the hidden PR comment, or null. */
  getReviewState(): Promise<ReviewState | null>;
  /** Return the incremental diff since the last reviewed SHA. */
  getIncrementalDiff(maxLines: number): Promise<IncrementalDiffResult>;
}

export type GitDataSourceOptions = {
  /** Absolute path to the checked-out repository root. */
  repositoryPath: string;
  baseSha: string;
  headSha: string;
  prNumber: number;
  github: GitHubClient;
  /** Store for persistent review state (hidden PR comment). */
  stateStore?: ReviewStateStore;
  /** Override the git binary path (tests). */
  gitBin?: string;
  /** Inject git execution (tests). */
  execGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
};

const MAX_RETURNED_LINES = 400;

/**
 * Real data source backed by `git diff` and the GitHub REST API. The diff and
 * parsed file list are fetched once and cached for the lifetime of the agent
 * run.
 */
export function createGitDataSource(options: GitDataSourceOptions): PrDataSource {
  const root = path.resolve(options.repositoryPath);
  const execGit =
    options.execGit ??
    (async (args: string[], cwd: string) =>
      execFileAsync(options.gitBin ?? 'git', args, {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
      }));

  let cachedDiff: string | null = null;
  let cachedFiles: FileDiff[] | null = null;
  let cachedMetadata: PrMetadata | null = null;
  let cachedReviewState: ReviewState | null | undefined = undefined;

  async function fetchDiff(): Promise<string> {
    if (cachedDiff !== null) return cachedDiff;
    const { stdout } = await execGit(
      ['diff', '--no-color', options.baseSha, options.headSha],
      root,
    );
    cachedDiff = stdout;
    cachedFiles = parseUnifiedDiff(stdout);
    return stdout;
  }

  async function fetchFiles(): Promise<FileDiff[]> {
    if (cachedFiles !== null) return cachedFiles;
    await fetchDiff();
    return cachedFiles!;
  }

  function toChangedFiles(files: FileDiff[]): ChangedFile[] {
    return files.map((f) => {
      const classification = classifyFile(f.path);
      return {
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        skip: classification.skip,
        skipReason: classification.reason,
      };
    });
  }

  return {
    async getMetadata(): Promise<PrMetadata> {
      if (cachedMetadata) return cachedMetadata;
      const pr = await options.github.getPr(options.prNumber);
      const files = await fetchFiles();
      cachedMetadata = {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        // Report the SHAs actually under review (from the CI env / options),
        // not the GitHub API's — on a `synchronize` race the API head/base can
        // diverge from the diff we parsed, which would mislead the model.
        baseSha: options.baseSha,
        headSha: options.headSha,
        changedFiles: toChangedFiles(files),
      };
      return cachedMetadata;
    },

    async getDiff(maxLines: number): Promise<GetDiffResult> {
      const diff = await fetchDiff();
      return truncateDiff(diff, maxLines);
    },

    async listChangedFiles(): Promise<ChangedFile[]> {
      const files = await fetchFiles();
      return toChangedFiles(files);
    },

    async getDiffHunks(filePath: string): Promise<DiffHunk[]> {
      const files = await fetchFiles();
      const file = findFileDiff(files, filePath);
      return file?.hunks ?? [];
    },

    async readChangedFile(
      filePath: string,
      startLine = 1,
      endLine?: number,
    ): Promise<ReadChangedFileResult> {
      const absolute = path.resolve(root, filePath);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        throw new Error('Path escapes the repository root.');
      }
      // Confine reads to the PR's changed files. Without this the tool is a
      // superset of read_file (the working tree equals head in CI) and would
      // let the model bypass the context-read budget that bounds read_file /
      // search_code.
      const files = await fetchFiles();
      if (!findFileDiff(files, filePath)) {
        throw new Error(`"${filePath}" is not among the PR's changed files.`);
      }
      // Read the post-PR version from the checked-out working tree (head).
      const { stdout } = await execGit(['show', `${options.headSha}:${filePath}`], root);
      const lines = stdout.split(/\r?\n/);
      const requestedEnd = endLine ?? startLine + MAX_RETURNED_LINES - 1;
      const clampedEnd = Math.min(requestedEnd, startLine + MAX_RETURNED_LINES - 1, lines.length);
      const content = lines
        .slice(startLine - 1, clampedEnd)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n');
      return {
        path: filePath,
        startLine,
        endLine: clampedEnd,
        totalLines: lines.length,
        content,
        // Truncated only when the requested range was cut short (by the
        // per-call line cap or EOF) — not merely because the file has more
        // lines beyond an explicitly-requested range.
        truncated: requestedEnd > clampedEnd,
      };
    },

    async getReviewState(): Promise<ReviewState | null> {
      if (cachedReviewState !== undefined) return cachedReviewState;
      if (!options.stateStore) {
        cachedReviewState = null;
        return null;
      }
      cachedReviewState = await options.stateStore.load();
      return cachedReviewState;
    },

    async getIncrementalDiff(maxLines: number): Promise<IncrementalDiffResult> {
      const state = await this.getReviewState();
      if (!state) {
        return {
          isFirstReview: true,
          previousReviewedSha: null,
          content: '',
          truncated: false,
          totalLines: 0,
        };
      }
      // Use the three-dot notation: diff from the merge base of the two SHAs
      // to the new head. When the previous SHA is an ancestor of the head
      // (normal case — commits were added), this equals the direct diff.
      const { stdout } = await execGit(
        ['diff', '--no-color', `${state.reviewedHeadSha}...${options.headSha}`],
        root,
      );
      const truncated = truncateDiff(stdout, maxLines);
      return {
        isFirstReview: false,
        previousReviewedSha: state.reviewedHeadSha,
        content: truncated.content,
        truncated: truncated.truncated,
        totalLines: truncated.totalLines,
      };
    },
  };
}
