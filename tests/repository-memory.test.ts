import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  formatRepositoryInstinctContext,
  learnRepositoryInstincts,
  selectRepositoryInstincts,
  setRepositoryInstinctStatus,
  supersedeRepositoryInstinct,
} from '../memory/engine.ts';
import { extractFactoryLearningObservations } from '../memory/extractors.ts';
import { parseRepositoryMemoryState } from '../memory/schema.ts';
import {
  createGitHubRepositoryMemoryStore,
  FileRepositoryMemoryStore,
  MemoryRepositoryMemoryStore,
} from '../memory/store.ts';
import { RepositoryLearningService } from '../memory/service.ts';
import type { FactoryRun } from '../factory/types.ts';
import type {
  RepositoryLearningObservation,
  RepositoryLearningPolicy,
  RepositoryMemoryState,
} from '../memory/types.ts';
import type { IssueComment } from '../github/client.ts';

const NOW = Date.UTC(2026, 8, 7);
const policy: RepositoryLearningPolicy = {
  version: 'learning-v1',
  enabled: true,
  minimumObservations: 3,
  requireHumanEvidenceFor: ['architecture-boundary'],
  decayAfterDays: 90,
};

describe('repository memory', () => {
  test('memory CLI reads and updates legacy stores without overriding canonical or explicit stores', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flowly-memory-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const script = path.resolve('scripts/memory.ts');
    const loader = import.meta.resolve('tsx');
    const cli = (args: string[], storePath?: string) => {
      const env = { ...process.env };
      delete env.FLOWLY_MEMORY_STORE;
      if (storePath !== undefined) env.FLOWLY_MEMORY_STORE = storePath;
      return spawnSync(process.execPath, ['--import', loader, script, ...args], {
        cwd: directory,
        env,
        encoding: 'utf8',
      });
    };
    const legacy = new FileRepositoryMemoryStore(
      path.join(directory, '.flue/repository-instincts.json'),
    );
    const canonicalPath = path.join(directory, '.flowly/repository-instincts.json');
    const canonical = new FileRepositoryMemoryStore(canonicalPath);
    const state = learnRepositoryInstincts('jellydn/flowly', null, [observation('1')], policy, NOW);
    const id = state.instincts[0].id;
    assert.deepEqual(JSON.parse(cli(['list']).stdout), []);
    await legacy.save(state);
    const listed = cli(['list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].id, id);
    assert.deepEqual(JSON.parse(cli(['explain', id]).stdout), state.instincts[0]);
    for (const [command, status] of [
      ['reject', 'rejected'],
      ['deprecate', 'deprecated'],
    ]) {
      const result = cli([command, id]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await legacy.load())!.instincts[0].status, status);
      assert.equal(await canonical.load(), null);
    }
    await canonical.save({ ...state, instincts: [] });
    assert.deepEqual(JSON.parse(cli(['list']).stdout), []);
    assert.deepEqual(JSON.parse(cli(['list'], 'missing.json').stdout), []);
    const explicit = new FileRepositoryMemoryStore(path.join(directory, 'explicit.json'));
    await explicit.save(state);
    assert.equal(JSON.parse(cli(['list'], 'explicit.json').stdout)[0].id, id);
    await writeFile(canonicalPath, 'invalid JSON');
    assert.equal(cli(['list']).status, 1);
  });

  test('validates observations, deduplicates equivalent lessons, and promotes deterministically', () => {
    const observations = [
      observation('run-1', 'API inputs require schema validation.'),
      observation('run-2', 'API inputs require schema validation!'),
      observation('run-3', 'API inputs require schema validation.'),
      { statement: 'unsupported model claim without provenance' },
    ];
    const state = learnRepositoryInstincts('jellydn/flowly', null, observations, policy, NOW);

    assert.equal(state.instincts.length, 1);
    assert.equal(state.instincts[0].evidence.length, 3);
    assert.equal(state.instincts[0].confidence, 1);
    assert.equal(state.instincts[0].status, 'active');
    assert.match(state.instincts[0].promotionExplanation.at(-1)!, /promotion gate passed/);
    assert.doesNotThrow(() => parseRepositoryMemoryState(state));
  });

  test('keeps activation off unless policy enables learning', () => {
    const state = learnRepositoryInstincts(
      'jellydn/flowly',
      null,
      [observation('1'), observation('2'), observation('3')],
      { ...policy, enabled: false },
      NOW,
    );
    assert.equal(state.instincts[0].status, 'candidate');
    assert.match(state.instincts[0].promotionExplanation.join(' '), /disabled/);
  });

  test('contradiction and decay reduce confidence and deactivate an instinct', () => {
    const active = learnRepositoryInstincts(
      'jellydn/flowly',
      null,
      [observation('1'), observation('2'), observation('3')],
      policy,
      NOW,
    );
    const contradicted = learnRepositoryInstincts(
      'jellydn/flowly',
      active,
      [{ ...observation('4'), outcome: 'contradicting' }],
      policy,
      NOW,
    );
    assert.equal(contradicted.instincts[0].confidence, 0.667);
    assert.equal(contradicted.instincts[0].status, 'candidate');

    const stale = learnRepositoryInstincts(
      'jellydn/flowly',
      active,
      [],
      policy,
      NOW + 91 * 86_400_000,
    );
    assert.equal(stale.instincts[0].confidence, 0.5);
    assert.equal(stale.instincts[0].status, 'candidate');
    assert.match(stale.instincts[0].promotionExplanation.join(' '), /older than 90 days/);
  });

  test('uses supporting evidence for decay even when a contradiction is recent', () => {
    const state = learnRepositoryInstincts(
      'jellydn/flowly',
      null,
      [observation('1'), observation('2'), observation('3')],
      policy,
      NOW,
    );
    const evaluated = learnRepositoryInstincts(
      'jellydn/flowly',
      state,
      [{ ...observation('4'), observedAt: NOW + 91 * 86_400_000, outcome: 'contradicting' }],
      policy,
      NOW + 91 * 86_400_000,
    );

    assert.equal(evaluated.instincts[0].confidence, 0.333);
    assert.match(evaluated.instincts[0].promotionExplanation.join(' '), /older than 90 days/);
  });

  test('does not deduplicate observations from different exact scopes', () => {
    const state = learnRepositoryInstincts(
      'jellydn/flowly',
      null,
      [
        observation('1'),
        observation('2'),
        observation('3'),
        { ...observation('4'), paths: ['packages/web/**'] },
      ],
      policy,
      NOW,
    );

    assert.equal(state.instincts.length, 2);
    assert.deepEqual(
      state.instincts.map((item) => item.scope.paths),
      [['packages/api/**'], ['packages/web/**']],
    );
  });

  test('requires human evidence for configured kinds', () => {
    const inputs = ['1', '2', '3'].map((id) => ({
      ...observation(id),
      kind: 'architecture-boundary' as const,
    }));
    const candidate = learnRepositoryInstincts('jellydn/flowly', null, inputs, policy, NOW);
    assert.equal(candidate.instincts[0].status, 'candidate');

    const active = learnRepositoryInstincts(
      'jellydn/flowly',
      candidate,
      [{ ...inputs[0], artifactId: 'human-1', source: 'human', humanConfirmed: true }],
      policy,
      NOW,
    );
    assert.equal(active.instincts[0].status, 'active');
  });

  test('scopes active instincts by stage and path and states precedence', () => {
    const state = learnRepositoryInstincts(
      'jellydn/flowly',
      null,
      [observation('1'), observation('2'), observation('3')],
      policy,
      NOW,
    );
    assert.equal(selectRepositoryInstincts(state, 'review', ['packages/api/handler.ts']).length, 1);
    assert.equal(
      selectRepositoryInstincts(state, 'planning', ['packages/api/handler.ts']).length,
      0,
    );
    assert.equal(selectRepositoryInstincts(state, 'review', ['packages/web/page.ts']).length, 0);
    assert.match(
      formatRepositoryInstinctContext(state.instincts),
      /Explicit repository and run instructions take precedence/,
    );
  });

  test('retains history when a human rejects or supersedes an instinct', () => {
    const original = learnRepositoryInstincts(
      'jellydn/flowly',
      null,
      [observation('1'), observation('2'), observation('3')],
      policy,
      NOW,
    );
    const rejected = setRepositoryInstinctStatus(original, original.instincts[0].id, 'rejected');
    assert.equal(rejected.instincts[0].status, 'rejected');
    assert.equal(rejected.instincts[0].evidence.length, 3);
    assert.equal(original.instincts[0].status, 'active');

    const withReplacement: RepositoryMemoryState = {
      ...original,
      instincts: [
        ...original.instincts,
        { ...original.instincts[0], id: 'replacement', statement: 'Use the new validation layer.' },
      ],
    };
    const superseded = supersedeRepositoryInstinct(
      withReplacement,
      original.instincts[0].id,
      'replacement',
    );
    assert.equal(superseded.instincts[0].status, 'deprecated');
    assert.equal(superseded.instincts[1].supersedes, original.instincts[0].id);
    assert.equal(withReplacement.instincts[0].status, 'active');
    assert.equal(withReplacement.instincts[1].supersedes, undefined);
  });

  test('replay is idempotent through the service store boundary', async () => {
    const store = new MemoryRepositoryMemoryStore();
    const service = new RepositoryLearningService('jellydn/flowly', policy, store);
    const review = {
      summary: 'Found missing validation.',
      verdict: 'COMMENT' as const,
      findings: [
        {
          severity: 'P2' as const,
          path: 'packages/api/handler.ts',
          line: 10,
          title: 'Validate API input',
          explanation: 'The handler bypasses the schema layer.',
          confidence: 0.9,
        },
      ],
    };
    await service.observePrReview(review, 42, NOW);
    await service.observePrReview(review, 42, NOW);
    assert.equal((await service.list())[0].evidence.length, 1);
  });

  test('extracts failed-then-fixed verification and repeated factory review findings', () => {
    const failed = factoryRun('failed', 1, {
      command: 'npm test',
      exitCode: 1,
      finding: 'Missing schema validation',
    });
    const fixed = factoryRun('completed', 2, {
      command: 'npm test',
      exitCode: 0,
      finding: 'Missing schema validation',
    });
    const observations = extractFactoryLearningObservations([failed, fixed]);
    assert.equal(observations.filter((item) => item.kind === 'verification').length, 2);
    assert.equal(observations.filter((item) => item.kind === 'review-rule').length, 2);
    assert.ok(observations.every((item) => item.runId && item.issueNumber));
    assert.deepEqual(
      observations.filter((item) => item.kind === 'verification').map((item) => item.outcome),
      ['supporting', 'contradicting'],
    );
  });

  test('GitHub persistence trusts only the configured bot and confines the repository', async () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        body: '<!-- flue-repository-memory\n{}\n-->',
        created_at: '',
        updated_at: '',
        user: { login: 'attacker' },
      },
    ];
    const client = {
      owner: 'jellydn',
      repo: 'flowly',
      async listIssueComments() {
        return comments;
      },
      async createIssueComment(_issue: number, body: string) {
        comments.push({
          id: 2,
          body,
          created_at: '',
          updated_at: '',
          user: { login: 'github-actions[bot]' },
        });
        return { id: 2, html_url: 'https://example.test/comment/2' };
      },
      async updateIssueComment(id: number, body: string) {
        comments.find((comment) => comment.id === id)!.body = body;
        return { id, html_url: `https://example.test/comment/${id}` };
      },
    };
    const store = createGitHubRepositoryMemoryStore(client, 138);
    const state = learnRepositoryInstincts('jellydn/flowly', null, [observation('1')], policy, NOW);
    await store.save(state);
    assert.match(comments[1].body, /flowly-repository-memory/);
    assert.deepEqual(await store.load(), state);

    comments[1].body = comments[1].body.replace(
      'flowly-repository-memory',
      'flue-repository-memory',
    );
    assert.deepEqual(await createGitHubRepositoryMemoryStore(client, 138).load(), state);
    await assert.rejects(
      () => store.save({ ...state, repositoryId: 'other/repository' }),
      /targets other\/repository/,
    );
  });

  test('retries GitHub updates after a conditional-write conflict', async () => {
    const comments: IssueComment[] = [];
    let updateAttempts = 0;
    let lastOptions: { maxPages?: number } | undefined;
    const client = {
      owner: 'jellydn',
      repo: 'flowly',
      async listIssueComments(_issue: number, options?: { maxPages?: number }) {
        lastOptions = options;
        return comments;
      },
      async createIssueComment(_issue: number, body: string) {
        comments.push({
          id: 2,
          body,
          created_at: '',
          updated_at: 'v1',
          user: { login: 'github-actions[bot]' },
        });
        return { id: 2, html_url: 'https://example.test/comment/2' };
      },
      async updateIssueComment(id: number, body: string, expectedUpdatedAt?: string) {
        assert.equal(expectedUpdatedAt, updateAttempts === 0 ? 'v1' : 'v2');
        updateAttempts += 1;
        if (updateAttempts === 1) {
          comments[0].updated_at = 'v2';
          throw Object.assign(new Error('conflict'), { status: 412 });
        }
        comments.find((comment) => comment.id === id)!.body = body;
        return { id, html_url: `https://example.test/comment/${id}` };
      },
    };
    const store = createGitHubRepositoryMemoryStore(client, 138);
    const state = learnRepositoryInstincts('jellydn/flowly', null, [observation('1')], policy, NOW);

    await store.save(state);
    await store.update((current) => ({
      ...current!,
      instincts: current!.instincts.map((instinct) => ({
        ...instinct,
        promotionExplanation: [...instinct.promotionExplanation, 'updated'],
      })),
    }));

    assert.equal(updateAttempts, 2);
    assert.equal(lastOptions?.maxPages, Number.POSITIVE_INFINITY);
  });

  test('serializes file-store read-modify-write updates', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flowly-memory-'));
    try {
      const filePath = path.join(directory, 'state.json');
      const first = new FileRepositoryMemoryStore(filePath);
      const second = new FileRepositoryMemoryStore(filePath);
      const state = learnRepositoryInstincts(
        'jellydn/flowly',
        null,
        [observation('1')],
        policy,
        NOW,
      );
      await first.save(state);

      await Promise.all(
        [
          ['first', first],
          ['second', second],
        ].map(async ([label, store]) => {
          await (store as FileRepositoryMemoryStore).update((current) => ({
            ...current!,
            instincts: current!.instincts.map((instinct) => ({
              ...instinct,
              promotionExplanation: [...instinct.promotionExplanation, label as string],
            })),
          }));
        }),
      );

      const explanation = (await first.load())!.instincts[0].promotionExplanation;
      assert.ok(explanation.includes('first'));
      assert.ok(explanation.includes('second'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects instincts that target another repository', () => {
    const state = learnRepositoryInstincts('jellydn/flowly', null, [observation('1')], policy, NOW);
    assert.throws(
      () =>
        parseRepositoryMemoryState({
          ...state,
          instincts: [{ ...state.instincts[0], repositoryId: 'other/repository' }],
        }),
      /Every instinct must target the state repository/,
    );
  });
});

function observation(
  artifactId: string,
  statement = 'API inputs require schema validation.',
): RepositoryLearningObservation {
  return {
    kind: 'review-rule',
    source: 'factory-review',
    artifactId,
    statement,
    paths: ['packages/api/**'],
    observedAt: NOW,
    runId: artifactId,
    issueNumber: 138,
  };
}

function factoryRun(
  state: FactoryRun['state'],
  sequence: number,
  input: { command: string; exitCode: number; finding: string },
): FactoryRun {
  return {
    id: `run-${sequence}`,
    task: {
      issueNumber: sequence,
      title: 'Test',
      body: 'Test',
      repository: 'jellydn/flowly',
    },
    state,
    version: 1,
    implementation: {
      workspaceId: `workspace-${sequence}`,
      commitSha: 'a'.repeat(40),
      changedFiles: ['packages/api/handler.ts'],
      commands: [{ command: input.command, exitCode: input.exitCode }],
    },
    review: {
      readyForHumanReview: false,
      acceptanceCriteria: [],
      summary: 'Review',
      unresolvedFindings: [input.finding],
    },
    updatedAt: NOW + sequence,
  };
}
