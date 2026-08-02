# External Integrations

**Analysis Date:** 2026-08-02

## APIs & External Services

**LLM inference:**
- OpenRouter - Default provider for the repository assistant (`openrouter/qwen/qwen3-coder`) and PR reviewer (`openrouter/cohere/north-mini-code:free`); `REPO_ASSISTANT_MODEL` can select another model/provider from Flue's catalog. Selection occurs in `agents/repo-assistant.ts` and `agents/pr-reviewer.ts`.
- SDK/Client: `@flue/runtime` 2.0.1 and `@flue/cli` 2.0.1; no provider-specific SDK is imported by application code.
- Auth: `OPENROUTER_API_KEY` for the documented defaults, or the credential required by the selected Flue model provider.

**Source control and pull requests:**
- GitHub REST API - Reads PR metadata, posts COMMENT/REQUEST_CHANGES reviews with inline comments, and creates/updates hidden issue comments containing incremental review state through `github/client.ts`, `github/adapter.ts`, and `review/review-state-store.ts`.
- SDK/Client: Custom fetch-based `GitHubClient` in `github/client.ts`; local PR diffs and file snapshots use the system `git` executable from trusted code in `review/pr-data.ts`.
- Auth: `GITHUB_TOKEN`; repository and API endpoint are selected by `GITHUB_REPOSITORY` and optional `GITHUB_API_URL`.

## Data Storage

**Databases:**
- None; no database provider or ORM is configured in `package.json` or application code.
- Connection: None
- Client: None

**File Storage:**
- Local filesystem only - `tools/repository.ts` performs bounded, read-only access to the checkout selected by `REPOSITORY_PATH`; PR file versions are read with trusted `git show` in `review/pr-data.ts`. Persistent review state is stored remotely as a hidden GitHub PR issue comment, not in a database.

**Caching:**
- In-process only - `review/pr-data.ts` caches diff, parsed files, metadata, and review state for one run; `github/adapter.ts` caches parsed diff validation data. No external cache service exists.

## Authentication & Identity

**Auth Provider:**
- Custom service-token authentication; there is no end-user identity or session system.
- Implementation: Flue consumes the selected LLM provider credential from environment variables. `GitHubClient.fromEnv` in `github/client.ts` sends `GITHUB_TOKEN` as a Bearer token and derives owner/repository from `GITHUB_REPOSITORY`; `review/review-state-store.ts` trusts state comments only from `REVIEW_BOT_LOGIN` (default `github-actions[bot]`). Credentials are never exposed through model tool schemas or `sandbox.ts`.

## Monitoring & Observability

**Error Tracking:**
- None; no external error-tracking or metrics service is configured.

**Logs:**
- stderr/console logging only. `REPO_ASSISTANT_DEBUG=true` enables sanitized tool logs in `tools/repository.ts` and structured retry/fallback events in `reliability/observability.ts`; `scripts/review-pr.ts` emits orchestration status. Logs intentionally omit secrets, file contents, absolute repository paths, and model reasoning.

## CI/CD & Deployment

**Hosting:**
- No production host or deployment workflow is configured. The application targets Node via `flue.config.ts`; GitHub-hosted Ubuntu runners host automation jobs only.

**CI Pipeline:**
- GitHub Actions - `.github/workflows/ci.yml` runs `npm ci` and `npm run check` (typecheck, Node tests, Vite build) on pushes to `main` and pull requests. `.github/workflows/pr-review.yml` checks out full Git history and runs the Flue reviewer for non-draft PRs on opened, reopened, synchronize, and ready-for-review events.

## Environment Configuration

**Required env vars:**
- General assistant: `OPENROUTER_API_KEY` for the default OpenRouter model; `REPOSITORY_PATH`, `REPO_ASSISTANT_MODEL`, `REPO_ASSISTANT_MAX_STEPS`, `REPO_ASSISTANT_DEBUG`, retry/backoff/timeout variables, and failure-injection variables are optional/defaulted in `.env.example`.
- PR reviewer: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `BASE_SHA`, and `HEAD_SHA`, plus a key for the configured LLM model. `REPOSITORY_PATH`, `GITHUB_API_URL`, `REVIEW_BOT_LOGIN`, `REPO_ASSISTANT_MODEL`, and `PR_REVIEW_MAX_FILES`, `PR_REVIEW_MAX_DIFF_LINES`, `PR_REVIEW_MAX_CONTEXT_READS`, and `PR_REVIEW_MAX_FINDINGS` are optional/defaulted in code.

**Secrets location:**
- Local secrets belong in gitignored `.env` based on `.env.example`. GitHub Actions supplies `secrets.GITHUB_TOKEN` and `secrets.OPENROUTER_API_KEY` to `.github/workflows/pr-review.yml`; repository/event metadata comes from GitHub Actions context variables.

## Webhooks & Callbacks

**Incoming:**
- GitHub `pull_request` events trigger `.github/workflows/pr-review.yml` for `opened`, `reopened`, `synchronize`, and `ready_for_review`; this is an Actions event trigger, not an application-owned webhook endpoint.
- Flue HTTP routes `/agents/repo-assistant` and `/agents/pr-reviewer`, plus health endpoint `/api/ping`, are mounted in `app.ts`; no public deployment is configured.

**Outgoing:**
- GitHub REST endpoints under `/repos/{owner}/{repo}/pulls/{number}` and `/repos/{owner}/{repo}/issues/...` are called by `github/client.ts` to read PRs, submit reviews, and maintain state comments.
- LLM inference requests are delegated to Flue based on `REPO_ASSISTANT_MODEL`; no generic outgoing webhook integration exists.

---

*Integration audit: 2026-08-02*
