#!/usr/bin/env node
/**
 * Flue PR Review entrypoint.
 *
 * Validates the GitHub Actions environment, then invokes the Flue PR Review
 * agent. The agent's tools fetch PR metadata and the diff, inspect context,
 * and submit the review through the trusted publisher. This script only
 * orchestrates — it holds no review logic.
 *
 * Required environment:
 *   GITHUB_TOKEN       – repository-scoped token (secrets.GITHUB_TOKEN)
 *   GITHUB_REPOSITORY  – owner/repo (set automatically by GitHub Actions)
 *   PR_NUMBER          – pull-request number
 *   BASE_SHA           – base commit SHA
 *   HEAD_SHA           – head commit SHA
 *   OPENROUTER_API_KEY – LLM provider key (or another provider's key)
 *
 * Optional:
 *   REPOSITORY_PATH    – checkout root (defaults to the current directory)
 *   REPO_ASSISTANT_MODEL – model specifier (defaults to openrouter/cohere/north-mini-code:free)
 *   PR_REVIEW_MAX_*    – file-aware limits (see review/limits.ts)
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const REQUIRED_ENV = [
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'PR_NUMBER',
  'BASE_SHA',
  'HEAD_SHA',
] as const;

function fail(message: string): never {
  console.error(`[flue-review] ${message}`);
  process.exit(1);
}

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    fail(`Missing required environment variable: ${name}`);
  }
}

const prNumber = Number(process.env.PR_NUMBER);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  fail(`PR_NUMBER must be a positive integer (got "${process.env.PR_NUMBER}").`);
}

if (!process.env.GITHUB_REPOSITORY?.includes('/')) {
  fail('GITHUB_REPOSITORY must be in "owner/repo" format.');
}

const prompt = [
  `Review pull request #${prNumber}.`,
  '',
  'Follow the review workflow: load the PR metadata and diff, inspect',
  'surrounding context for each non-trivial changed file, then call',
  'submit_review with your structured findings. Ground every finding in',
  'code you read this run. Never auto-approve.',
].join('\n');

const args = ['run', 'agents/pr-reviewer.ts', '-m', prompt];
console.error(`[flue-review] Invoking: npx flue ${args.slice(0, 3).join(' ')} ...`);

const child = spawn('npx', ['flue', ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  fail(`Failed to launch flue: ${err.message}`);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
