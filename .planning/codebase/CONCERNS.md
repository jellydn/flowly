# Codebase Concerns

**Analysis Date:** 2026-08-02

## Tech Debt

**Parallel orchestration paths:**
- Issue: Live Flue agents register model-facing tools directly, while deterministic planning and investigation use a separate execution loop. The abstractions share contracts but not the complete runtime path.
- Files: `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`, `investigation/tool-call.ts`, `planner/plan-run.ts`
- Impact: A framework or tool-envelope change can pass deterministic tests yet fail only when a live model invokes an agent.
- Fix approach: Add a provider-independent agent-router smoke test and keep all tool invocation through `reliability/tool-invocation.ts` where Flue v2 context/envelope handling is centralized.

**Large, multi-responsibility modules:**
- Issue: Repository confinement, traversal, budgets, logging, and reader construction share one 341-line module; the GitHub publisher combines validation, diff-line placement, rendering, retries, and state persistence in 306 lines.
- Files: `tools/repository.ts`, `github/adapter.ts`
- Impact: Security-sensitive changes have a broad review surface and unrelated policies can drift together.
- Fix approach: Extract traversal/path policy and review-body formatting into focused modules without changing the trusted boundaries; retain contract tests at the existing public factories.

**Experimental subsystems are production-adjacent but not end-to-end integrated:**
- Issue: Rule-based planning, investigation confidence scoring, and failure injection are substantial parallel implementations; the live assistant prompt describes investigation rules but does not call `runInvestigation()` or `executePlan()`.
- Files: `planner/planner.ts`, `planner/plan-run.ts`, `investigation/loop.ts`, `investigation/answer.ts`, `reliability/failure-injection.ts`, `agents/repo-assistant.ts`
- Impact: Demonstration behavior can be mistaken for live behavior, and fixes may be applied to a path the deployed agent never executes.
- Fix approach: Clearly label exported experimental APIs, either wire them into one production orchestration path or move them under an experimental package, and add architecture tests proving which path each agent uses.

**No outstanding code markers:**
- Issue: The source audit found no TODO, FIXME, HACK, or XXX comments, so deferred work is not tracked close to implementation.
- Files: `agents/`, `github/`, `investigation/`, `planner/`, `reliability/`, `review/`, `tools/`
- Impact: Known compromises are discoverable only through documentation and history, making them easier to lose during refactors.
- Fix approach: Track actionable debt in issues or narrowly scoped comments with an issue reference; do not add generic markers.

## Known Bugs

**Body-only findings disappear from incremental review state:**
- Symptoms: Findings dropped from inline placement are still listed in the posted review body, but are filtered out before state persistence and therefore are not classified on the next synchronize run.
- Files: `github/adapter.ts`, `review/review-state.ts`
- Trigger: Submit a valid finding for a changed binary/deleted file, a path without a usable right-side hunk, or an inline batch rejected with HTTP 422.
- Workaround: Reviewers must manually carry those body-only findings forward; persist all displayed capped findings with placement metadata, not only inline-posted findings.

**Live evaluation can report success despite failed scenarios:**
- Symptoms: The evaluation runner prints “Done” even when every `npm start` invocation fails because each scenario suppresses its exit status with `|| true`.
- Files: `eval/run-eval.sh`, `eval/README.md`
- Trigger: Run `eval/run-eval.sh` with a missing provider key, invalid model, or broken Flue runtime.
- Workaround: Inspect each scenario's logs manually; capture statuses and return non-zero after running all scenarios when any invocation failed.

**Planner classifies broad repository questions as conceptual:**
- Symptoms: Questions containing “what is” or “how does” receive an answer-only plan even when they ask about repository implementation and require evidence.
- Files: `planner/planner.ts`, `tests/planner.test.ts`
- Trigger: Call `createPlan()` with a prompt such as “How does authentication work in this repository?”
- Workaround: The live model can create its own evidence-gathering plan; narrow conceptual detection to explicit non-repository questions or evaluate repository markers first.

## Security Considerations

**Read-only sandbox and prompt-injection boundary:**
- Risk: Untrusted repository or PR text can instruct the model to expose data or mutate GitHub through the review publisher.
- Files: `sandbox.ts`, `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`, `review/review-tools.ts`, `github/adapter.ts`
- Current mitigation: The sandbox exposes no model-facing filesystem or shell tools; repository content is declared data; mutations are limited to a schema-validated `submit_review` adapter.
- Recommendations: Add adversarial prompt-injection integration fixtures and assert that only one validated review mutation is possible; continue keeping credentials outside tool inputs and model context.

**Repository path confinement has a time-of-check/time-of-use window:**
- Risk: A checkout modified concurrently can replace a canonicalized path after `realpath()` but before `open()`, potentially redirecting a read outside the repository.
- Files: `tools/repository.ts`
- Current mitigation: Absolute paths and traversal are rejected, canonical paths must remain under the realpath'd root, directory traversal skips symlinks, files are size-checked, and binary files are rejected.
- Recommendations: Analyze immutable snapshots, or use descriptor-relative/no-follow opens with post-open metadata checks if hostile concurrent mutation is in scope.

**Trusted Git and SHA inputs require workflow integrity:**
- Risk: `BASE_SHA`, `HEAD_SHA`, and the persisted `reviewedHeadSha` are passed as git revision arguments. `execFile` prevents shell injection, but attacker-controlled revision-like values can alter git option parsing or select unintended objects.
- Files: `review/pr-data.ts`, `review/review-state.ts`, `scripts/review-pr.ts`, `.github/workflows/pr-review.yml`
- Current mitigation: Current workflow values come from GitHub event SHAs, state comments are accepted only from an exact configured bot login, and changed-file reads are confined to parsed diff paths.
- Recommendations: Validate all SHAs against a full hexadecimal object-ID pattern and insert `--` where supported; treat `REVIEW_BOT_LOGIN` as trusted deployment configuration.

**GitHub token destination and response handling:**
- Risk: A compromised `GITHUB_API_URL` can receive the bearer token, while API error bodies retained in `GitHubApiError.responseBody` could contain sensitive provider details if later logged.
- Files: `github/client.ts`, `agents/pr-reviewer.ts`, `.github/workflows/pr-review.yml`
- Current mitigation: The token is private to the trusted client, never included in model-facing schemas, requests time out after 30 seconds, and workflow permissions are read-focused plus PR/issue writes.
- Recommendations: Validate the API URL against expected GitHub/GHES origins, never serialize raw error bodies into model/log output, and keep least-privilege workflow permissions.

**Review-state spoofing depends on author identity, not cryptographic integrity:**
- Risk: Any actor able to post as the configured bot can replace hidden state and influence incremental scope/classifications.
- Files: `review/review-state-store.ts`, `review/review-state.ts`
- Current mitigation: State comments require an exact `user.login` match (`github-actions[bot]` by default), malformed state is ignored, and state arrays use the finding schema.
- Recommendations: Bind state to repository/PR and sign it with a deployment secret or validate the stored SHA against repository objects before use.

**Automatic approval is intentionally impossible:**
- Risk: Future schema/client refactors could accidentally expose GitHub's `APPROVE` event even though the policy forbids it.
- Files: `review/schema.ts`, `github/adapter.ts`, `github/client.ts`, `agents/pr-reviewer.ts`
- Current mitigation: Model output only accepts `COMMENT` or `REQUEST_CHANGES`, the trusted adapter maps only those values, and the prompt explicitly forbids approval; only the low-level client type includes `APPROVE` for API completeness.
- Recommendations: Remove `APPROVE` from `GitHubReviewPayload` unless a separate trusted caller needs it, and retain a regression test proving malformed approval output is rejected.

## Performance Bottlenecks

**Full-tree literal search:**
- Problem: Each search recursively lists up to 10,000 entries and reads eligible files sequentially; repeated searches rescan and reread the tree.
- Files: `tools/repository.ts`, `tools/repository-search.ts`, `tools/search-utils.ts`
- Cause: There is no index or candidate cache, and the simple reader intentionally prioritizes bounded confinement over throughput.
- Improvement path: Cache canonical candidate lists per run, stream traversal with early termination, then consider bounded read concurrency or an optional ripgrep/index backend behind the same confinement contract.

**PR diff is materialized and parsed multiple times:**
- Problem: Large diffs are held as strings and parsed in both the PR data source and review publisher; the publisher requests `Number.MAX_SAFE_INTEGER` lines from the cached full diff.
- Files: `review/pr-data.ts`, `review/diff.ts`, `github/adapter.ts`, `agents/pr-reviewer.ts`
- Cause: The data source and publisher own independent caches and interfaces pass text rather than parsed diff objects.
- Improvement path: Share one immutable parsed diff snapshot between data source and publisher, while preserving the 20 MiB git-process buffer and model-facing truncation.

**Review-state comment scan:**
- Problem: Every uncached load fetches pages of issue comments serially, up to 20 requests and 2,000 comments.
- Files: `github/client.ts`, `review/review-state-store.ts`
- Cause: State is stored as an ordinary hidden issue comment and GitHub's list API is paginated.
- Improvement path: Persist the state comment ID externally or use a stable searchable marker/cache; if keeping comments, stop pagination once API ordering and safe newest-first lookup can be guaranteed.

## Fragile Areas

**Reliability wrapper composition:**
- Files: `reliability/resilient-tool.ts`, `reliability/retry.ts`, `reliability/fallback.ts`, `reliability/tool-invocation.ts`, `tools/inspection-registry.ts`
- Why fragile: Budget ownership, retry classification, abort propagation, Flue's `{ output }` envelope, validation, and double-wrap guards must remain aligned across modules.
- Safe modification: Preserve one budget charge per logical call, centralize invocation through `invokeTool()`, and run failure-injection, cancellation, fallback, and registry tests together.
- Test coverage: Deterministic coverage is extensive in `tests/reliability.test.ts` and `tests/inspection-registry.test.ts`, but there is no real provider/runtime timeout test.

**PR diff parsing and comment placement:**
- Files: `review/diff.ts`, `review/pr-data.ts`, `github/adapter.ts`, `review/review-tools.ts`
- Why fragile: Rename/deletion/binary syntax, hunk ranges, right-side GitHub line semantics, truncation, and atomic 422 behavior are tightly coupled.
- Safe modification: Add fixture-first tests for every new diff form and verify both body rendering and inline payloads before changing parser or clamp behavior.
- Test coverage: `tests/review-diff.test.ts`, `tests/pr-data.test.ts`, `tests/review-tools.test.ts`, and `tests/github-adapter.test.ts` cover many cases; real GitHub API contract behavior remains mocked.

**Persistent incremental review state:**
- Files: `review/review-state.ts`, `review/review-state-store.ts`, `review/pr-data.ts`, `github/adapter.ts`
- Why fragile: Comment identity, best-effort writes, force-push fallback, cached state, finding identity, and display/persistence semantics cross four trusted modules.
- Safe modification: Treat the state schema as versioned data, test corrupt/duplicate/old comments and force-pushes, and make displayed-versus-persisted finding policy explicit.
- Test coverage: Unit tests cover parsing, bot filtering, persistence, and fallback, but no concurrent runs or real GitHub pagination/race test exists.

## Scaling Limits

**General repository inspection:**
- Current capacity: 8 inspection calls by default (configurable 1–20), 10,000 walked entries, 500 returned entries, 1,000,000 bytes per file, 400 lines per read, 50 search matches, 30 evidence items, and 500 characters per evidence excerpt.
- Limit: Monorepos, generated-but-relevant trees, files over 1 MB, and cross-cutting questions can be silently truncated or exhaust the budget before corroborating evidence is read.
- Scaling path: Surface truncation prominently to planning, prioritize candidates, cache traversal, and make limits deployment profiles rather than merely raising all ceilings.

**PR review scope:**
- Current capacity: Defaults are 30 changed files, 4,000 diff lines, 20 context reads, and 10 findings; configured maxima are 100 files, 50,000 lines, 100 reads, and 50 findings.
- Limit: Large refactors can receive partial review, while skipped lockfiles/generated/snapshots/vendored/binary files are visible but deliberately not analyzed.
- Scaling path: Partition review deterministically by file groups, merge validated findings once, and report unreviewed files/lines explicitly in the submitted body.

**Git and API payloads:**
- Current capacity: Git subprocess output is capped at 20 MiB; issue-state lookup caps at 2,000 comments; GitHub calls time out at 30 seconds.
- Limit: Very large diffs fail at the process buffer before model-facing truncation, and old state beyond 2,000 comments is treated as absent, causing a full review.
- Scaling path: Stream git output or request per-file diffs, and store state by durable comment ID or external key-value storage.

## Dependencies at Risk

**Flue 2 runtime/CLI/Vite stack:**
- Risk: `@flue/runtime`, `@flue/cli`, and `@flue/vite` use independent caret ranges and rely on framework-specific synchronous agent rendering and tool-context details.
- Impact: A compatible-range update can break build-time skill imports, agent registration, or `data`/`toolCallId`/`log`/`{ output }` semantics without source type errors covering the live path.
- Migration plan: Upgrade the Flue packages as one tested set, pin exact versions for CI reproducibility if upstream churn continues, and run a real `flue run` smoke test in addition to `npm run check`.

**Fast-moving build toolchain:**
- Risk: TypeScript `^7.0.0` and Vite `^8.2.0` are major-version-edge dependencies, while lint/format binaries are external PATH tools rather than locked npm dependencies.
- Impact: Developer and CI environments can disagree, and compiler/plugin behavior may change under a clean install.
- Migration plan: Pin tool versions through `mise`/CI, coordinate Vite with `@flue/vite`, and keep `prek run --all-files` as a required local verification step.

**Default free OpenRouter review model:**
- Risk: `openrouter/cohere/north-mini-code:free` availability, rate limits, output quality, and schema adherence are external and not covered by deterministic tests.
- Impact: PR review jobs may fail, time out, or produce weak reviews despite healthy local code.
- Migration plan: Configure a supported production model via `REPO_ASSISTANT_MODEL`, add provider health telemetry and a tested fallback policy, and periodically run live evaluation scenarios.

**Current dependency audit status:**
- Risk: No known npm advisory was reported on 2026-08-02, but the install resolves 296 total production/development/optional packages and caret ranges permit future drift.
- Impact: Transitive supply-chain or compatibility changes can enter on lockfile updates.
- Migration plan: Keep `package-lock.json`, Renovate review, `npm audit`, and `npm run check`; scrutinize Flue/build-chain transitive changes rather than relying only on advisory counts.

## Missing Critical Features

**No automated live-agent acceptance gate:**
- Problem: CI runs typecheck, deterministic tests, and Vite build, but never invokes either agent through Flue with a model/provider or a protocol-faithful fake.
- Blocks: Confident detection of prompt/tool-selection regressions, provider schema incompatibility, route startup failures, and end-to-end review submission behavior.

**No explicit partial-review disclosure:**
- Problem: File/diff/context/finding caps and skip filters bound work, but the submitted review does not provide a complete machine-derived inventory of scope omitted by truncation or limits.
- Blocks: Reviewers cannot reliably distinguish “no issue found” from “not inspected” on oversized PRs.

**No durable state concurrency control:**
- Problem: Review state is updated in place without an ETag, head-SHA compare-and-swap, or lock; workflow concurrency helps only within one workflow concurrency group.
- Blocks: Safe coordination across reruns, differently configured workflows, or concurrent external invocations without state overwrite races.

## Test Coverage Gaps

**Agent composition and sandbox registration:**
- What's not tested: Real initialization and invocation of `RepoAssistant()`/`PrReviewer()`, route mounting, model tool registration, restricted sandbox behavior, and script-to-Flue orchestration.
- Files: `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`, `sandbox.ts`, `app.ts`, `scripts/review-pr.ts`
- Risk: Flue API drift or accidental tool exposure can pass all unit tests and the build.
- Priority: High

**GitHub REST client integration:**
- What's not tested: Authentication headers, API URL handling, pagination at boundaries, timeout behavior, malformed/empty JSON, and real review/comment endpoint contracts.
- Files: `github/client.ts`, `tests/github-adapter.test.ts`, `tests/review-state-store.test.ts`
- Risk: Production-only API failures, token routing mistakes, or lost state comments.
- Priority: High

**Adversarial path and revision races:**
- What's not tested: Concurrent symlink replacement between canonicalization and open, hostile SHA-like git arguments, immutable checkout assumptions, and filesystem mutation during traversal.
- Files: `tools/repository.ts`, `review/pr-data.ts`, `tests/repository.test.ts`, `tests/pr-data.test.ts`
- Risk: Confinement bypass or incorrect diff/file reads under a hostile or unstable workspace.
- Priority: High

**Large-repository and large-PR behavior:**
- What's not tested: Real performance and user-visible completeness at 10,000 entries, 1 MB files, 20 MiB diffs, 2,000 comments, and configured review ceilings.
- Files: `tools/repository.ts`, `tools/repository-search.ts`, `review/pr-data.ts`, `github/client.ts`, `review/limits.ts`
- Risk: Timeouts, memory spikes, silent truncation, and misleadingly complete answers/reviews.
- Priority: Medium

**Live eval assertions:**
- What's not tested: Actual model tool choices and answer grounding; deterministic scenarios drive tool contracts directly, and the live shell runner suppresses failures.
- Files: `eval/run-eval.sh`, `eval/README.md`, `tests/eval-scenarios.test.ts`
- Risk: Prompt regressions and model behavior changes remain undetected.
- Priority: Medium

---

*Concerns audit: 2026-08-02*
