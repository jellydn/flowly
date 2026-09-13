# 0002. Model evaluation benchmark framework

Date: 2026-08-04

## Status

Accepted

## Context

OpenRouter ORI Eval provides a strong UX for comparing LLMs on identical
prompts. **Flowly** wanted the same model-comparison story but for
its own real workloads — repository-analysis questions, PR reviews, and coding
tasks — with hard numbers: quality score, latency, token usage, cost,
tool-call success rate, patch applicability, and human acceptance (issue #38).

The hard constraints were:

1. **Deterministic, key-free evaluation** so CI and tests are reproducible and
   do not depend on a live LLM or spend tokens.
2. **Live evaluation** against real providers when a key is available, to get
   truthful latency, token usage, and cost.
3. **Configurable suites** — new benchmarks should be JSON or YAML, not code.
4. **Persistence and comparison** — reports must survive across runs so models
   can be ranked on a leaderboard and regressions across model versions caught.

## Decision

Add a built-in evaluation framework in `eval/framework/`, modeled on the existing
repository eval (`eval/repository/scenarios.ts`) but generalized into a config-driven
suite runner. The framework is split across three modules that were landed as
a gh-stack of three PRs (#39–#41):

- **Core** (`eval/framework/types.ts`, `schema.ts`, `config.ts`, `metrics.ts`,
  `store.ts`): the data model (suites, scenarios, reports, leaderboard rows),
  Valibot validation with field-path issues, JSON/YAML config loading, cost/quality
  computation, and memory + file-backed report stores.
- **Runner + judge + providers** (`runner.ts`, `judge.ts`, `providers.ts`,
  `patch.ts`): executes suites through the investigation pipeline. Two modes:
  deterministic (deciders keyed by scenario id, no LLM) and live (a
  `modelCall` builds a prompt from question + evidence and uses the reply as
  the answer). Scoring is keyword-based by default with an LLM-as-a-judge
  seam; provider pricing drives cost estimation; typed coding workloads run
  returned unified diffs through non-mutating `git apply --check` by default.
- **CLI + wiring** (`scripts/flowly-eval.ts`): `npm run eval` with `run`,
  `compare`, `leaderboard`, and `report` subcommands, the bundled
  `eval/suites/sample.json` suite, docs, and an example CI workflow.

Key choices:

- **Deterministic mode is the default** and reuses the capstone deciders, so
  `npm run eval -- run` is fully reproducible with no key — safe for CI.
- **Live mode genuinely calls the model**: the runner threads question +
  evidence into a prompt and grounds citations in retrieved files (an early
  review caught that live mode never invoked the model; a spy test now proves
  it fires).
- **Reports persist as JSON** under `eval/results/` (`FLOWLY_EVAL_RESULTS_DIR`)
  so `leaderboard` and `report` work across runs.
- **Dependency-light**: provider calls use a thin OpenAI-compatible `fetch`
  client and a static pricing table — no SDK per provider.

## Consequences

### 📋 Positive

- Reproducible model comparison: same suite, same deciders, same scores in CI.
- Full metric set per issue #38: quality, latency, tokens, cost, tool-call
  success rate, patch applicability, and human acceptance (stored as NaN until
  an operator records verdicts).
- Config-driven: adding a benchmark is writing JSON or YAML, not code.
- Typed issue, pull-request-review, and coding-task snapshots preserve real
  workload context while keeping runs reproducible and credential-free.
- LLM-as-a-judge is a pluggable seam, not a hard dependency.

### 📋 Negative

- The keyword judge is a heuristic — it cannot judge nuance that keyword and
  source matching miss; the LLM judge requires a key and is non-deterministic.
- Deterministic mode estimates cost from a static pricing table and token
  heuristics. Live mode uses provider-reported usage when available.
- Deterministic deciders must exist for every scenario id, or the runner
  throws — custom suites must ship matching deciders or run live.
