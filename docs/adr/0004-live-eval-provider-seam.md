# 0004. Live-eval provider seam

Date: 2026-08-04

## Status

Accepted

## Context

The eval benchmark framework (ADR-0002) shipped deterministic and live modes,
but three seams were left shallow on the way:

1. **One shared model client ran every model in a config.** `runAll` in
   the evaluation CLI built a single `createLiveModelCall()` from the
   legacy `FLUE_EVAL_MODEL` env var and passed it to every model in the
   config's `models[]` list. A config listing two providers could not run both
   live — the second silently ran against the first's endpoint. Provider
   resolution belonged per-model, not per-run.
2. **"Live" mode never exercised the agent loop.** `runLive` used a hardcoded
   `gather` decider that called `retrieve` exactly once, then stopped. The
   plan→execute→reflect investigation loop — the repo's whole thesis — was
   never evaluated live; the model just answered a prompt with one retrieval's
   evidence.
3. **The LLM-as-a-judge seam had no production caller.** `createLlmJudge` was
   implemented and tested, but the CLI never constructed it: no `--judge-model`
   flag, and `runAll` always used the keyword judge. A finished seam with no
   wiring.

All three defects were confirmed against the code before the stack was
planned: the sample config already listed three models (openrouter, anthropic,
deepseek) that a single client would have run against one endpoint.

## Decision

Land a five-layer gh-stack (in dependency order) that turns live evaluation
into a per-model, loop-driven, judge-swappable pipeline:

- **Provider registry.** `eval/framework/providers.ts` grows
  `createProviderClient(spec, env)`: a registry keyed by provider (known base
  URLs, key envs, pricing) returning a `ModelCallFn`, with per-model
  `apiKeyEnv`/`baseUrl` overrides on `ModelSpec`. `runAll` now resolves one
  client per model from the model spec + env; the legacy `FLUE_EVAL_MODEL`
  env var is retired.
- **Model-driven loop.** `eval/framework/model-loop.ts` adds
  `createModelDecider(modelCall, toolNames)`: a `DecisionFn` that formats the
  investigation state into a prompt, asks the provider for the next action as
  JSON, and parses it into an `InvestigationAction`. `runLive` wires it in, so
  live scenarios run the real search→read→answer loop instead of a single
  `retrieve`.
- **LLM judge.** `eval/framework/judge.ts` adds `createLlmJudgeFromSpec`, building
  an LLM-as-a-judge through the same provider registry, and the report records
  the judge (`judge` field: `'keyword'` or the judge model id).
- **CLI wiring.** `scripts/flowly-eval.ts` accepts `--judge-model <spec>` (a
  provider-qualified id or JSON model spec, validated by
  `parseModelSpecString`); `run`/`compare` accept it; `report`/`compare` print
  the judge line.
- **Docs.** ADR-0004 plus README/AGENTS eval sections describing per-model
  live runs and the model-driven loop.

The deterministic path stays the default and CI remains key-free: live mode
and `--judge-model` are both opt-in flags.

## Consequences

### 📋 Positive

- A config of mixed providers now runs each model against its own endpoint and
  key — the sample config's openrouter/anthropic/deepseek models finally
  benchmark against their real providers.
- Live evaluation exercises the investigation loop (plan → execute → reflect)
  rather than a single retrieval, so live quality scores measure the agent's
  actual behaviour.
- LLM-as-a-judge is a first-class CLI feature with per-model key resolution;
  reports say which judge scored them, keeping leaderboard rows comparable.
- The registry table (pricing, base URLs, key envs) is the single source of
  truth for provider defaults; unknown providers fail with an actionable
  message naming the missing field.

### 📋 Negative

- Live mode and `--judge-model` both require a key; misconfiguration fails
  fast with an actionable error rather than silently degrading.
- Per-model `baseUrl` and `apiKeyEnv` overrides require the explicit
  `--trust-model-overrides` operator flag. This prevents an unreviewed suite
  from selecting a sensitive environment variable and sending it to an
  arbitrary endpoint.
- The model-driven loop makes live runs non-deterministic and token-spending
  by nature — CI must stay on deterministic mode.
- The provider registry is a convenience table, not an exhaustive catalog;
  providers outside it need an operator-owned `FLOWLY_EVAL_BASE_URL` or a
  trusted per-model `baseUrl` (and cost stays unknown unless pricing or
  provider-reported usage is available).
- `FLOWLY_EVAL_API_KEY` and `FLOWLY_EVAL_BASE_URL` are the product-wide
  fallbacks. The old `FLUE_EVAL_API_KEY` and `FLUE_EVAL_BASE_URL` names remain
  read fallbacks for compatibility; `FLUE_EVAL_MODEL` is retired. These are
  extra resolution paths to consider when debugging a client build.
