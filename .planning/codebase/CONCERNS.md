# Codebase Concerns

**Analysis Date:** 2026-08-01

## Tech Debt

**Duplicated model/tool contract knowledge:**
- Issue: Runtime tool names, planner targets, and repository/evidence limits are now centralized in `tools/contracts.ts`, but model-facing descriptions and user documentation still repeat parts of those contracts.
- Files: `tools/contracts.ts`, `README.md`, `AGENTS.md`, `skills/analyzing-repositories/SKILL.md`, `eval/README.md`, and `agents/repo-assistant.ts`.
- Impact: Future tool or limit changes can still leave user docs, skill guidance, and runtime instructions inconsistent even though runtime schemas share a source of truth.
- Fix approach: Add a documentation/code parity check or generate model-facing descriptions from the shared contract where practical; keep stale-comment and test-description cleanup synchronized with tool registration.

**Large orchestration and test modules:**
- Issue: Several files combine many responsibilities or contain long suites.
- Files: `tools/repository.ts` (~350 lines), `agents/repo-assistant.ts` (~190 lines), `tests/reliability.test.ts` (~771 lines), `tests/doc-aware.test.ts` (~598 lines), and `tests/planner.test.ts` (~496 lines).
- Impact: Review and change isolation become harder; regressions may be difficult to localize.
- Fix approach: Shared inspection constants have been extracted to `tools/contracts.ts`; remaining work is to split reliability tests by concern and keep agent composition declarative.

## Known Bugs

**No confirmed runtime bug found in the fresh static map:**
- Symptoms: Not established from repository inspection alone.
- Files: Behavioral coverage exists in `tests/`.
- Trigger: Live provider/runtime behavior is not fully exercised in CI.
- Workaround: Run `npm run check` locally with dependencies installed and use `eval/run-eval.sh` with a provider key for live behavior.

**Potential state mismatch during manual execution:**
- Symptoms: The programmatic executor records results in `PlanStore` only when callers add them; the model-facing Flue flow relies on the runtime conversation rather than `executePlan()`.
- Files: `planner/executor.ts`, `planner/plan-store.ts`, `agents/repo-assistant.ts`.
- Trigger: Mixing deterministic executor assumptions with live model-facing tool calls.
- Workaround: Treat `executePlan()` as a test/demo contract and verify the live flow through the registered tools.

## Security Considerations

**Local repository content is untrusted input:**
- Risk: Repository files can contain prompt-injection text, secrets, or misleading instructions.
- Files: `agents/repo-assistant.ts`, `skills/analyzing-repositories/SKILL.md`, `tools/repository.ts`.
- Current mitigation: The prompt and skill explicitly treat repository content as data; the agent has no write, shell, Git, or network tool; answers require retrieved evidence. See `sandbox.ts` and `agents/repo-assistant.ts`.
- Recommendations: Keep the content-as-data instruction close to tool results, add adversarial fixture tests, and avoid passing unnecessary file content into logs.

**Path confinement is strong but assumes a stable tree:**
- Risk: Concurrent hostile mutation of the inspected checkout could create race conditions between validation, `realpath`, `stat`, and reading.
- Files: `tools/repository.ts`, `README.md`, `tests/repository.test.ts`.
- Current mitigation: Relative-path checks, canonical root checks, symlink rejection, ignored directories, and size limits.
- Recommendations: Document trusted-tree assumptions prominently; for hostile environments consider descriptor-based reads or an isolated snapshot.

**Secrets and provider access:**
- Risk: A misconfigured debug/logging change could expose provider input or repository data.
- Files: `tools/repository.ts`, `reliability/observability.ts`, `.env.example`.
- Current mitigation: Sanitized inputs, no file contents/absolute paths in logs, `.env` ignored by Git.
- Recommendations: Add regression tests for reliability logs and review any future logging fields as security-sensitive.

## Performance Bottlenecks

**Repeated full-tree scans:**
- Problem: `sourceFiles()` and `documentationFiles()` list the requested tree and then read candidate files sequentially for every search call.
- Files: `tools/repository.ts`, `tools/search-code.ts`, `tools/search-docs.ts`.
- Cause: Simple synchronous-in-order repository traversal and per-call file reads; no index or cache.
- Improvement path: Keep current bounded behavior for small/educational repos; for large repos add an optional index, streaming search, or concurrency with explicit memory/time caps.

**Large output and plan limits:**
- Problem: A walk can inspect up to 10,000 entries, while tool results and evidence have separate caps.
- Files: `tools/contracts.ts`, `tools/repository.ts`, `tools/list-files.ts`, `investigation/evidence.ts`.
- Cause: The hard limits are now centrally represented, but each layer still exposes its own truncation metadata and the limits remain independent.
- Improvement path: Preserve the shared constants and expose consistent truncation metadata across every result type if downstream consumers need uniform handling.

## Fragile Areas

**Flue v2 tool context/envelope boundary:**
- Files: `tools/*.ts`, `reliability/resilient-tool.ts`, `planner/executor.ts`, `investigation/loop.ts`, `tests/helpers.ts`.
- Why fragile: v2 requires `data`, `toolCallId`, `log`, and `{ output: value }`; direct test and wrapper calls use casts/unwrap logic.
- Safe modification: Update `tests/helpers.ts`, raw/wrapped tools, and all direct `tool.run()` call sites together; run `npm run typecheck` and `npm test`.
- Test coverage: Broad direct-tool coverage, but live Flue route/CLI invocation is not covered by automated tests.

**Reliability wrapper semantics:**
- Files: `reliability/resilient-tool.ts`, `reliability/retry.ts`, `reliability/fallback.ts`, `reliability/validation.ts`.
- Why fragile: Budget consumption, retry signals, output envelopes, failure injection, and safe errors cross several abstractions.
- Safe modification: Preserve one budget consume per logical call, use pass-through budgets for raw tools, and extend deterministic reliability tests first.
- Test coverage: `tests/reliability.test.ts` is extensive, but no live network/provider integration is present.

**Model-facing prompt/tool parity:**
- Files: `agents/repo-assistant.ts`, `planner/planner.ts`, `tools/contracts.ts`, `skills/analyzing-repositories/SKILL.md`, `README.md`.
- Why fragile: The runtime planner schemas now share canonical tool names, but prompt, skill, and user documentation still enumerate capabilities independently.
- Safe modification: Search all tool names/limits before changing registration; update code comments, docs, skill, and deterministic tests in one change.
- Test coverage: `tests/doc-aware.test.ts` covers `search_docs`; no automated assertion verifies prompt text matches registered tools or shared limits.

## Scaling Limits

**Inspection budget:**
- Current capacity: 1–20 logical inspection calls, default 8. See `tools/repository.ts` and `.env.example`.
- Limit: Complex questions can exhaust the budget before enough files are read; Flue v2 does not provide a native max-turn setting. See `README.md` and `AGENTS.md`.
- Scaling path: Improve planner prioritization, add budget-aware evidence ranking, or make the limit configurable per request with safe upper bounds.

**Repository/output bounds:**
- Current capacity: The repository and evidence bounds are defined by `TOOL_LIMITS` in `tools/contracts.ts` and consumed by the reader, search/list tools, and evidence collector.
- Limit: Large monorepos can produce incomplete context or expensive sequential scans.
- Scaling path: Add indexed/streaming search while retaining path confinement and hard output caps.

## Dependencies at Risk

**Flue v2 and fast-moving toolchain:**
- Risk: `@flue/runtime`, `@flue/cli`, `@flue/vite`, Vite, and TypeScript are framework/build-critical and recently migrated together.
- Impact: API or plugin changes can break agent hooks, skill packaging, route mounting, or builds.
- Migration plan: Pin/upgrade as a coordinated set, run `npm ci && npm run check`, and keep `AGENTS.md` current. See `package.json`, `vite.config.ts`, and `app.ts`.

**Runtime dependencies without local installation in this workspace:**
- Risk: Validation cannot run until the dependency tree is installed.
- Impact: `npm run typecheck`/tests/build fail with missing module and Node type declarations when `node_modules` is absent.
- Migration plan: Use the committed `package-lock.json` and `npm ci` in a controlled development environment; do not commit generated dependency directories. See `.github/workflows/ci.yml` and `.gitignore`.

## Missing Critical Features

**Live-provider integration coverage:**
- Problem: The live model path and HTTP route are documented but not automatically exercised.
- Blocks: Early detection of provider/model schema drift, Flue route regressions, and actual tool-choice quality.
- Files: `app.ts`, `agents/repo-assistant.ts`, `eval/run-eval.sh`, `.github/workflows/ci.yml`.

**Automated documentation/code parity:**
- Problem: Tool counts, limits, and commands are still repeated manually across user docs and model-facing guidance, despite runtime contracts now being centralized.
- Blocks: Confidence that onboarding docs remain synchronized after future changes.
- Files: `README.md`, `AGENTS.md`, `docs/index.html`, `.env.example`, `tools/contracts.ts`, `tools/`, `agents/repo-assistant.ts`.

## Test Coverage Gaps

**Flue route and CLI entrypoint:**
- What's not tested: `createAgentRouter`, `/api/ping`, `RepoAssistant()` initialization, and the actual `flue run` invocation.
- Files: `app.ts`, `agents/repo-assistant.ts`, `vite.config.ts`.
- Risk: Flue v2 wiring can regress while unit tests remain green.
- Priority: Medium.

**Search-docs edge cases:**
- What's not tested: Documentation basename behavior for extensionless files, nested ignored directories beyond the fixture, binary docs, and concurrent file mutation.
- Files: `tools/search-docs.ts`, `tools/repository.ts`, `tests/doc-aware.test.ts`.
- Risk: Documentation search may omit or mishandle unusual repositories.
- Priority: Low/Medium.

**Security adversarial cases:**
- What's not tested: Prompt-injection content in a retrieved file, race conditions between path validation and read, and malformed reliability log inputs.
- Files: `skills/analyzing-repositories/SKILL.md`, `tools/repository.ts`, `reliability/observability.ts`, `tests/`.
- Risk: Safety assumptions could regress without a targeted fixture.
- Priority: Medium.

---

*Concerns audit: 2026-08-01*
