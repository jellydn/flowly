# Codebase Concerns

**Analysis Date:** 2026-09-06

## Tech Debt

**Documentation has several manual sources of truth:**

- Issue: `README.md`, `AGENTS.md`, `.planning/codebase/`, `.env.example`, and the static pages in `docs/` repeat architecture and operating details.
- Files: `README.md`, `AGENTS.md`, `.planning/codebase/*.md`, `.env.example`, `docs/index.html`
- Impact: workflow names, tool counts, environment variables, and current factory behavior can drift after a feature merge.
- Direction: keep `npm run check:docs` for structural checks and refresh this map after architecture changes. Generate repeated command and environment-variable tables if drift becomes frequent.

**Large orchestration and parsing modules:**

- Issue: several modules combine many policies or parsing cases.
- Files: `eval/capstone-eval.ts`, `index/repository-relationship-index.ts`, `eval/bench/runner.ts`, `scripts/flue-eval.ts`, `review/pr-data.ts`, `reliability/validation.ts`
- Impact: changes have a wide review surface and can couple unrelated behavior.
- Direction: split only at stable domain seams. Good candidates are relationship extractors by source type and benchmark CLI subcommands by command.

**Migration campaigns are a library surface only:**

- Issue: campaign planning, approval, storage, and execution exist, but no npm script or GitHub workflow invokes them.
- Files: `factory/campaign.ts`, `factory/campaign-run.ts`, `factory/campaign-store.ts`, `package.json`, `.github/workflows/event-router.yml`
- Impact: operators need custom code to use the feature.
- Direction: add a small validated CLI only when an operating workflow is defined; keep explicit plan-digest approval.

## Known Bugs

**Repository roots through a parent symlink fail confinement on macOS:**

- Behavior: `RepositoryReader` keeps the configured root spelling but compares resolved child paths against it. On macOS, `os.tmpdir()` commonly returns `/var/...`, whose real path is `/private/var/...`; the child is incorrectly reported as a symlink escape.
- Files: `tools/repository.ts`, `tests/factory-model-adapters.test.ts`
- Evidence: `npx tsx --test tests/factory-model-adapters.test.ts` fails in `plans from selected repository files and native commands` with `Symbolic link escapes the configured repository`.
- Impact: repository inspection can fail for a valid repository reached through a symlinked parent path. The full test run currently passes 568 of 569 tests on macOS because of this case.
- Direction: canonicalize the repository root once in the constructor/factory and use that canonical root for all containment checks. Retain explicit tests for real child symlink escapes.

**The local lint gate is not green on current `main`:**

- Behavior: `prek run --all-files` reports 22 oxlint errors.
- Files: primarily `workspace.ts`, plus `eval/capstone-eval.ts` and `tests/fallback-tool.test.ts`
- Impact: contributors cannot pass the documented pre-commit command without unrelated cleanup.
- Direction: fix the reported unused bindings and unnecessary escapes in a separate source change, then keep `prek run --all-files` green in CI or in a required pre-commit check.

## Operational Constraints

**Production factory defaults to plan-only:**

- Behavior: without `FACTORY_AUTONOMY_POLICY` or a one-run confirmation, the factory stops before implementation. The checked-in workflow does not set either variable.
- Files: `factory/autonomy.ts`, `scripts/run-factory.ts`, `.github/workflows/event-router.yml`, `.env.example`
- Impact: a `factory` label does not, by itself, create a draft PR. This is a safe default but can surprise an operator who expects full automation.
- Direction: document and configure the intended repository policy in the workflow after the team approves its thresholds and maximum autonomy.

**Live services are outside deterministic CI:**

- Behavior: CI does not call a real LLM provider or GitHub API and does not run the actual Flue agent loop.
- Files: `agents/*.ts`, `factory/model-adapters.ts`, `eval/bench/providers.ts`, `github/client.ts`
- Impact: provider response changes, authentication, rate limits, and runtime integration can fail only in live use.
- Direction: retain deterministic contract tests and add a scheduled, low-cost smoke workflow if production usage requires stronger detection.

## Security Considerations

**Two different capability boundaries must stay separate:**

- Risk: the repository assistant is read-only, while the factory implementer can edit and execute commands in an isolated clone.
- Files: `sandbox.ts`, `agents/factory-implementer.ts`, `factory/agent-implementer.ts`, `factory/git.ts`
- Current mitigation: the assistant receives no filesystem or shell tools; the implementer uses root-confined `ReadWriteFs`, no network tools, and cannot publish. Trusted orchestration commits, pushes, and opens only draft PRs after verification and review.
- Recommendation: do not reuse the writable sandbox in the assistant or reviewer. Keep GitHub credentials out of model-facing tools.

**Repository and event content is untrusted:**

- Risk: source files, issue bodies, PR text, and event payloads can contain prompt-injection instructions or malformed paths.
- Files: `agents/factory-implementer.ts`, `review/pr-data.ts`, `github/events/payloads.ts`, `tools/repository.ts`
- Current mitigation: prompts identify repository content as untrusted; payloads and schemas validate edges; realpath and symlink checks confine reads; publication is trusted code.
- Recommendation: keep authorization in code and policy state. Never make a model statement sufficient to pass an autonomy or publication gate.

**Persistent GitHub comments require author filtering:**

- Risk: an untrusted participant could post text that looks like hidden review or factory state.
- Files: `review/review-state-store.ts`, `factory/run-state-store.ts`
- Current mitigation: stores accept state only from the configured bot identity.
- Recommendation: preserve the author check whenever state formats change.

## Performance and Scaling

**Repository indexes scan the tree on first use:**

- Problem: `retrieve` builds a TF-IDF chunk index and `related_context` builds a separate relationship graph. Each scans repository files and caches only for the process lifetime.
- Files: `index/repository-indexer.ts`, `index/repository-relationship-index.ts`, `tools/retrieve.ts`, `tools/related-context.ts`
- Impact: first-call latency and memory grow with repository size; two tools duplicate file reads.
- Direction: acceptable for current bounded use. For large repositories, share an inventory/cache or persist content digests before raising current limits.

**Relationship extraction is intentionally heuristic:**

- Problem: regular expressions parse JavaScript/TypeScript imports, Markdown links, package manifests, CODEOWNERS, and issue references.
- Files: `index/repository-relationship-index.ts`
- Impact: dynamic imports, aliases, non-JavaScript manifests, and complex syntax can be missed. Diagnostics are capped at 50.
- Direction: keep results evidence-cited and best-effort. Add language-aware extractors only for demonstrated repository needs.

**File-backed report listing is linear:**

- Problem: benchmark leaderboard/report operations parse saved result files on demand.
- Files: `eval/bench/store.ts`
- Impact: command latency grows with retained benchmark runs.
- Direction: add a suite index or retention policy if result volume becomes material.

## Dependencies at Risk

**The current lockfile has two fixable transitive advisories:**

- `hono@4.12.33`, through `@flue/runtime@2.0.2`, has moderate denial-of-service and request-handling advisories fixed in `4.12.34`.
- `nanoid@3.3.16`, through Vite → PostCSS, has a high-severity infinite-loop advisory for custom generators with a zero size, fixed in `3.3.18`.
- Files: `package-lock.json`, `package.json`
- Evidence: `npm audit` reports one moderate and one high vulnerability, both with fixes available.
- Direction: update the owning direct dependencies or refresh the lockfile through supported semver ranges, then run `npm run check`. Do not apply a forced major upgrade without review.

## Fragile Areas

**Factory state transitions and retries:**

- Why fragile: GitHub Actions retries can resume `queued` or expired `planning` runs; later side effects must remain idempotent.
- Files: `factory/orchestrator.ts`, `factory/run.ts`, `factory/store.ts`, `factory/run-state-store.ts`, `factory/publisher.ts`
- Safe change rule: add transitions through the orchestrator, retain optimistic versions, and reuse branches/PRs instead of creating duplicates.
- Test coverage: `factory-orchestrator.test.ts`, `factory-run.test.ts`, `factory-store.test.ts`, `factory-publisher.test.ts`

**Campaign ordering and plan approval:**

- Why fragile: file selection, glob matching, topological ordering, batch dependencies, and the plan digest define what a human approved.
- Files: `factory/campaign.ts`, `factory/campaign-digest.ts`, `factory/campaign-run.ts`
- Safe change rule: any semantic plan change must change the digest; execution must reject unapproved plans and block batches after failed dependencies.
- Test coverage: `factory-campaign.test.ts`

**Benchmark scenario lineage:**

- Why fragile: deterministic scenarios need matching deciders, and gate reports depend on suite and corpus digests.
- Files: `eval/capstone-eval.ts`, `eval/bench/runner.ts`, `eval/benchmarks/sample.json`
- Safe change rule: update deciders and expected lineage together; do not bypass the deterministic gate.
- Test coverage: `capstone-eval.test.ts`, `bench-runner.test.ts`, `flue-eval-cli.test.ts`

## Test Coverage Gaps

**No enforced coverage percentage:**

- Files: `package.json`, `tests/`
- Risk: 49 test files cover core behavior, but no statement or branch threshold detects untested additions.
- Priority: Medium. Add coverage only with reviewed exclusions so generated fixtures and integration adapters do not distort the signal.

**No real provider, GitHub, or hosted Actions E2E test:**

- Files: `agents/*.ts`, `factory/agent-implementer.ts`, `factory/model-adapters.ts`, `github/client.ts`
- Risk: local contracts can pass while credentials, network behavior, or workflow permissions fail.
- Priority: Medium for production factory use; low for local deterministic evaluation.

---

_Concerns audit: 2026-09-06_
