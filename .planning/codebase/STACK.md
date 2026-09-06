# Technology Stack

**Analysis Date:** 2026-09-06

## Languages

**Primary:**

- TypeScript 7.0 — entire project (`agents/`, `tools/`, `investigation/`, `planner/`, `reliability/`, `review/`, `factory/`, `github/`, `index/`, `scripts/`, `eval/`, `demo/`, `tests/`)

**Secondary:**

- Shell (bash) — demo and eval runners (`demo/*.sh`, `eval/run-eval.sh`, `eval/run-capstone-eval.sh`)
- HTML — hand-maintained docs page (`docs/index.html`)
- Markdown — docs, ADRs, skills (`docs/adr/`, `skills/analyzing-repositories/SKILL.md`, `.planning/codebase/`)

## Runtime

**Environment:**

- Node.js >= 22.19.0 (`engines` in `package.json`; CI pins 24.18.1)

**Package Manager:**

- npm (lockfile: `package-lock.json` present)

## Frameworks

**Core:**

- Flue 2.0 (`@flue/runtime`, `@flue/cli`, `@flue/vite`) — agent runtime; agents use the `'use agent'` directive and hooks (`useModel`, `useTool`, `useSandbox`, `useSkill`); built with Vite

**Testing:**

- Node's built-in test runner via `tsx --test tests/*.test.ts` — no separate framework

**Build/Dev:**

- Vite 8.2 (`vite build`, `@flue/vite` plugin) — SSR build emitting `dist/`
- tsx ^4.20.6 — TypeScript execution for tests, scripts, and demos
- oxlint + oxfmt — lint/format via the `prek` hook manager (PATH-installed, not npm deps)

## Key Dependencies

**Critical:**

- `@flue/runtime` ^2.0.0 — agent loop, tool definitions, session/durability
- `valibot` ^1.1.0 — schema validation for tool inputs, review results, event-router config, benchmark suites
- `just-bash` ^3.1.0 — root-confined writable filesystem and shell for the isolated factory implementer

**Infrastructure:**

- `@flue/cli` / `@flue/vite` — CLI and build plugin
- `typescript` ^7.0.0 — `tsc --noEmit` typecheck
- `vite` ^8.2.0 — build

## Configuration

**Environment:**

- `.env.example` documents every variable; copy to `.env`
- `REPOSITORY_PATH` (default `../oak`), `REPO_ASSISTANT_MODEL` (default `openrouter/qwen/qwen3-coder`), `REPO_ASSISTANT_MAX_STEPS` (default 8), `REPO_ASSISTANT_DEBUG`, `REPO_ASSISTANT_SEARCH_FALLBACK` (search→read fallback, off by default), reliability vars (`REPO_ASSISTANT_MAX_ATTEMPTS`, `*_DELAY_MS`, `*_TIMEOUT_MS`), and failure-injection vars
- PR review: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`, `PR_REVIEW_MAX_*`, specialist/advisor settings
- Factory: `FACTORY_MODEL`, `FACTORY_WORKSPACE_ROOT`, `FACTORY_RUN_STORE`, `FACTORY_AUTONOMY_POLICY`, and one-run `FACTORY_CONFIRM_BOUNDARY`
- Event router: `GITHUB_EVENT_NAME/PATH`, `EVENT_ROUTER_CONFIG/STORE/DEBUG`
- Evaluation: `FLUE_EVAL_RESULTS_DIR` and legacy `FLUE_EVAL_*` fallbacks; each configured model can select its own provider, key variable, and base URL

**Build:**

- `flue.config.ts` (target `node`), `vite.config.ts` (@flue/vite), `tsconfig.json` (strict, ES2024, ESNext modules, `allowImportingTsExtensions`, `verbatimModuleSyntax`)

## Platform Requirements

**Development:**

- Node.js >= 22.19, an LLM provider key for live runs, and (for lint) `oxlint`/`oxfmt` on PATH via mise

**Production:**

- GitHub Actions runs CI and the event router. The router dispatches PR review and factory jobs. There is no standalone server deployment in this repository.

---

_Stack analysis: 2026-09-06_
