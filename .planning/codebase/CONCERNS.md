# Codebase Concerns

**Analysis Date:** 2026-08-04

## Tech Debt

**Retrieve/indexer coupling:**
- Issue: `tools/retrieve.ts` depends on `index/repository-indexer.ts`, and `eval/bench/runner.ts` hardcodes `retrieve` as the first live-mode tool call — a model-driven tool strategy would be more flexible
- Files: `tools/retrieve.ts`, `index/repository-indexer.ts`, `eval/bench/runner.ts`
- Impact: live-mode scenarios with `requiresToolCall: false` must be handled specially; custom live suites can't choose their own first tool
- Fix approach: make the live-mode tool strategy configurable per suite/scenario

**`eval/bench/providers.ts` pricing table is approximate:**
- Issue: static per-1K pricing is a convenience table, not exhaustive or billed
- Files: `eval/bench/providers.ts`
- Impact: cost estimates drift from real provider billing for unlisted models
- Fix approach: wire real token usage from provider responses in live mode

**Manually maintained docs duplication:**
- Issue: README, AGENTS.md, `.planning/codebase/`, and `docs/index.html` overlap and must be kept in sync by hand
- Files: `README.md`, `AGENTS.md`, `.planning/codebase/*.md`, `docs/index.html`
- Impact: drift risk; stale sections (the codebase map predates the event router and eval benchmark until this refresh)
- Fix approach: keep the map refresh in the release loop (or generate portions of README from AGENTS.md)

## Known Bugs

**No open known bugs** — the suite is green (374 tests) and both recent review cycles (event router, eval benchmark) had their findings fixed before merge. One historical issue fixed in-thread: live mode originally never invoked `modelCall` (dead code); a spy test now guards it.

## Security Considerations

**Repository path confinement:**
- Risk: tools must never escape the configured repo (path traversal, symlink escape)
- Files: `tools/repository.ts`
- Current mitigation: realpath + symlink resolution, `..` and absolute-path rejection, canonical path checks, ignored dirs, 1 MB file cap
- Recommendations: keep the "concurrently-modified checkout" caveat documented (path checks assume a stable tree); no change needed

**Secrets handling:**
- Risk: `GITHUB_TOKEN` / `OPENROUTER_API_KEY` leaking to the model or logs
- Files: `github/client.ts`, `github/adapter.ts`, `scripts/review-pr.ts`, `eval/bench/providers.ts`
- Current mitigation: sandbox removes FS/shell tools; token held only by trusted app code; debug logs never include secrets; `.env` gitignored
- Recommendations: keep env-only injection; never add a config file path for keys

**Event payload trust:**
- Risk: routing decisions driven by untrusted webhook payload fields
- Files: `github/events/payloads.ts`
- Current mitigation: payloads normalized and validated; unknown/malformed events ignored safely; dispatch is decision-only (workflows wire the agent)
- Recommendations: keep agent execution out of the router

## Performance Bottlenecks

**File-store leaderboard scans:**
- Problem: `createFileBenchmarkStore.list()` reads every report JSON under `eval/results/` on each `leaderboard`/`report`/`load` call
- Files: `eval/bench/store.ts`
- Cause: no index; directory walk + parse per call
- Improvement path: cache per-process, or maintain an index file per suite

**TF-IDF index build:**
- Problem: `retrieve` builds the repository index lazily on first call (chunking ~50-line segments up to 2,000 chunks)
- Files: `index/repository-indexer.ts`
- Cause: full-file scan of source + docs on first retrieval
- Improvement path: already mitigated by lazy build + per-process caching; acceptable for the bounded fixture/oak scale

## Fragile Areas

**Capstone decider coupling:**
- Files: `eval/capstone-eval.ts`, `eval/bench/runner.ts`, `eval/benchmarks/sample.json`
- Why fragile: the sample suite's scenario ids must match capstone decider ids, or deterministic `run` throws "No decision function for scenario"
- Safe modification: add scenarios with new ids AND a matching decider; a test (`flue-eval-cli.test.ts`) asserts id parity
- Test coverage: covered for the bundled suite; custom suites are the user's responsibility

**Entrypoint side effects:**
- Files: `eval/capstone-eval.ts`
- Why fragile: module-level `main()` would run on import; guarded by an is-main check (`process.argv[1]` vs `pathToFileURL`)
- Safe modification: keep the guard; add tests if importing other modules for their exports
- Test coverage: the CLI import path is covered by `flue-eval-cli.test.ts`

## Scaling Limits

**Inspection budget:**
- Current capacity: 1–20 tool calls per run (default 8), enforced by `StepBudget`
- Limit: hard ceiling of 20 by design (educational, bounded agent)
- Scaling path: raise `REPO_ASSISTANT_MAX_STEPS` within 1–20; more ambitious workloads need a different budget model

**Search/read bounds:**
- Current capacity: ≤50 search matches, ≤400 read lines, 1 MB files, ≤50 search-result matches
- Limit: fixed by `TOOL_LIMITS` in `tools/contracts.ts`
- Scaling path: these are deliberate safety bounds, not to be raised casually

## Dependencies at Risk

**`@flue/*` v2 (prerelease-style):**
- Risk: Flue 2.0 has no public `maxSteps`/`maxTurns` option; tool-context shape is v2-specific (`data`, `toolCallId`, `log`, `{ output }` envelopes)
- Impact: framework upgrades may change the tool contract; the project already works around missing options by bounding calls itself
- Migration plan: pin to ^2.0.0; on upgrade, re-verify tool invocation (`reliability/tool-invocation.ts`) and agent durability settings

**oxlint/oxfmt via PATH:**
- Risk: not npm devDependencies; resolved from PATH (mise) — a fresh machine without them fails `prek` hooks
- Impact: local lint/format unavailable until installed
- Migration plan: documented in AGENTS.md; no change needed

## Missing Critical Features

**Human acceptance rate:**
- Problem: `humanAcceptanceRate` is stored as NaN — no manual-approval flow exists yet
- Blocks: full ORI-Eval-style human-in-the-loop scoring
- Files: `eval/bench/types.ts`, `eval/bench/metrics.ts`

**Live dispatch of agents:**
- Problem: the event router decides (`agent=<id>`) but nothing executes the agent yet
- Blocks: end-to-end event-driven agent workflows
- Files: `github/events/router.ts`, `scripts/route-event.ts`

## Test Coverage Gaps

**Live provider paths:**
- What's not tested: real model calls via `createOpenAiCompatibleClient` (CI has no key); real `git apply` patch applicability
- Files: `eval/bench/providers.ts`, `eval/bench/patch.ts`
- Risk: provider-response parsing changes could break `--live` without CI notice
- Priority: Low (covered by static-mock unit tests; live runs are opt-in)

**Flue framework integration:**
- What's not tested: the actual `flue run` agent loop with a real model (requires a key)
- Files: `agents/*.ts`
- Risk: harness-specific regressions only surface in live demo runs
- Priority: Low (deterministic tests cover the underlying contracts)

---

*Concerns audit: 2026-08-04*
