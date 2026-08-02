# AGENTS.md

Read-only repository-analysis agent built on [Flue](https://flueframework.com/) 2.0. The agent observes a single configured repo via four custom read-only tools, then answers with file/line citations.

## Commands

- `npm start -- --input '{"message":"<question>"}'` — run the agent (wraps `flue run agents/repo-assistant.ts`).
- `npx flue run agents/repo-assistant.ts -m "..."` — invoke Flue directly.
- `npm run review-pr` — run the PR review agent (`scripts/review-pr.ts`). Requires `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`, and an LLM key. The agent's `submit_review` tool posts the review.
- `npm run check` — runs `typecheck && test && build` in that exact order. CI runs only this.
- `npm test` — `tsx --test tests/*.test.ts` (Node's built-in test runner, not a separate framework).
- `npm run build` — `vite build` (emits `dist/`, already gitignored).

## Setup & runtime quirks

- Requires **Node.js >= 22.19.0** (CI pins `24.18.1`). Older Node fails.
- Needs an LLM key: `cp .env.example .env` and set `OPENROUTER_API_KEY` (default model is `openrouter/qwen/qwen3-coder`). `REPO_ASSISTANT_MODEL` accepts any specifier from Flue's models.json.
- `REPOSITORY_PATH` defaults to `../oak` and is resolved to an absolute, realpath'd directory. The inspected repo must be a sibling checkout (README's `parent/{flue-repo-assistant,oak}` layout). Override with an absolute path when targeting another repo.

## Architecture (not obvious from filenames)

- `agents/repo-assistant.ts` is the only agent and the entrypoint. It uses the `'use agent'` directive and exports `RepoAssistant()`, which calls hooks (`useModel`, `useTool`, `useSandbox`, `useSkill`) and returns the system prompt synchronously.
- `agents/pr-reviewer.ts` is the PR review agent. It exports `PrReviewer()` and reuses the read-only `read_file`/`search_code` tools (with a separate file-aware budget) plus review-specific tools in `review/review-tools.ts`. The agent is also mounted at `/agents/pr-reviewer` in `app.ts`.
- `app.ts` is the route map required by `vite build` — mounts the agents via `createAgentRouter`.
- `vite.config.ts` loads the `@flue/vite` plugin for dev/build.
- The four tools in `tools/` (`list-files`, `read-file`, `search-code`, `search-docs`) are created by factory functions in `tools/repository.ts`, which holds the real `RepositoryReader` (path confinement + budgets) and the shared `StepBudget`. The agent uses `createRepositoryReaderSync` because v2 agent render functions are synchronous.
- `sandbox.ts` replaces Flue's default filesystem/shell tools with an empty toolset — repository access exists ONLY through the four custom inspection tools. The agent cannot write, run shell, or touch Git/network.
- The PR reviewer's GitHub/git access is trusted application code, not sandbox tools: `github/client.ts` (fetch-based REST client) and `review/pr-data.ts` (git diff/show via child_process) run inside tool `run` functions. The model never receives the GitHub token or a shell. The trusted `github/adapter.ts` validates the `ReviewResult` (paths in the diff, lines clamped to hunks) before posting.
- `review/schema.ts` is the `ReviewResult` Valibot schema (verdict is `COMMENT` | `REQUEST_CHANGES`, never `APPROVE`). `review/limits.ts` parses `PR_REVIEW_MAX_*` env vars. `review/filters.ts` skips lockfiles/generated/snapshots/vendored/binary files.
- `skills/analyzing-repositories/SKILL.md` is loaded via a plain `import ... from '...SKILL.md'` (no import attributes in v2). Flue's Vite plugin validates the frontmatter and packages the skill directory automatically.

## Constraints worth knowing

- Flue v2 has no public `maxSteps`/`maxTurns` agent option. This project bounds **tool inspection calls** (1–20, via `REPO_ASSISTANT_MAX_STEPS`, default 8), NOT model turns. Don't look for a nonexistent maxTurns setting.
- `createRepositoryReaderSync` throws at startup if `REPOSITORY_PATH` isn't a directory; the budget throws "Inspection budget exhausted" after the limit. Both are expected guardrails, not bugs.
- Read tools reject files >1 MB, return ≤400 lines on read, ≤50 matches on search, and skip symlinks / VCS / deps / build output (see `ignoredNames` in `tools/repository.ts`).
- Tool contexts use `data` (not `input`) and require `toolCallId` and `log` fields. Tool run functions return `{ output: value }` envelopes in v2.
- The agent instructions forbid delegation (`task`/subagents) — there are no declared subagent profiles. Don't add them.
- The PR reviewer never auto-approves: `review/schema.ts` restricts `verdict` to `COMMENT` | `REQUEST_CHANGES`. The trusted adapter is the only code that calls the GitHub review API, and it never uses `APPROVE`. The model never sees `GITHUB_TOKEN`.
- `dist/`, `.flue-vite/`, and `.env` are build/runtime artifacts (gitignored). The `.amp/` dir is unrelated tooling state.
