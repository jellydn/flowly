import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IssueComment, IssueCommentResult } from '../github/client.ts';
import { parseRepositoryMemoryState } from './schema.ts';
import type { RepositoryMemoryState } from './types.ts';

export type RepositoryMemoryStore = {
  load(): Promise<RepositoryMemoryState | null>;
  save(state: RepositoryMemoryState): Promise<void>;
};

export class MemoryRepositoryMemoryStore implements RepositoryMemoryStore {
  constructor(private state: RepositoryMemoryState | null = null) {}

  async load(): Promise<RepositoryMemoryState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: RepositoryMemoryState): Promise<void> {
    this.state = structuredClone(parseRepositoryMemoryState(state));
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
    const parsed = parseRepositoryMemoryState(state);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
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
  listIssueComments(issueNumber: number): Promise<IssueComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<IssueCommentResult>;
  updateIssueComment(commentId: number, body: string): Promise<IssueCommentResult>;
};

export function createGitHubRepositoryMemoryStore(
  client: RepositoryMemoryCommentClient,
  issueNumber: number,
  expectedBotLogin = 'github-actions[bot]',
): RepositoryMemoryStore {
  const repositoryId = `${client.owner}/${client.repo}`;
  let commentId: number | null = null;

  async function find(): Promise<RepositoryMemoryState | null> {
    const comments = await client.listIssueComments(issueNumber);
    for (const comment of comments) {
      if (comment.user?.login !== expectedBotLogin) continue;
      const state = parseComment(comment.body);
      if (state?.repositoryId !== repositoryId) continue;
      commentId = comment.id;
      return state;
    }
    commentId = null;
    return null;
  }

  return {
    load: find,
    async save(state) {
      const parsed = parseRepositoryMemoryState(state);
      if (parsed.repositoryId !== repositoryId) {
        throw new Error(`Repository memory targets ${parsed.repositoryId}, not ${repositoryId}.`);
      }
      await find();
      const body = encodeComment(parsed);
      if (Buffer.byteLength(body, 'utf8') > MAX_GITHUB_COMMENT_BYTES) {
        throw new Error('Repository memory exceeds the bounded GitHub comment size.');
      }
      if (commentId === null) {
        commentId = (await client.createIssueComment(issueNumber, body)).id;
      } else {
        await client.updateIssueComment(commentId, body);
      }
    },
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
