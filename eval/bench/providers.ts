/**
 * Model provider registry: known providers and their pricing, plus a model
 * call function seam so benchmark runs can talk to any provider.
 *
 * Pricing is used to estimate cost from token usage (input + output per 1K
 * tokens, USD). Providers not listed here simply report $0 cost; the registry
 * is a convenience table, not an exhaustive catalog.
 *
 * Live mode prefers real usage reported by the provider (see ModelCallResult
 * and createOpenAiCompatibleClient); the pricing table remains the fallback
 * when a provider does not report usage.
 */

import type { ModelPricing, ModelSpec } from './types.ts';

/** Real token usage and cost reported by a provider on a single model call. */
export type ModelUsage = {
  /** Prompt (input) tokens consumed by the call. */
  inputTokens?: number;
  /** Completion (output) tokens produced by the call. */
  outputTokens?: number;
  /** Billed cost in USD as reported by the provider (OpenRouter total_cost). */
  billedCostUsd?: number;
};

/** The result of a model call: the assistant text plus optional real usage. */
export type ModelCallResult = {
  content: string;
  usage?: ModelUsage;
};

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
 * provider. Implementations return the assistant text plus any real usage the
 * provider reported (tokens, billed cost). The benchmark framework never calls
 * providers directly — the CLI wires this.
 */
export type ModelCallFn = (prompt: string) => Promise<ModelCallResult>;

/** A model call function that always returns a fixed reply (for tests/live smoke). */
export function createStaticModelCall(reply: string): ModelCallFn {
  return async () => ({ content: reply });
}

/** Simple OpenAI-compatible chat completions client via fetch (no SDK deps). */
export function createOpenAiCompatibleClient(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): ModelCallFn {
  const { apiKey, baseUrl, model } = input;
  return async (prompt: string): Promise<ModelCallResult> => {
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
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_cost?: number;
      };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('Provider returned an empty completion');
    // Wire real usage from the provider response so reports reflect billed
    // tokens and cost instead of heuristics (see CONCERNS.md).
    const usage: ModelUsage = {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      billedCostUsd: body.usage?.total_cost,
    };
    const hasUsage = Object.values(usage).some((v) => v !== undefined);
    return { content, usage: hasUsage ? usage : undefined };
  };
}
