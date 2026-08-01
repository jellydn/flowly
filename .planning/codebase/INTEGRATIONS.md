# External Integrations

**Analysis Date:** 2026-08-01

## APIs and External Services

**LLM provider:**
- The documented default model is OpenRouter's `openrouter/qwen/qwen3-coder`, selected through Flue's model specifier. See `.env.example`, `README.md`, and `agents/repo-assistant.ts`.
- Application code does not import an OpenRouter SDK; Flue's runtime and CLI perform provider communication.
- Authentication is environment-based through `OPENROUTER_API_KEY`.

**Flue services:**
- `@flue/runtime` supplies model execution, typed tool protocol, sandbox lifecycle, skill loading, durability settings, and agent routing.
- `@flue/vite` packages the agent and imported `skills/analyzing-repositories/SKILL.md` during the build.

## Data Storage

- No database, queue, cache, or persistent application store exists.
- Plan state is held in memory by `planner/plan-run.ts` / `planner/plan-store.ts` for one agent run.
- Investigation evidence is held in memory by `investigation/evidence.ts`.
- Repository content is read from one configured local checkout through Node read-only filesystem APIs in `tools/repository.ts`.

## Repository Boundary

- `RepositoryReader` resolves and confines repository-relative paths, rejects traversal and escaping symlinks, skips VCS/dependency/build/cache directories, rejects oversized/binary reads, and bounds list/search output.
- `tools/repository-search.ts` centralizes source/documentation scope selection and delegates bounded matching to `tools/search-utils.ts`.
- There is no remote repository API, Git integration, shell capability, or write capability exposed to the model.

## Authentication and Identity

- No end-user authentication, authorization, sessions, or identity provider is implemented.
- Provider credentials are supplied externally through `OPENROUTER_API_KEY`.
- The inspected repository is selected by local environment configuration rather than a user account or remote URL.

## Monitoring and Observability

- No external error-tracking or metrics service is configured.
- Optional stderr logging is enabled by `REPO_ASSISTANT_DEBUG`.
- `tools/repository.ts` emits sanitized tool events; `reliability/observability.ts` emits structured retry/fallback events without secrets, file contents, absolute paths, or model reasoning.

## CI/CD and Deployment

- GitHub Actions runs on pushes to `main` and pull requests. CI uses Node `24.18.1`, runs `npm ci`, then `npm run check`. See `.github/workflows/ci.yml`.
- No deployment workflow or hosting target is configured.
- `docs/index.html` is a checked-in static showcase, not an application deployment integration.

## Routes and Callbacks

- `app.ts` exposes `/agents/repo-assistant` through `createAgentRouter(RepoAssistant)`.
- `/api/ping` returns `pong` as a basic health route.
- No application webhooks or outgoing webhook handlers exist.

## Environment and Secrets

- `.env.example` documents provider, repository, budget, debug, retry, timeout, and failure-injection settings.
- `.env` is ignored by Git. CI does not require a live provider key because the automated suite uses deterministic fixtures and injected failures.

---

*Integration audit: 2026-08-01*
