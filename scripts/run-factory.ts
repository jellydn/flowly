#!/usr/bin/env node
/**
 * Factory pipeline entrypoint for GitHub Actions.
 *
 * Parses an `issues.labeled` payload and runs Classifier → Analyst →
 * Implementer → Reviewer → draft PR through trusted adapters. The script
 * never merges or approves.
 *
 * Required environment:
 *   GITHUB_TOKEN       – repository-scoped token
 *   GITHUB_REPOSITORY  – owner/repo
 *   GITHUB_EVENT_NAME  – must be "issues"
 *   GITHUB_EVENT_PATH  – path to the event payload JSON
 * Optional:
 *   REPOSITORY_PATH    – checkout root (defaults to cwd)
 *   FACTORY_WORKSPACE_ROOT – isolated clone root (defaults to <cwd>/.factory-workspaces)
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  createDeterministicFactoryClassifier,
  createDeterministicFactoryPlanner,
  createDeterministicFactoryReviewer,
  createIssueCommentProgress,
  createNoopFactoryImplementer,
} from '../factory/defaults.ts';
import { dispatchFactoryLabeledIssue } from '../factory/dispatch.ts';
import { FactoryGitAdapter } from '../factory/git.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import {
  FactoryDraftPrPublisher,
  createGitHubFactoryPullRequestClient,
} from '../factory/publisher.ts';
import { MemoryFactoryRunStore } from '../factory/store.ts';
import { FactoryVerificationRunner } from '../factory/verification.ts';
import { GitHubClient } from '../github/client.ts';

function fail(message: string): never {
  console.error(`[flue-factory] ${message}`);
  process.exit(1);
}

const REQUIRED_ENV = [
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
] as const;

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) fail(`Missing required environment variable: ${name}`);
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME!;
  const eventPath = process.env.GITHUB_EVENT_PATH!;
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(eventPath, 'utf8')) as unknown;
  } catch (error) {
    fail(
      `Cannot read event payload at "${eventPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const client = GitHubClient.fromEnv(process.env);
  const repositoryPath = process.env.REPOSITORY_PATH ?? process.cwd();
  const workspaceRoot =
    process.env.FACTORY_WORKSPACE_ROOT ?? path.join(repositoryPath, '.factory-workspaces');
  const git = new FactoryGitAdapter({
    sourceRepository: repositoryPath,
    workspaceRoot,
  });
  const store = new MemoryFactoryRunStore();

  const run = await dispatchFactoryLabeledIssue(eventName, payload, {
    orchestrator: new FactoryOrchestrator(store),
    classifier: createDeterministicFactoryClassifier(),
    planner: createDeterministicFactoryPlanner(),
    progress: createIssueCommentProgress(client),
    git,
    implementer: createNoopFactoryImplementer(),
    verifier: new FactoryVerificationRunner(),
    reviewer: createDeterministicFactoryReviewer(),
    publisher: new FactoryDraftPrPublisher(createGitHubFactoryPullRequestClient(client)),
    readDiff: async (current) => {
      if (!current.branch || !current.implementation) {
        throw new Error(`Factory run ${current.id} has no branch or implementation to diff.`);
      }
      return git.readDiff({
        id: current.implementation.workspaceId,
        path: path.join(workspaceRoot, current.implementation.workspaceId),
        branch: current.branch,
        baseRef: 'origin/main',
      });
    },
    judgmentsFrom: (evidence) =>
      evidence.acceptanceCriteria.map((criterion) => ({
        description: criterion.description,
        satisfied: evidence.diff.trim().length > 0,
        evidence:
          evidence.diff.trim().length > 0
            ? 'The factory-branch diff is available for human review.'
            : 'The isolated workspace produced no diff.',
      })),
  });

  console.error(`[flue-factory] run ${run.id} ended in state ${run.state}`);
  if (run.state === 'failed' || run.state === 'needs-input') {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
