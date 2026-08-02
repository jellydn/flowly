# AGENTS.md

Read-only repository-analysis agent built on Flue 2.0. Two agents: a general repo assistant and a PR reviewer. Both are wired through `app.ts` and built with `vite build`.

## Commands

- `npm start -- --input '{"message":"<question>"}'` — run the repo assistant.
- `npx flue run agents/repo-assistant.ts -m "..."` — invoke Flue directly.
- `npm run review-pr` — run the PR review agent. Requires `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`, and an LLM key. Defaults to the free `openrouter/cohere/north-mini-code:free` model; override with `REPO_ASSISTANT_MODEL`. `submit_review` posts the review.
- `npm run check` — runs `typecheck && test && build` in that exact order. CI runs only this. It does **not** run oxlint/oxfmt.
- `npm test` — `tsx --test tests/*.test.ts` (Node's built-in test runner, not a separate framework).
- `npm run build` — `vite build` (emits `dist/`, already gitignored).
- `prek run --all-files` — runs the repo's linter and formatter (see Lint & format below).

## Lint & format

- `prek.toml` defines two local `system` hooks: `oxfmt` (`oxfmt --check`) and `oxlint` (`oxlint`). Run them with `prek run --all-files`; `prek install` wires the pre-commit shim. `prek` is the hook manager — there is no `npm run lint`/`npm run fmt` script.
- **oxlint and oxfmt are not npm devDependencies** — they resolve from PATH (installed via mise), not `node_modules`. If a hook errors with "command not found", they're missing from PATH.
- `.oxlintrc.json` enables the `typescript`, `unicorn`, and `oxc` plugins with `correctness` as error; unused imports/vars fail the hook.
- `.oxfmtrc.json` is the format contract: 2-space indent, single quotes, semicolons, trailing commas, 100-col width. oxfmt `--check` fails on anything that deviates.
- After editing files, run `oxfmt <paths>` (without `--check`) to normalize them — a partially-formatted edit fails the oxfmt hook.
- Both hooks `exclude = '^eval/fixtures/'` — that fixture repo is deliberately committed unformatted (see Constraints), so a hook failure there is expected and must not be "fixed".
- `npm run check` and CI do not run these — lint/format are enforced locally by prek only.

## Setup & runtime

- Requires **Node.js >= 22.19.0**.
- Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. Default model is `openrouter/qwen/qwen3-coder`; `REPO_ASSISTANT_MODEL` accepts any specifier from Flue's models.json.
- `REPOSITORY_PATH` defaults to `../oak` and is resolved to an absolute, realpath'd directory. Override with an absolute path.

## Architecture

- `agents/repo-assistant.ts` is the only general agent and the entrypoint. It uses the `'use agent'` directive and exports `RepoAssistant()`, which calls hooks (`useModel`, `useTool`, `useSandbox`, `useSkill`) and returns the system prompt synchronously.
- `agents/pr-reviewer.ts` exports `PrReviewer()` and is mounted at `/agents/pr-reviewer` in `app.ts`. It reuses `read_file`/`search_code` with a separate context-read budget, plus review-specific tools in `review/review-tools.ts`.
- `app.ts` is the route map required by `vite build` — mounts both agents via `createAgentRouter`.
- `vite.config.ts` loads the `@flue/vite` plugin for dev/build.
- The four tools in `tools/` (`list-files`, `read-file`, `search-code`, `search-docs`) are created by factory functions in `tools/repository.ts`, which holds the real `RepositoryReader` (path confinement + budgets) and the shared `StepBudget`. The agent uses `createRepositoryReaderSync` because v2 agent render functions are synchronous.
- `sandbox.ts` replaces Flue's default filesystem/shell tools with an empty toolset — repository access exists ONLY through the four custom inspection tools. The agent cannot write, run shell, or touch Git/network.
- The PR reviewer's GitHub/git access is trusted application code, not sandbox tools: `github/client.ts` (fetch-based REST client) and `review/pr-data.ts` (git diff/show via child_process) run inside tool `run` functions. The model never receives the GitHub token or a shell. The trusted `github/adapter.ts` validates the `ReviewResult` (paths in the diff, lines clamped to hunks) before posting.
- `review/schema.ts` is the `ReviewResult` Valibot schema (verdict is `COMMENT` | `REQUEST_CHANGES`, never `APPROVE`; `previousFindingClassifications` optional for incremental reviews with statuses `resolved` | `still-present` | `obsolete` | `uncertain`; `proposedLearnings` optional for repository memory with categories `convention` | `test-command` | `architecture` | `common-issue` | `documentation`). `review/limits.ts` parses `PR_REVIEW_MAX_*` env vars. `review/filters.ts` skips lockfiles/generated/snapshots/vendored/binary files.
- `review/review-state.ts` and `review/review-state-store.ts` implement persistent review state via a PR issue comment whose body contains a hidden HTML block (`<!-- flue-review-state ... -->`) followed by a short visible placeholder line, so the GitHub timeline entry is not blank. The store filters state comments to the expected bot account (`github-actions[bot]` by default, configurable via `REVIEW_BOT_LOGIN`) to prevent spoofing by untrusted PR participants. State persistence is best-effort (non-fatal on failure) to avoid duplicate reviews on retry.
- The PR reviewer reads repository-specific context (`AGENTS.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`, `.flue/review-instructions.md`, `.flue/repository-learnings.md`) via the `get_review_context` tool. The agent never writes to `.flue/` — proposed learnings are rendered in the review body for manual approval.
- `skills/analyzing-repositories/SKILL.md` is loaded via a plain `import ... from '...SKILL.md'` (no import attributes in v2). Flue's Vite plugin validates the frontmatter and packages the skill directory automatically.

## Constraints worth knowing

- Flue v2 has no public `maxSteps`/`maxTurns` agent option. This project bounds **tool inspection calls** (1–20, via `REPO_ASSISTANT_MAX_STEPS`, default 8), NOT model turns. Don't look for a nonexistent maxTurns setting.
- `createRepositoryReaderSync` throws at startup if `REPOSITORY_PATH` isn't a directory; the budget throws "Inspection budget exhausted" after the limit. Both are expected guardrails, not bugs.
- Read tools reject files >1 MB, return ≤400 lines on read, ≤50 matches on search, and skip symlinks / VCS / deps / build output (see `ignoredNames` in `tools/repository.ts`).
- Tool contexts use `data` (not `input`) and require `toolCallId` and `log` fields. Tool run functions return `{ output: value }` envelopes in v2.
- The agent instructions forbid delegation (`task`/subagents) — there are no declared subagent profiles. Don't add them.
- The PR reviewer never auto-approves: `review/schema.ts` restricts `verdict` to `COMMENT` | `REQUEST_CHANGES`. The trusted adapter is the only code that calls the GitHub review API, and it never uses `APPROVE`. The model never sees `GITHUB_TOKEN`.
- `dist/` and `.env` are build/runtime artifacts (gitignored).
