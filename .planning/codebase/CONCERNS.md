# Codebase Concerns

**Analysis Date:** 2026-08-01

## Tech Debt

**Repeated model-facing contract documentation:**

- Runtime names and limits are centralized in `tools/contracts.ts`, but `README.md`, `AGENTS.md`, `skills/analyzing-repositories/SKILL.md`, `docs/index.html`, and the agent prompt still repeat parts of the contract.
- A tool or limit change can therefore leave onboarding docs and model guidance stale.
- Improvement: add a parity check or generate selected descriptions/docs from shared contracts.

**Large orchestration/test files:**

- `tools/repository.ts`, `agents/repo-assistant.ts`, `tests/reliability.test.ts`, `tests/doc-aware.test.ts`, and `tests/planner.test.ts` remain relatively large and cross several concerns.
- The recent deep modules reduce composition and lifecycle duplication, but reliability tests and agent prompt/configuration remain review-heavy.
- Improvement: split tests by policy only when it improves locality; avoid abstraction without a second caller.

## Known Bugs and Behavioral Risks

- No confirmed runtime bug was found in this static refresh.
- The live Flue route/provider path is not exercised by CI, so framework API drift can pass the deterministic suite unnoticed.
- Programmatic `PlanRun` execution and the live model-facing Flue conversation are intentionally parallel paths; changes should preserve their shared contracts without assuming the live runtime calls `executePlan()`.

## Security Considerations

**Repository content is untrusted input:**

- Files may contain prompt-injection text, secrets, or misleading instructions.
- Mitigation: content-as-data instructions, no write/shell/Git/network tools, bounded reads, and evidence-based answers.
- Improvement: add adversarial prompt-injection fixtures and keep the instruction adjacent to retrieved content handling.

**Path validation assumes a stable tree:**

- Validation, realpath/stat, traversal, and read operations can race with hostile concurrent mutation of the checkout.
- Mitigation: canonical path checks, symlink rejection, ignored directories, size limits, and a documented stable-tree assumption.
- Improvement: use an isolated snapshot or descriptor-based reads if hostile concurrent mutation becomes in scope.

**Logging and secrets:**

- Future logging fields could accidentally expose provider input or repository content.
- Mitigation: sanitized tool/debug logs, structured reliability logging tests, and ignored `.env`.
- Improvement: treat every logging-field change as security-sensitive and retain regression assertions.

## Performance and Scaling

**Sequential candidate scans:**

- `searchRepository()` materializes candidate paths, then `searchFiles()` reads them sequentially. This is intentionally simple and bounded but can be expensive for large monorepos.
- The seam now centralizes search policy and cancellation, but does not introduce an index or streaming traversal.
- Improvement: measure first; then consider streaming/short-circuit traversal, bounded concurrency, or an optional index while preserving reader confinement.

**Bounded outputs and budgets:**

- Inspection calls are limited to 1–20 (default 8); reads are bounded by file size/line count and searches by match count.
- Complex questions may exhaust the budget before enough files are read, while large repositories may still spend time enumerating candidates.
- Improvement: planner prioritization and evidence ranking before increasing limits.

## Fragile Areas

**Flue v2 invocation seam:**

- `reliability/tool-invocation.ts` must preserve `data`, `toolCallId`, `log`, `signal`, and `{ output }` behavior. `investigation/tool-execution.ts` retains compatibility exports and a metadata-stripping legacy result path.
- Safe modification: update direct callers, compatibility tests, and `runExecutionLoop` together.

**Reliability composition:**

- Budget consumption, pass-through budgets, retry classification, timeout aborts, validation, failure injection, fallback, and safe errors cross several modules.
- Safe modification: preserve one budget consume per logical call and extend deterministic tests before changing wrappers.

**Registry composition:**

- `InspectionRegistry` owns the typed tool order and wraps each raw factory. Adding/removing a tool requires updating the name union/tuple, factory map, agent registration expectations, and focused tests.

**Plan lifecycle compatibility:**

- `PlanRun` is the lifecycle owner while `PlanStore` supports legacy/narrow callers with a `WeakMap` fallback for current-result tracking.
- Safe modification: test both native `PlanRun` and legacy store adapters when changing result/replan behavior.

## Missing or Weak Coverage

- Live `RepoAssistant()` initialization, `/agents/repo-assistant`, `/api/ping`, and real `flue run` behavior are not automated.
- No provider/network integration suite verifies model schema or tool selection.
- Prompt/tool/README parity is not mechanically checked.
- Adversarial repository prompt injection, concurrent mutation, unusual documentation formats, and large-repository performance are only partially covered.

## Dependency Risks

- Flue v2 runtime, CLI, Vite plugin, Vite, TypeScript, and Hono integration are build-critical and can drift together.
- Upgrade these as a coordinated set and run `npm ci && npm run check`.
- No deployment or persistence layer reduces operational surface area but leaves live hosting behavior outside this repository's validation.

---

_Concerns audit: 2026-08-01_
