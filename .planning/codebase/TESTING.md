# Testing Patterns

**Analysis Date:** 2026-08-01

## Test Framework

- Node.js native `node:test` with `node:assert/strict`, executed through `tsx`.
- No Jest, Vitest, Playwright, lint runner, or numeric coverage threshold is configured.
- `npm test` runs `tsx --test tests/*.test.ts`.
- `npm run typecheck` runs strict `tsc`; `npm run build` runs Vite; `npm run check` runs all three in order.

## Test Organization

```text
tests/
├── helpers.ts                 # temporary repos, Flue contexts, envelope helper
├── repository.test.ts         # reader, path confinement, symlinks, budget
├── tools.test.ts              # list/read/search contracts and safe logging
├── planner.test.ts            # PlanRun, store compatibility, execution, replan
├── tool-execution.test.ts     # invocation seam, metadata, cancellation
├── inspection-registry.test.ts# registry construction/order/shared behavior
├── repository-search.test.ts  # search scopes and cancellation
├── doc-aware.test.ts          # docs, evidence, citations, confidence, loop
├── reliability.test.ts        # errors, retry, timeout, validation, fallback
└── eval-scenarios.test.ts     # deterministic expected tool sequences
```

Tests are top-level and named by responsibility. Suites use `describe`/`test`; temporary fixtures are created in `before` and removed in `after` where appropriate.

## Fixtures and Dependency Injection

- `tests/helpers.ts` creates a deterministic repository containing source files, documentation, ignored dependency noise, and misleading negative-search content.
- Filesystem safety tests use real temporary directories and symlinks rather than mocks.
- Reliability tests inject sleep functions, failure injectors, raw tool implementations, and captured console output.
- Investigation tests inject deterministic decision functions and tool maps.
- Flue v2 contexts are assembled through test helpers and `{ output: value }` envelopes are unwrapped consistently.

## Coverage by Concern

**Repository and tools:**

- Path traversal, escaping symlinks, ignored directories, file limits, line bounds, literal search, empty results, shared budget, debug logging, and file-read failures.

**Planning:**

- Rule-based plan generation, normalization, PlanRun state transitions, historical/current results, executor skips, answer termination, cancellation, replanning, reflection, and compatibility with legacy stores.

**Shared execution:**

- Unknown tools, successful invocation, Flue envelope normalization, input forwarding, metadata, preflight/resolution callbacks, pre-abort behavior, in-flight cancellation, and compatibility exports.

**Registry/search:**

- Stable inspection registration order, all four wrapped tools, shared budget use, source/documentation scopes, early cancellation, bounded matches, and `filesSearched` behavior.

**Reliability:**

- Error classification, transient retry/backoff, cancellation, timeout, permanent failures, output validation, safe messages, fallback, failure injection, and structured observability.

**Evidence and answers:**

- Documentation/code evidence extraction, deduplication, excerpt truncation, confidence levels, citations, insufficient-evidence responses, duplicate-call blocking, early stopping, and iteration limits.

## Running Checks

```bash
npm run typecheck
npm test
npm run build
npm run check
npx tsx --test tests/repository-search.test.ts
npx tsx --test tests/tool-execution.test.ts
```

The deterministic suite does not require an LLM key. `eval/run-eval.sh` is the manual/live model-driven evaluation path and requires a configured provider key.

## Gaps

- No automated test exercises the live Flue route, `RepoAssistant()` initialization under runtime conditions, or an actual provider request.
- No numeric coverage reporting or threshold is enforced.
- Prompt/tool-contract parity is documented but not mechanically tested.
- Concurrent hostile repository mutation and prompt-injection content have limited targeted coverage.
- Search behavior for unusual documentation formats and very large repositories is not covered by a performance suite.

---

_Testing analysis: 2026-08-01_
