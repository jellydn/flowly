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
 *   FACTORY_WORKSPACE_STORE – optional JSON directory for workspace lifecycle records
 *   FACTORY_RUN_STORE      – local JSON directory (dev only; Actions uses an issue comment)
 *   REVIEW_BOT_LOGIN       – expected author of the factory-run comment (default github-actions[bot])
 *   FACTORY_AUTONOMY_POLICY – path to a repository autonomy-policy JSON file
 *   FACTORY_CAPABILITY_POLICY – optional restrict-only capability overlay JSON file
 *   FACTORY_CONFIRM_BOUNDARY – one-run confirmation: implementation or publication
 *   FLOWLY_LEARNING_POLICY – repository-relative learning-policy JSON file
 *   FLOWLY_MEMORY_ISSUE    – issue that holds the bot-authored memory snapshot
 *   FLOWLY_MEMORY_STORE    – local JSON memory file (development only)
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createAgentFactoryImplementer } from '../factory/agent-implementer.ts';
import { createIssueCommentProgress } from '../factory/defaults.ts';
import { dispatchFactoryLabeledIssue, factoryTaskFromIssuesEvent } from '../factory/dispatch.ts';
import { FactoryGitAdapter } from '../factory/git.ts';
import { StoredFactoryEventLog, workspaceEventsToLog } from '../factory/events.ts';
import { FactoryWorkspaceManager } from '../factory/workspace-lifecycle.ts';
import { FileFactoryWorkspaceStore } from '../factory/workspace-store.ts';
import {
  createModelFactoryClassifier,
  createModelFactoryPlanner,
  createModelFactoryReview,
} from '../factory/model-adapters.ts';
import { createFactoryModelCall } from '../factory/model.ts';
import { FactoryOrchestrator } from '../factory/orchestrator.ts';
import {
  FactoryDraftPrPublisher,
  createGitHubFactoryPullRequestClient,
} from '../factory/publisher.ts';
import { createGitHubFactoryRunStore } from '../factory/run-state-store.ts';
import { FileFactoryRunStore, type FactoryRunStore } from '../factory/store.ts';
import { FactoryVerificationRunner } from '../factory/verification.ts';
import { GitHubClient } from '../github/client.ts';
import { createRepositoryReader } from '../tools/repository.ts';
import { parseFactoryAutonomyPolicy } from '../factory/autonomy.ts';
import { parseFactoryCapabilityPolicy } from '../factory/capabilities.ts';
import type { FactoryManualConfirmation } from '../factory/types.ts';
import { createRepositoryLearningFromEnv } from '../memory/config.ts';

function fail(message: string): never {
  console.error(`[flowly-factory] ${message}`);
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
    process.env.FACTORY_WORKSPACE_ROOT ??
    path.join(os.tmpdir(), 'flowly-factory', process.env.GITHUB_REPOSITORY!.replace('/', '-'));
  const model =
    process.env.FACTORY_MODEL ??
    process.env.REPO_ASSISTANT_MODEL ??
    'openrouter/cohere/north-mini-code:free';
  const modelCall = createFactoryModelCall(model, process.env);
  const repository = await createRepositoryReader(repositoryPath);
  const review = createModelFactoryReview(modelCall);
  const task = factoryTaskFromIssuesEvent(eventName, payload);
  const store = createFactoryRunStore(client, task.issueNumber);
  const events = new StoredFactoryEventLog(store, task.repository);
  const gitAdapter = new FactoryGitAdapter({
    sourceRepository: repositoryPath,
    workspaceRoot,
  });
  const git = new FactoryWorkspaceManager({
    git: gitAdapter,
    store: new FileFactoryWorkspaceStore(
      process.env.FACTORY_WORKSPACE_STORE ?? path.join(workspaceRoot, '.lifecycle'),
    ),
    workspaceRoot,
    repositoryId: process.env.GITHUB_REPOSITORY!,
    events: workspaceEventsToLog(events),
  });
  await git.collectGarbage();
  const autonomyPolicy = process.env.FACTORY_AUTONOMY_POLICY
    ? parseFactoryAutonomyPolicy(
        JSON.parse(await readFile(process.env.FACTORY_AUTONOMY_POLICY, 'utf8')) as unknown,
      )
    : undefined;
  const capabilityPolicy = process.env.FACTORY_CAPABILITY_POLICY
    ? parseFactoryCapabilityPolicy(
        JSON.parse(await readFile(process.env.FACTORY_CAPABILITY_POLICY, 'utf8')) as unknown,
      )
    : undefined;
  const manualConfirmation = parseManualConfirmation(process.env.FACTORY_CONFIRM_BOUNDARY);
  const learning = createRepositoryLearningFromEnv(process.env, client, repositoryPath);

  const run = await dispatchFactoryLabeledIssue(eventName, payload, {
    orchestrator: new FactoryOrchestrator(store),
    classifier: createModelFactoryClassifier(modelCall),
    planner: createModelFactoryPlanner(modelCall, repository),
    progress: createIssueCommentProgress(client),
    git,
    implementer: createAgentFactoryImplementer(model),
    verifier: new FactoryVerificationRunner(),
    reviewer: review.reviewer,
    publisher: new FactoryDraftPrPublisher(createGitHubFactoryPullRequestClient(client)),
    readDiff: async (current) => {
      if (!current.branch || !current.implementation) {
        throw new Error(`Factory run ${current.id} has no branch or implementation to diff.`);
      }
      return gitAdapter.readDiff({
        id: current.implementation.workspaceId,
        path: path.join(workspaceRoot, current.implementation.workspaceId),
        branch: current.branch,
        baseRef: 'origin/main',
      });
    },
    judgmentsFrom: review.judgmentsFrom,
    autonomyPolicy,
    capabilityPolicy,
    manualConfirmation,
    learning,
  });

  console.error(`[flowly-factory] run ${run.id} ended in state ${run.state}`);
  if (run.state === 'failed' || run.state === 'needs-input') {
    process.exitCode = 1;
  }
}

function parseManualConfirmation(value: string | undefined): FactoryManualConfirmation | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'implementation' || value === 'publication') return value;
  throw new Error('FACTORY_CONFIRM_BOUNDARY must be implementation or publication.');
}

function createFactoryRunStore(client: GitHubClient, issueNumber: number): FactoryRunStore {
  if (process.env.FACTORY_RUN_STORE) {
    return new FileFactoryRunStore(process.env.FACTORY_RUN_STORE);
  }
  return createGitHubFactoryRunStore(
    client,
    issueNumber,
    process.env.REVIEW_BOT_LOGIN ?? 'github-actions[bot]',
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
