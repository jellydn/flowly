# Technology Stack

**Analysis Date:** 2026-08-02

## Languages

**Primary:**
- TypeScript 7.0.2 (targeting ES2024) - Strict, no-emit application, agent, tool, GitHub integration, review, script, and test code in `agents/`, `tools/`, `review/`, `github/`, `scripts/`, `tests/`, `sandbox.ts`, and `app.ts`; configured by `tsconfig.json`.

**Secondary:**
- JavaScript/ECMAScript ES2024 - Node.js execution target and emitted bundle semantics configured in `tsconfig.json` and `flue.config.ts`.
- YAML 1.2 - GitHub Actions pipelines in `.github/workflows/ci.yml` and `.github/workflows/pr-review.yml`.
- Shell/POSIX sh - Demo and evaluation launchers under `demo/` and `eval/`.
- Markdown - Project documentation in `README.md`, agent guidance in `AGENTS.md`, and packaged skill instructions in `skills/analyzing-repositories/SKILL.md`.

## Runtime

**Environment:**
- Node.js >=22.19.0; CI uses 24.18.1 in `.github/workflows/ci.yml` and Node 22 in `.github/workflows/pr-review.yml`. The project is ESM via `package.json`, and `flue.config.ts` targets Node.

**Package Manager:**
- npm 12.0.2 in the analysed environment; CI installs reproducibly with `npm ci`.
- Lockfile: present (`package-lock.json`, lockfile version 3)

## Frameworks

**Core:**
- Flue 2.0.1 (`@flue/runtime`, `@flue/cli`, `@flue/vite`) - Agent hooks, typed tools, model selection, sandbox/skill lifecycle, routing, CLI execution, and Vite packaging in `agents/`, `app.ts`, and `vite.config.ts`.
- Hono 4.12.33 (transitive through `@flue/runtime`) - HTTP route map for both agent endpoints and `/api/ping` in `app.ts`.

**Testing:**
- Node.js built-in test runner (Node >=22.19.0) - Executes `tests/*.test.ts`; `tsx` 4.23.1 supplies TypeScript loading via the `npm test` script in `package.json`.

**Build/Dev:**
- Vite 8.2.0 - Builds the Node-targeted Flue application through `@flue/vite` in `vite.config.ts` and emits gitignored `dist/`.
- TypeScript 7.0.2 - Strict static checking with bundler resolution and `noEmit` through `npm run typecheck` and `tsconfig.json`.
- tsx 4.23.1 - Runs TypeScript tests and the PR-review CLI entrypoint in `scripts/review-pr.ts`.
- prek (system installation) - Pre-commit hook manager configured by `prek.toml` for `oxfmt --check` and `oxlint`.
- oxfmt and oxlint (system installations) - Formatting and correctness linting configured by `.oxfmtrc.json` and `.oxlintrc.json`; deliberately exclude `eval/fixtures/`.

## Key Dependencies

**Critical:**
- `@flue/runtime` 2.0.1 - Defines agents/tools, connects models, creates agent routers, and provides sandbox lifecycle APIs used by `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`, `tools/`, `sandbox.ts`, and `app.ts`.
- `valibot` 1.4.2 - Runtime validation for tool inputs, structured review results, and persisted review state in `tools/` and `review/`.
- `just-bash` 3.2.0 - Creates the isolated in-memory session environment while `sandbox.ts` exposes no model-facing shell or filesystem tools.

**Infrastructure:**
- `@flue/cli` 2.0.1 - Runs agents from `npm start` and `npm run review-pr`.
- `@flue/vite` 2.0.1 - Integrates Flue agents and imported skills into the Vite build in `vite.config.ts`.
- Native Node APIs - `node:fs`, `node:path`, `node:child_process`, and global `fetch` implement local repository inspection, trusted Git operations, and GitHub REST calls in `tools/repository.ts`, `review/pr-data.ts`, and `github/client.ts`.

## Configuration

**Environment:**
- Copy `.env.example` to the gitignored `.env`; values are read directly from `process.env` by `agents/repo-assistant.ts`, `agents/pr-reviewer.ts`, `github/client.ts`, and `scripts/review-pr.ts`.
- Key configs required: `REPOSITORY_PATH`, `REPO_ASSISTANT_MODEL`, and the selected LLM provider key (documented default: `OPENROUTER_API_KEY`). PR review additionally requires `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `BASE_SHA`, and `HEAD_SHA`; budgets/reliability are controlled by `REPO_ASSISTANT_MAX_*`, `REPO_ASSISTANT_TIMEOUT_MS`, and `PR_REVIEW_MAX_*` variables documented in `.env.example`.

**Build:**
- `vite.config.ts`, `flue.config.ts`, `tsconfig.json`, `package.json`, `.oxlintrc.json`, `.oxfmtrc.json`, and `prek.toml`.

## Platform Requirements

**Development:**
- Node.js >=22.19.0, npm, Git, a local repository checkout addressed by `REPOSITORY_PATH`, and an LLM provider API key for live agent runs. `oxfmt`, `oxlint`, and `prek` must be available on `PATH` for local lint/format hooks; requirements and commands are documented in `AGENTS.md` and `README.md`.

**Production:**
- Node.js Flue application bundle (`flue.config.ts` target `node`); no production hosting platform is configured. GitHub-hosted Ubuntu runners execute CI and PR-review automation through `.github/workflows/`.

---

*Stack analysis: 2026-08-02*
