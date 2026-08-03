/**
 * Model provider registry: known providers and their pricing, plus a model
 * call function seam so benchmark runs can talk to any provider.
 *
 * Pricing is used to estimate cost from token usage (input + output per 1K
 * tokens, USD). Providers not listed here simply report $0 cost; the registry
 * is a convenience table, not an exhaustive catalog.
 */

import type { ModelPricing, ModelSpec } from './types.ts';

/** Known provider pricing (per 1K tokens, USD). Approximate list prices. */
export const PROVIDER_PRICING: Record<string, ModelPricing> = {
  openai: { inputPer1kUsd: 0.0025, outputPer1kUsd: 0.01 },
  anthropic: { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  google: { inputPer1kUsd: 0.00125, outputPer1kUsd: 0.005 },
  deepseek: { inputPer1kUsd: 0.00027, outputPer1kUsd: 0.0011 },
  glm: { inputPer1kUsd: 0.001, outputPer1kUsd: 0.001 },
  qwen: { inputPer1kUsd: 0.0004, outputPer1kUsd: 0.0012 },
  grok: { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  openrouter: { inputPer1kUsd: 0.001, outputPer1kUsd: 0.002 },
};

/** Look up pricing for a provider, falling back to undefined (no cost). */
export function pricingForProvider(provider: string): ModelPricing | undefined {
  return PROVIDER_PRICING[provider.toLowerCase()];
}

/**
 * Attach default provider pricing to a model spec when it has none. Returns a
 * new spec; the input is not mutated.
 */
export function withDefaultPricing(model: ModelSpec): ModelSpec {
  if (model.pricing) return model;
  const pricing = pricingForProvider(model.provider);
  if (!pricing) return model;
  return { ...model, pricing };
}

/**
 * Model call function: the seam between the benchmark runner and a live LLM
 * provider. Implementations should return the assistant text for a prompt.
 * The benchmark framework never calls providers directly — the CLI wires this.
 */
export type ModelCallFn = (prompt: string) => Promise<string>;

/** A model call function that always returns a fixed reply (for tests/live smoke). */
export function createStaticModelCall(reply: string): ModelCallFn {
  return async () => reply;
}

/** Simple OpenAI-compatible chat completions client via fetch (no SDK deps). */
export function createOpenAiCompatibleClient(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): ModelCallFn {
  const { apiKey, baseUrl, model } = input;
  return async (prompt: string): Promise<string> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(`Provider returned ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('Provider returned an empty completion');
    return content;
  };
}
