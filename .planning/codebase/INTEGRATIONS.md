# External Integrations

**Analysis Date:** 2026-08-01

## APIs & External Services

**LLM provider:**
- OpenRouter is the documented default provider through Flue's model specifier `openrouter/qwen/qwen3-coder`. See `.env.example`, `README.md`, and `agents/repo-assistant.ts`.
- SDK/Client: Flue runtime and CLI (`@flue/runtime`, `@flue/cli`), not a provider-specific client in application code. See `package.json` and `agents/repo-assistant.ts`.
- Auth: `OPENROUTER_API_KEY`. See `.env.example`.

**Flue framework services:**
- Flue's model runtime, tool protocol, sandbox lifecycle, skill loading, and agent routing are consumed through `@flue/runtime`. See `agents/repo-assistant.ts`, `sandbox.ts`, and `app.ts`.
- Flue's model catalog is referenced for alternate model specifiers. See `README.md` and `.env.example`.

## Data Storage

**Databases:**
- None in application code. The agent keeps plan state and evidence in memory for one run. See `planner/plan-store.ts`, `investigation/evidence.ts`, and `investigation/loop.ts`.

**File Storage:**
- Local filesystem only: one configured repository checkout is inspected with Node read-only filesystem APIs. See `tools/repository.ts`.
- Repository paths are canonicalized and confined to the configured root; symlinks escaping the root are rejected. See `tools/repository.ts` and `tests/repository.test.ts`.

**Caching:**
- None in application code. Build/runtime artifacts such as `dist/` and `.flue-vite/` are ignored rather than used as application caches. See `.gitignore` and `AGENTS.md`.

## Authentication & Identity

**Auth Provider:**
- No repository-user authentication or identity system is implemented.
- Provider authentication is external and environment-based through `OPENROUTER_API_KEY`. See `.env.example` and `README.md`.

## Monitoring & Observability

**Error Tracking:**
- No external error-tracking service is configured. See `package.json` and `.github/workflows/ci.yml`.

**Logs:**
- Optional safe stderr logs are controlled by `REPO_ASSISTANT_DEBUG`. Tool events include sanitized input, status, counts, and budget snapshots. Reliability logs emit structured JSON without secrets, file contents, or absolute paths. See `tools/repository.ts` and `reliability/observability.ts`.

## CI/CD & Deployment

**Hosting:**
- No production hosting or deployment target is configured in the repository. The static showcase is a checked-in `docs/index.html`, not a deployment pipeline. See `docs/index.html` and `.github/workflows/ci.yml`.

**CI Pipeline:**
- GitHub Actions runs on pushes to `main` and pull requests with read-only contents permission. It installs with `npm ci` and runs `npm run check`. See `.github/workflows/ci.yml`.

## Environment Configuration

**Required env vars:**
- `OPENROUTER_API_KEY` for the documented default model. See `.env.example`.
- `REPOSITORY_PATH` is operationally required to point to an inspectable directory unless the default sibling `../oak` exists. See `agents/repo-assistant.ts` and `tools/repository.ts`.
- `REPO_ASSISTANT_MODEL` is optional because a default is provided. See `agents/repo-assistant.ts`.

**Secrets location:**
- Local `.env`, copied from `.env.example`, is ignored by Git. CI does not run live LLM evaluations. See `.gitignore`, `README.md`, and `eval/README.md`.

## Webhooks & Callbacks

**Incoming:**
- No webhook handlers. The only explicit application routes are the Flue agent route `/agents/repo-assistant` and `/api/ping`. See `app.ts`.

**Outgoing:**
- No application-level webhooks or callbacks. Flue makes model-provider requests through its runtime when the agent is invoked. See `agents/repo-assistant.ts` and `app.ts`.

---

*Integration audit: 2026-08-01*
