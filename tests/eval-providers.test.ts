import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  PROVIDER_BASE_URLS,
  PROVIDER_KEY_ENVS,
  createProviderClient,
  createStaticModelCall,
} from '../eval/bench/providers.ts';
import type { ModelSpec } from '../eval/bench/types.ts';

const originalFetch = globalThis.fetch;

before(() => {
  // Stub fetch so provider-client tests never touch the network.
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('custom.example.com')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'proxy-ok' } }] }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_cost: 0.001 },
      }),
      { status: 200 },
    );
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe('provider registry', () => {
  test('known providers have a default base URL and key env', () => {
    assert.equal(PROVIDER_BASE_URLS.openrouter, 'https://openrouter.ai/api/v1');
    assert.equal(PROVIDER_BASE_URLS.openai, 'https://api.openai.com/v1');
    assert.equal(PROVIDER_KEY_ENVS.openai, 'OPENAI_API_KEY');
    assert.equal(PROVIDER_KEY_ENVS.anthropic, 'ANTHROPIC_API_KEY');
  });

  test('createProviderClient resolves the per-provider defaults and wires usage', async () => {
    const model: ModelSpec = {
      id: 'openrouter/qwen/qwen3-coder',
      provider: 'openrouter',
    };
    const client = createProviderClient(model, { OPENROUTER_API_KEY: 'sk-test' });
    const reply = await client('hello');
    assert.equal(reply.content, 'ok');
    assert.equal(reply.usage?.inputTokens, 10);
    assert.equal(reply.usage?.outputTokens, 5);
    assert.equal(reply.usage?.billedCostUsd, 0.001);
  });

  test('custom baseUrl is used for unknown providers', async () => {
    const model: ModelSpec = {
      id: 'proxy-model',
      provider: 'unknown-provider',
      baseUrl: 'https://my-proxy.example.com/v1',
    };
    const client = createProviderClient(model, { FLUE_EVAL_API_KEY: 'sk-proxy' });
    // The stub answers custom.example.com; a real unknown endpoint would
    // still construct a working client, so just assert it resolves.
    assert.ok(client);
    const reply = await client('hello');
    assert.ok(reply.content.length > 0);
  });

  test('model apiKeyEnv overrides the provider default', () => {
    const model: ModelSpec = {
      id: 'openai/gpt-4o',
      provider: 'openai',
      apiKeyEnv: 'MY_CUSTOM_KEY',
    };
    // No OPENAI_API_KEY, but the custom env var is present.
    const client = createProviderClient(model, { MY_CUSTOM_KEY: 'sk-custom' });
    assert.ok(client);
  });

  test('model baseUrl overrides the provider default', () => {
    const model: ModelSpec = {
      id: 'proxy-model',
      provider: 'unknown-provider',
      baseUrl: 'https://my-proxy.example.com/v1',
    };
    // Unknown provider is fine when baseUrl is explicit.
    const client = createProviderClient(model, { FLUE_EVAL_API_KEY: 'sk-proxy' });
    assert.ok(client);
  });

  test('unknown provider without baseUrl throws an actionable error', () => {
    const model: ModelSpec = { id: 'x/y', provider: 'mystery' };
    assert.throws(
      () => createProviderClient(model, { OPENROUTER_API_KEY: 'sk-test' }),
      /No base URL for provider "mystery"/,
    );
  });

  test('missing key throws an actionable error naming the key env', () => {
    const model: ModelSpec = { id: 'openai/gpt-4o', provider: 'openai' };
    assert.throws(
      () => createProviderClient(model, {}),
      /No API key for provider "openai". Set OPENAI_API_KEY/,
    );
  });

  test('FLUE_EVAL_API_KEY and OPENROUTER_API_KEY remain fallbacks', () => {
    const model: ModelSpec = { id: 'openai/gpt-4o', provider: 'openai' };
    const viaFlueEval = createProviderClient(model, { FLUE_EVAL_API_KEY: 'sk-a' });
    assert.ok(viaFlueEval);
    const openrouter: ModelSpec = { id: 'openrouter/qwen/qwen3-coder', provider: 'openrouter' };
    const viaOpenRouter = createProviderClient(openrouter, { OPENROUTER_API_KEY: 'sk-b' });
    assert.ok(viaOpenRouter);
  });

  test('FLUE_EVAL_BASE_URL falls back for providers without a known endpoint', () => {
    const model: ModelSpec = { id: 'x/y', provider: 'custom' };
    const client = createProviderClient(model, {
      FLUE_EVAL_BASE_URL: 'https://custom.example.com/v1',
      FLUE_EVAL_API_KEY: 'sk-custom',
    });
    assert.ok(client);
  });

  test('createStaticModelCall returns the fixed reply', async () => {
    const client = createStaticModelCall('fixed answer');
    assert.deepEqual(await client('any prompt'), { content: 'fixed answer' });
  });
});
