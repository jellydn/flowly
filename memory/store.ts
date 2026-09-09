import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IssueComment, IssueCommentResult } from '../github/client.ts';
import { parseRepositoryMemoryState } from './schema.ts';
import type { RepositoryMemoryState } from './types.ts';

export type RepositoryMemoryUpdater = (
  state: RepositoryMemoryState | null,
) => RepositoryMemoryState | Promise<RepositoryMemoryState>;

export type RepositoryMemoryStore = {
  load(): Promise<RepositoryMemoryState | null>;
  save(state: RepositoryMemoryState): Promise<void>;
  update(updater: RepositoryMemoryUpdater): Promise<RepositoryMemoryState>;
};

export class MemoryRepositoryMemoryStore implements RepositoryMemoryStore {
  constructor(private state: RepositoryMemoryState | null = null) {}

  async load(): Promise<RepositoryMemoryState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: RepositoryMemoryState): Promise<void> {
    this.state = structuredClone(parseRepositoryMemoryState(state));
  }

  async update(updater: RepositoryMemoryUpdater): Promise<RepositoryMemoryState> {
    const next = await updater(await this.load());
    await this.save(next);
    return next;
  }
}

export class FileRepositoryMemoryStore implements RepositoryMemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RepositoryMemoryState | null> {
    try {
      return parseRepositoryMemoryState(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(state: RepositoryMemoryState): Promise<void> {
    await withFileLock(this.filePath, async () => this.writeUnlocked(state));
  }

  async update(updater: RepositoryMemoryUpdater): Promise<RepositoryMemoryState> {
    return withFileLock(this.filePath, async () => {
      const next = await updater(await this.load());
      await this.writeUnlocked(next);
      return next;
    });
  }

  private async writeUnlocked(state: RepositoryMemoryState): Promise<void> {
    const parsed = parseRepositoryMemoryState(state);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`);
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

const MEMORY_MARKER = 'flue-repository-memory';
const MAX_GITHUB_COMMENT_BYTES = 60_000;

export type RepositoryMemoryCommentClient = {
  owner: string;
  repo: string;
  listIssueComments(issueNumber: number, options?: { maxPages?: number }): Promise<IssueComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<IssueCommentResult>;
  updateIssueComment(
    commentId: number,
    body: string,
    expectedUpdatedAt?: string,
  ): Promise<IssueCommentResult>;
};

export function createGitHubRepositoryMemoryStore(
  client: RepositoryMemoryCommentClient,
  issueNumber: number,
  expectedBotLogin = 'github-actions[bot]',
): RepositoryMemoryStore {
  const repositoryId = `${client.owner}/${client.repo}`;
  let pending = Promise.resolve();

  async function find(): Promise<{ comment: IssueComment; state: RepositoryMemoryState } | null> {
    const comments = await client.listIssueComments(issueNumber, {
      maxPages: Number.POSITIVE_INFINITY,
    });
    for (const comment of comments) {
      if (comment.user?.login !== expectedBotLogin) continue;
      const state = parseComment(comment.body);
      if (state?.repositoryId !== repositoryId) continue;
      return { comment, state };
    }
    return null;
  }

  async function write(state: RepositoryMemoryState, current: IssueComment | null): Promise<void> {
    if (state.repositoryId !== repositoryId) {
      throw new Error(`Repository memory targets ${state.repositoryId}, not ${repositoryId}.`);
    }
    const parsed = parseRepositoryMemoryState(state);
    const body = encodeComment(parsed);
    if (Buffer.byteLength(body, 'utf8') > MAX_GITHUB_COMMENT_BYTES) {
      throw new Error('Repository memory exceeds the bounded GitHub comment size.');
    }
    if (current === null) {
      await client.createIssueComment(issueNumber, body);
    } else {
      await client.updateIssueComment(current.id, body, current.updated_at || undefined);
    }
  }

  async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function update(updater: RepositoryMemoryUpdater): Promise<RepositoryMemoryState> {
    return enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await find();
        const next = await updater(current?.state ?? null);
        try {
          await write(next, current?.comment ?? null);
          return next;
        } catch (error) {
          if (!isConflict(error) || attempt === 2) throw error;
        }
      }
      throw new Error('Repository memory update conflict retry limit exceeded.');
    });
  }

  return {
    async load() {
      return (await find())?.state ?? null;
    },
    async save(state) {
      await update(() => state);
    },
    update,
  };
}

function encodeComment(state: RepositoryMemoryState): string {
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  return `<!-- ${MEMORY_MARKER}\n${encoded}\n-->\n\n_Flowly repository memory (automated; do not edit)._`;
}

function parseComment(body: string): RepositoryMemoryState | null {
  const prefix = `<!-- ${MEMORY_MARKER}\n`;
  if (!body.startsWith(prefix)) return null;
  const end = body.indexOf('\n-->');
  if (end < 0) return null;
  try {
    const decoded = Buffer.from(body.slice(prefix.length, end), 'base64').toString('utf8');
    return parseRepositoryMemoryState(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error.status === 409 || error.status === 412),
  );
}

async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAge > 30_000) await rm(lockPath, { recursive: true, force: true });
      } catch (statError) {
        if (!isNotFound(statError)) throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (attempt === 1_199) throw new Error('Repository memory lock timeout.');
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
