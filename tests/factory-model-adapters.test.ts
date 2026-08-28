import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { ModelCallFn } from '../eval/bench/providers.ts';
import {
  createModelFactoryClassifier,
  createModelFactoryPlanner,
  createModelFactoryReview,
} from '../factory/model-adapters.ts';
import type { IsolatedFactoryReviewEvidence } from '../factory/review.ts';
import { RepositoryReader } from '../tools/repository.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('factory model adapters', () => {
  test('classifies actionable work through the validated model boundary', async () => {
    const classifier = createModelFactoryClassifier(
      replies({
        actionable: true,
        type: 'feature',
        priority: 'high',
        complexity: 'medium',
        missingInformation: [],
      }),
    );

    const result = await classifier.classify({
      issueNumber: 94,
      title: 'Factory agents',
      body: 'Replace placeholders.',
      repository: 'jellydn/flowly',
    });

    assert.equal(result.actionable, true);
    assert.equal(result.type, 'feature');
  });

  test('plans from selected repository files and native commands', async () => {
    const root = await fixtureRepository();
    const prompts: string[] = [];
    const outputs = [
      { relevantFiles: ['src/factory.ts', '../escape'] },
      {
        summary: 'Implement the factory adapter.',
        steps: ['Update src/factory.ts'],
        acceptanceCriteria: [{ description: 'The factory writes a real change.' }],
        verificationCommands: ['npm test'],
        relevantFiles: ['src/factory.ts'],
        risks: [],
      },
    ];
    const planner = createModelFactoryPlanner(async (prompt) => {
      prompts.push(prompt);
      return { content: JSON.stringify(outputs.shift()) };
    }, new RepositoryReader(root));

    const result = await planner.plan({
      task: {
        issueNumber: 94,
        title: 'Factory agents',
        body: 'Replace placeholders.',
        repository: 'jellydn/flowly',
      },
      classification: {
        actionable: true,
        type: 'feature',
        priority: 'high',
        complexity: 'medium',
        missingInformation: [],
      },
    });

    assert.deepEqual(result.relevantFiles, ['src/factory.ts']);
    assert.match(prompts[1], /const factory = true/);
    assert.doesNotMatch(prompts[1], /escape/);
    assert.match(prompts[1], /"test":"node --test"/);
  });

  test('maps independent model judgments to the exact review evidence object', async () => {
    const review = createModelFactoryReview(
      replies({
        summary: 'The criterion is satisfied by the diff.',
        verdict: 'COMMENT',
        findings: [],
        acceptanceCriteria: [
          {
            description: 'A real change exists.',
            satisfied: true,
            evidence: 'src/factory.ts is added in the diff.',
          },
        ],
      }),
    );
    const evidence = reviewEvidence();

    const output = await review.reviewer.review(evidence);

    assert.equal(output.verdict, 'COMMENT');
    assert.deepEqual(review.judgmentsFrom(evidence, output), [
      {
        description: 'A real change exists.',
        satisfied: true,
        evidence: 'src/factory.ts is added in the diff.',
      },
    ]);
  });
});

function replies(value: unknown): ModelCallFn {
  return async () => ({ content: JSON.stringify(value) });
}

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowly-factory-model-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/factory.ts'), 'export const factory = true;\n');
  await writeFile(path.join(root, 'AGENTS.md'), '# Test repository\n');
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  return root;
}

function reviewEvidence(): IsolatedFactoryReviewEvidence {
  return {
    issueNumber: 94,
    title: 'Factory agents',
    body: 'Replace placeholders.',
    repository: 'jellydn/flowly',
    branch: 'factory/94-factory-agents',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    changedFiles: ['src/factory.ts'],
    diff: '+export const factory = true;',
    planSummary: 'Implement the factory adapter.',
    acceptanceCriteria: [{ description: 'A real change exists.' }],
    verification: [{ command: 'npm test', exitCode: 0 }],
  };
}
