# Codebase Structure

**Analysis Date:** 2026-08-02

## Directory Layout

```
flue-repo-assistant/
├── .github/workflows/ # CI and automated pull-request review workflows
├── .planning/codebase/ # Generated codebase analysis documents
├── agents/ # Flue agent composition functions and system prompts
├── demo/ # Deterministic investigation and reliability demonstrations
├── docs/ # Static project showcase page
├── eval/ # Live evaluation runner and committed sample repository
├── github/ # Trusted GitHub REST client and review publisher
├── investigation/ # Bounded execution loop, evidence, citations, and answers
├── planner/ # Plan lifecycle, deterministic execution, replanning, reflection
├── reliability/ # Retry, timeout, validation, fallback, and safe logging
├── review/ # PR diff/data/state/schema/tool domain modules
├── scripts/ # Operational CLI orchestration scripts
├── skills/analyzing-repositories/ # Packaged Flue repository-analysis skill
├── tests/ # Node test-runner suites and test helpers
├── tools/ # Confined repository reader and typed inspection tools
├── app.ts # Hono/Flue route map
├── sandbox.ts # Restricted in-memory model sandbox
├── flue.config.ts # Flue Node runtime target
├── vite.config.ts # Vite build with the Flue plugin
├── package.json # Package metadata, dependencies, and task scripts
├── tsconfig.json # Strict no-emit TypeScript configuration
├── prek.toml # Local oxfmt/oxlint pre-commit hooks
├── .env.example # Runtime and review environment-variable reference
├── AGENTS.md # Repository-specific contributor/agent guidance
└── README.md # User-facing setup, architecture, safety, and operation docs
```

## Directory Purposes

**`agents/`:**
- Purpose: Compose each Flue agent's model, tools, sandbox, dependencies, and behavioral prompt.
- Contains: TypeScript agent functions using the `'use agent'` directive.
- Key files: `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`

**`tools/`:**
- Purpose: Implement the only model-facing repository inspection capabilities and their confinement/budget contracts.
- Contains: Repository reader, budget/debug helpers, canonical names/limits, inspection registry, list/read/search tool factories, and shared search implementation.
- Key files: `tools/repository.ts`, `tools/contracts.ts`, `tools/inspection-registry.ts`, `tools/list-files.ts`, `tools/read-file.ts`, `tools/search-code.ts`, `tools/search-docs.ts`, `tools/repository-search.ts`, `tools/search-utils.ts`

**`planner/`:**
- Purpose: Define plan state and support model-facing plus deterministic plan-create/execute/replan/reflect workflows.
- Contains: Lifecycle deep module, compatibility store, schemas/tool factories, deterministic planner, executor, reflection, and types.
- Key files: `planner/plan-run.ts`, `planner/plan-store.ts`, `planner/planner.ts`, `planner/executor.ts`, `planner/reflection.ts`, `planner/types.ts`

**`investigation/`:**
- Purpose: Execute bounded generic tool loops and turn repository outputs into traceable evidence and grounded answers.
- Contains: Execution adapter protocol, normalized tool execution, deterministic investigation loop, duplicate-call tracker, evidence collector, answer formatter, and types.
- Key files: `investigation/tool-call.ts`, `investigation/tool-execution.ts`, `investigation/loop.ts`, `investigation/evidence.ts`, `investigation/answer.ts`, `investigation/call-tracker.ts`, `investigation/types.ts`

**`reliability/`:**
- Purpose: Apply consistent operational safeguards to inspection tools.
- Contains: Structured errors, transient retry/backoff, timeout, Flue invocation normalization, reliable wrappers, result validation, optional fallback, structured observability, and failure injection.
- Key files: `reliability/resilient-tool.ts`, `reliability/retry.ts`, `reliability/errors.ts`, `reliability/tool-invocation.ts`, `reliability/validation.ts`, `reliability/fallback.ts`, `reliability/observability.ts`, `reliability/failure-injection.ts`

**`review/`:**
- Purpose: Encapsulate pull-request review domain logic and trusted read interfaces.
- Contains: Unified-diff parser, file filters, limits, Git-backed PR data source, review schemas/tools, and persistent review state encoding/store.
- Key files: `review/pr-data.ts`, `review/review-tools.ts`, `review/schema.ts`, `review/diff.ts`, `review/filters.ts`, `review/limits.ts`, `review/review-state.ts`, `review/review-state-store.ts`

**`github/`:**
- Purpose: Isolate GitHub credentials, REST calls, output validation, and review mutation from the model.
- Contains: Thin fetch-based API client and trusted review publisher/formatter.
- Key files: `github/client.ts`, `github/adapter.ts`

**`skills/analyzing-repositories/`:**
- Purpose: Package reusable Flue guidance for architecture discovery, cross-file tracing, planning, evidence, citations, and budget discipline.
- Contains: One frontmatter-bearing Markdown agent skill imported directly by the repository assistant.
- Key files: `skills/analyzing-repositories/SKILL.md`

**`scripts/`:**
- Purpose: Provide non-domain orchestration for operational commands.
- Contains: Environment validation and child-process launch of the PR-review agent.
- Key files: `scripts/review-pr.ts`

**`tests/`:**
- Purpose: Verify repository safety, tool contracts, planning/investigation behavior, reliability, and the complete PR-review boundary without requiring a separate test framework.
- Contains: `node:test` TypeScript suites and reusable fixture/tool-context helpers.
- Key files: `tests/helpers.ts`, `tests/tools.test.ts`, `tests/repository.test.ts`, `tests/repository-search.test.ts`, `tests/inspection-registry.test.ts`, `tests/planner.test.ts`, `tests/tool-execution.test.ts`, `tests/doc-aware.test.ts`, `tests/reliability.test.ts`, `tests/eval-scenarios.test.ts`, `tests/review-diff.test.ts`, `tests/review-filters.test.ts`, `tests/review-limits.test.ts`, `tests/review-schema.test.ts`, `tests/pr-data.test.ts`, `tests/review-tools.test.ts`, `tests/review-state.test.ts`, `tests/review-state-store.test.ts`, `tests/github-adapter.test.ts`

**`demo/`:**
- Purpose: Demonstrate system behavior outside the live agent test suite.
- Contains: A deterministic TypeScript doc-aware investigation and shell wrappers for doc-aware and injected-reliability scenarios.
- Key files: `demo/doc-aware-demo.ts`, `demo/doc-aware-demo.sh`, `demo/reliability-demo.sh`

**`eval/`:**
- Purpose: Evaluate model/tool selection against a deliberately small, inspectable target repository.
- Contains: Evaluation documentation/runner and `eval/fixtures/sample-repo/` with source, docs, misleading keywords, local guidance, and an intentionally ignored dependency file.
- Key files: `eval/README.md`, `eval/run-eval.sh`, `eval/fixtures/sample-repo/README.md`, `eval/fixtures/sample-repo/AGENTS.md`, `eval/fixtures/sample-repo/docs/architecture.md`, `eval/fixtures/sample-repo/src/index.ts`, `eval/fixtures/sample-repo/src/auth.ts`, `eval/fixtures/sample-repo/src/config.ts`, `eval/fixtures/sample-repo/src/services/user-service.ts`, `eval/fixtures/sample-repo/src/utils/notes.md`

**`docs/`:**
- Purpose: Host the static public-facing project showcase.
- Contains: A self-contained HTML/CSS marketing and explanatory page.
- Key files: `docs/index.html`

**`.github/workflows/`:**
- Purpose: Automate verification and PR reviews in GitHub Actions.
- Contains: Read-only CI and a permission-scoped, non-draft PR review workflow.
- Key files: `.github/workflows/ci.yml`, `.github/workflows/pr-review.yml`

**`.planning/codebase/`:**
- Purpose: Store generated snapshots of codebase architecture, structure, conventions, integrations, concerns, stack, and testing.
- Contains: Markdown analysis documents used for planning context.
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`, `.planning/codebase/CONVENTIONS.md`, `.planning/codebase/INTEGRATIONS.md`, `.planning/codebase/CONCERNS.md`, `.planning/codebase/STACK.md`, `.planning/codebase/TESTING.md`

## Key File Locations

**Entry Points:**
- `app.ts`: Default Hono application and route map for both agents plus health check.
- `agents/repo-assistant.ts`: General repository-analysis agent invoked by `npm start` or Flue directly.
- `agents/pr-reviewer.ts`: Pull-request review agent with trusted Git/GitHub tools.
- `scripts/review-pr.ts`: Environment-validating CLI launcher behind `npm run review-pr`.
- `demo/doc-aware-demo.ts`: Deterministic, no-LLM investigation executable.
- `eval/run-eval.sh`: Live model-driven evaluation runner.

**Configuration:**
- `package.json`: Defines `build`, `check`, `start`, `review-pr`, `test`, and `typecheck` scripts plus Node >=22.19.0 and Flue/Vite/TypeScript dependencies.
- `.env.example`: Documents repository path, model, inspection/retry/failure-injection settings, provider key, and PR-review environment/limits.
- `vite.config.ts`: Enables `@flue/vite` for development/build packaging.
- `flue.config.ts`: Selects the Node runtime target.
- `tsconfig.json`: Strict ES2024, bundler-resolution, no-emit TypeScript project scopes.
- `.oxfmtrc.json`: Formatting contract used by the system `oxfmt` hook.
- `.oxlintrc.json`: TypeScript/unicorn/oxc lint rules used by the system `oxlint` hook.
- `prek.toml`: Runs oxfmt checks and oxlint locally while excluding `eval/fixtures/`.
- `.github/workflows/ci.yml`: Runs `npm ci` and `npm run check`.
- `.github/workflows/pr-review.yml`: Supplies PR context, scoped GitHub token permissions, model configuration, and review trigger events.
- `AGENTS.md`: Repository architecture, commands, constraints, linting, and contributor guidance.

**Core Logic:**
- `tools/repository.ts`: Repository confinement, read/walk behavior, inspection budget, and debug logging.
- `tools/inspection-registry.ts`: Uniform construction and reliability wrapping of all general inspection tools.
- `planner/plan-run.ts`: Plan lifecycle and deterministic plan execution.
- `investigation/tool-call.ts`: Shared bounded execution-loop protocol.
- `investigation/loop.ts`: Deterministic repository investigation orchestration.
- `reliability/resilient-tool.ts`: Logical-call budget, retry, validation, and safe failure wrapper.
- `review/pr-data.ts`: Trusted Git/GitHub-backed PR read boundary and per-run caches.
- `review/schema.ts`: Structured review and prior-finding classification contract.
- `github/adapter.ts`: Final trusted validation and GitHub review publication boundary.
- `review/review-state-store.ts`: Authenticated hidden-comment persistence for incremental reviews.

**Testing:**
- `tests/*.test.ts`: All automated tests, run by `tsx --test tests/*.test.ts` through `npm test`.
- `tests/helpers.ts`: Shared temporary repository and Flue tool-context helpers.
- `eval/fixtures/sample-repo/`: Committed integration/evaluation fixture deliberately excluded from formatting/lint hooks.
- `demo/reliability-demo.sh`: Manual retry/timeout/malformed-response scenarios.

## Naming Conventions

**Files:**
- Kebab-case for multiword implementation modules: `tools/search-code.ts`, `review/review-state-store.ts`, `reliability/tool-invocation.ts`.
- `<area>.test.ts` for tests: `tests/review-schema.test.ts`, `tests/repository-search.test.ts`.
- Conventional uppercase project guidance/readme names: `README.md`, `AGENTS.md`, `SKILL.md`.
- Tool factories use a matching noun file and `create*Tool` export: `tools/read-file.ts` / `createReadFileTool`, `review/review-tools.ts` / `createSubmitReviewTool`.
- Types/classes use PascalCase and functions use descriptive camelCase; constants use uppercase snake case, as in `RepositoryReader`, `createReviewPublisher`, and `REVIEW_FINDINGS_CEILING`.

**Directories:**
- Lowercase responsibility-based names: `planner/`, `investigation/`, `reliability/`, `review/`, `github/`.
- Nested skill names use kebab-case: `skills/analyzing-repositories/`.
- Test fixture hierarchy mirrors a small real repository under `eval/fixtures/sample-repo/`.

## Where to Add New Code

**New Feature:**
- Primary code: Choose the responsibility boundary: model-facing general inspection in `tools/`, plan/evidence behavior in `planner/` or `investigation/`, reliability policy in `reliability/`, PR semantics in `review/`, and trusted GitHub mutations in `github/`.
- Tests: `tests/<feature-area>.test.ts`; extend `eval/fixtures/sample-repo/` only when a model/tool-selection scenario needs committed sample content.

**New Component/Module:**
- Implementation: Add a focused kebab-case module beside its consumers, such as `tools/<tool-name>.ts`, `review/<domain-name>.ts`, or `reliability/<policy-name>.ts`; wire composition centrally in `tools/inspection-registry.ts` or the relevant file in `agents/` rather than adding model capabilities implicitly.

**Utilities:**
- Shared helpers: Keep domain-neutral repository/search helpers in `tools/`, execution/evidence helpers in `investigation/`, PR-specific helpers in `review/`, and test-only helpers in `tests/helpers.ts`; avoid a generic root-level utility bucket.

## Special Directories

**`dist/`:**
- Purpose: Vite/Flue build output.
- Generated: Yes
- Committed: No

**`node_modules/`:**
- Purpose: Installed npm dependencies.
- Generated: Yes
- Committed: No

**`.planning/codebase/`:**
- Purpose: Generated codebase mapping used as planning documentation.
- Generated: Yes
- Committed: Yes

**`eval/fixtures/sample-repo/`:**
- Purpose: Deliberately tiny repository fixture for safety, search, evaluation, and negative-evidence scenarios.
- Generated: No
- Committed: Yes

**`eval/fixtures/sample-repo/node_modules/`:**
- Purpose: A deliberately committed ignored-dependency sentinel proving repository walks skip dependency directories.
- Generated: No
- Committed: Yes

**`skills/analyzing-repositories/`:**
- Purpose: Flue-packaged skill automatically included by the Vite plugin from its Markdown import.
- Generated: No
- Committed: Yes

**`docs/`:**
- Purpose: Static showcase site suitable for direct hosting.
- Generated: No
- Committed: Yes

**`.github/workflows/`:**
- Purpose: CI and PR-review automation definitions.
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-08-02*
