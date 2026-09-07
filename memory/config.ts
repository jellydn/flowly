import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GitHubClient } from '../github/client.ts';
import { parseRepositoryLearningPolicy } from './schema.ts';
import { RepositoryLearningService } from './service.ts';
import {
  createGitHubRepositoryMemoryStore,
  FileRepositoryMemoryStore,
  type RepositoryMemoryStore,
} from './store.ts';

export function createRepositoryLearningFromEnv(
  env: Record<string, string | undefined>,
  client: GitHubClient,
  repositoryPath: string,
): RepositoryLearningService | undefined {
  const policyPath = env.FLOWLY_LEARNING_POLICY;
  if (!policyPath) return undefined;
  const policy = parseRepositoryLearningPolicy(
    JSON.parse(readFileSync(resolveRepositoryFile(repositoryPath, policyPath), 'utf8')) as unknown,
  );
  const store = createStore(env, client, repositoryPath);
  return new RepositoryLearningService(`${client.owner}/${client.repo}`, policy, store);
}

function createStore(
  env: Record<string, string | undefined>,
  client: GitHubClient,
  repositoryPath: string,
): RepositoryMemoryStore {
  if (env.FLOWLY_MEMORY_STORE) {
    return new FileRepositoryMemoryStore(
      resolveRepositoryFile(repositoryPath, env.FLOWLY_MEMORY_STORE),
    );
  }
  const issueNumber = Number(env.FLOWLY_MEMORY_ISSUE);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      'FLOWLY_MEMORY_ISSUE must be a positive integer when repository learning is configured without FLOWLY_MEMORY_STORE.',
    );
  }
  return createGitHubRepositoryMemoryStore(
    client,
    issueNumber,
    env.REVIEW_BOT_LOGIN ?? 'github-actions[bot]',
  );
}

function resolveRepositoryFile(repositoryPath: string, relativePath: string): string {
  const root = path.resolve(repositoryPath);
  const resolved = path.resolve(root, relativePath);
  if (
    path.isAbsolute(relativePath) ||
    (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(`Repository learning path escapes the repository: ${relativePath}`);
  }
  return resolved;
}
