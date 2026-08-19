import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createAdvisorRunner, createSpecialistRunner } from '../review/model-runners.ts';

const originalFetch = globalThis.fetch;
const prompts: string[] = [];
const models: string[] = [];
let replies: string[] = [];

before(() => {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    models.push(body.model);
    prompts.push(body.messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() } }] }), {
      status: 200,
    });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe('review model runners', () => {
  test('specialist runner sends role-scoped context and extracts findings', async () => {
    replies = [
      '{"findings":[{"severity":"P2","path":"src/a.ts","line":1,"title":"Issue","explanation":"Evidence","confidence":0.8}]}',
    ];
    const runner = createSpecialistRunner('openrouter/test-model', {
      OPENROUTER_API_KEY: 'test-key',
    });

    const result = await runner(
      'security',
      { title: 'PR', diff: 'diff', changedFiles: ['src/a.ts'] },
      new AbortController().signal,
    );

    assert.ok(Array.isArray(result));
    assert.equal(models.at(-1), 'test-model');
    assert.match(prompts.at(-1) ?? '', /security specialist/);
    assert.match(prompts.at(-1) ?? '', /src\/a\.ts/);
  });

  test('advisor runner returns the model decision JSON', async () => {
    replies = ['Model output: {"decision":"accept","reason":"Supported."}'];
    const runner = createAdvisorRunner('openrouter/test-model', {
      OPENROUTER_API_KEY: 'test-key',
    });

    const result = await runner(
      {
        finding: {
          severity: 'P1',
          path: 'src/a.ts',
          line: 1,
          title: 'Issue',
          explanation: 'Evidence',
          confidence: 0.9,
        },
        diff: 'diff',
      },
      new AbortController().signal,
    );

    assert.deepEqual(result, { decision: 'accept', reason: 'Supported.' });
    assert.match(prompts.at(-1) ?? '', /final advisor/);
  });

  test('requires a provider-qualified model', () => {
    assert.throws(
      () => createSpecialistRunner('model-only', { OPENROUTER_API_KEY: 'test-key' }),
      /provider segment/,
    );
  });
});
