# Technology Stack

**Analysis Date:** 2026-08-04

## Languages

**Primary:**
- TypeScript 7.0 — entire project (`agents/`, `tools/`, `investigation/`, `planner/`, `reliability/`, `review/`, `github/`, `index/`, `scripts/`, `eval/`, `demo/`, `tests/`)

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
- tsx 4.23 — TypeScript execution for tests, scripts, demos
- oxlint + oxfmt — lint/format via the `prek` hook manager (PATH-installed, not npm deps)

## Key Dependencies

**Critical:**
- `@flue/runtime` ^2.0.0 — agent loop, tool definitions, session/durability
- `valibot` ^1.1.0 — schema validation for tool inputs, review results, event-router config, benchmark suites
- `just-bash` ^3.1.0 — shell helper used by PR review tooling

**Infrastructure:**
- `@flue/cli` / `@flue/vite` — CLI and build plugin
- `typescript` ^7.0.0 — `tsc --noEmit` typecheck
- `vite` ^8.2.0 — build

## Configuration

**Environment:**
- `.env.example` documents every variable; copy to `.env`
- `REPOSITORY_PATH` (default `../oak`), `REPO_ASSISTANT_MODEL` (default `openrouter/qwen/qwen3-coder`), `REPO_ASSISTANT_MAX_STEPS` (default 8), `REPO_ASSISTANT_DEBUG`, `REPO_ASSISTANT_SEARCH_FALLBACK` (search→read fallback, off by default), reliability vars (`REPO_ASSISTANT_MAX_ATTEMPTS`, `*_DELAY_MS`, `*_TIMEOUT_MS`), failure-injection vars, PR-review vars (`GITHUB_TOKEN`, `PR_NUMBER`, `BASE_SHA`, `HEAD_SHA`, `PR_REVIEW_MAX_*`), event-router vars (`GITHUB_EVENT_NAME/PATH`, `EVENT_ROUTER_CONFIG/STORE/DEBUG`), eval vars (`FLUE_EVAL_RESULTS_DIR`, plus legacy `FLUE_EVAL_API_KEY`/`FLUE_EVAL_BASE_URL` fallbacks — per-model providers/keys/base URLs resolve from the config's `models[]` entries)

**Build:**
- `flue.config.ts` (target `node`), `vite.config.ts` (@flue/vite), `tsconfig.json` (strict, ES2024, ESNext modules, `allowImportingTsExtensions`, `verbatimModuleSyntax`)

## Platform Requirements

**Development:**
- Node.js >= 22.19, an LLM provider key for live runs, and (for lint) `oxlint`/`oxfmt` on PATH via mise

**Production:**
- GitHub Actions (CI, PR review, and optional event-router/eval workflows); no standalone server deployment

---

*Stack analysis: 2026-08-04*
