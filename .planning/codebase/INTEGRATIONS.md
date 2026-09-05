# External Integrations

**Analysis Date:** 2026-09-06

## APIs & External Services

**LLM Providers:**

- OpenRouter — default provider for the repo assistant and PR reviewer; also the default base URL for live benchmark runs
- SDK/Client: Flue runtime + thin OpenAI-compatible `fetch` clients (`eval/bench/providers.ts`, `factory/model.ts`)
- Auth: provider-specific environment variables. OpenRouter uses `OPENROUTER_API_KEY`; legacy benchmark settings can use `FLUE_EVAL_API_KEY`.
- Model specifiers come from Flue's models.json; default `openrouter/qwen/qwen3-coder`; PR reviewer default `openrouter/cohere/north-mini-code:free`

**GitHub (REST):**

- PR review data and review submission (`github/client.ts`, `github/adapter.ts`)
- Factory issue comments, branches, commits, pushes, and draft pull requests (`factory/`, `scripts/run-factory.ts`)
- SDK/Client: fetch-based, no official SDK
- Auth: `GITHUB_TOKEN`

## Data Storage

**Databases:**

- None (no database dependency; Flue keeps a local `node_modules/.cache/flue/run.db` runtime cache)

**File Storage:**

- Local filesystem — inspected repository for read-only assistant work, `eval/results/` benchmark reports, optional event-router delivery state, optional local factory-run state, isolated factory clones, and migration-campaign stores
- GitHub issue comments — persistent PR review state and factory run state in hidden bot-authored comments

**Caching:**

- TF-IDF repository index built in memory and cached per process (`index/repository-indexer.ts`, lazy build on first `retrieve`)
- Explicit relationship index built in memory and cached per process (`index/repository-relationship-index.ts`, lazy build on first `related_context`)

## Authentication & Identity

**Auth Provider:**

- Custom / token-based
- Implementation: API keys in env (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `FLUE_EVAL_API_KEY`); the model never receives the GitHub token — trusted application code (`github/adapter.ts`) holds it

## Monitoring & Observability

**Error Tracking:**

- None (no Sentry/DataDog)

**Logs:**

- Structured JSON logs via debug flags: `REPO_ASSISTANT_DEBUG=true` (one safe line per tool call), event-router structured decision logs (`EVENT_ROUTER_DEBUG`), reliability observability events. Logs never include secrets, file contents, or payload content

## CI/CD & Deployment

**Hosting:**

- GitHub Actions only (no long-running server deployment)

**CI Pipeline:**

- GitHub Actions `.github/workflows/ci.yml` — `npm run check` (typecheck + test + deterministic eval gate + build + docs) on push/PR, Node 24.19.0
- `.github/workflows/event-router.yml` — routes supported GitHub events, then runs either the 15-minute PR review job or the 30-minute factory job
- `.github/workflows/event-router.example` and `.github/workflows/eval.example` — inactive examples

## Environment Configuration

**Required env vars:**

- `OPENROUTER_API_KEY` (live runs), `GITHUB_TOKEN` (review workflow; provided by Actions)
- Review: `GITHUB_REPOSITORY`, `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`
- Event router: `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH` (both set by Actions)
- Optional: `REPOSITORY_PATH`, `REPO_ASSISTANT_MODEL`, `REPO_ASSISTANT_MAX_STEPS`, `REPO_ASSISTANT_DEBUG`, `PR_REVIEW_MAX_*`, `EVENT_ROUTER_CONFIG/STORE/DEBUG`, `FACTORY_*`, `FLUE_EVAL_*`

**Secrets location:**

- `.env` (gitignored) locally; GitHub Actions secrets / `secrets.GITHUB_TOKEN` in CI

## Webhooks & Callbacks

**Incoming:**

- GitHub Actions events: `pull_request`, `issues`, `issue_comment`, `pull_request_review`, and `workflow_run` — normalized by the event router (`github/events/`)

**Outgoing:**

- GitHub review submissions via `submit_review` → trusted adapter → REST API
- Factory state comments and reviewed draft PRs on `factory/*` branches; the factory never merges or approves
- `$GITHUB_OUTPUT` dispatch (`agent=<id>`) from the event router

---

_Integration audit: 2026-09-06_
