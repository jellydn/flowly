# Technology Stack

**Analysis Date:** 2026-08-01

## Languages

**Primary:**
- TypeScript (strict, ES modules) - Agent, tools, planning, investigation, reliability layers, and tests. See `tsconfig.json`, `agents/`, `tools/`, `planner/`, `investigation/`, and `reliability/`.

**Secondary:**
- Markdown - User documentation, the repository-analysis skill, evaluation notes, and this codebase map. See `README.md`, `AGENTS.md`, `skills/analyzing-repositories/SKILL.md`, and `eval/README.md`.
- HTML/CSS - Static project showcase page. See `docs/index.html`.
- YAML - GitHub Actions CI configuration. See `.github/workflows/ci.yml`.
- JSON - Package metadata, lockfile, and Renovate configuration. See `package.json`, `package-lock.json`, and `renovate.json`.

## Runtime

**Environment:**
- Node.js `>=22.19.0` for development and runtime. CI pins Node `24.18.1`. See `package.json` and `.github/workflows/ci.yml`.
- ECMAScript modules via `"type": "module"`. See `package.json`.

**Package Manager:**
- npm, with `package-lock.json` committed and `npm ci` used in CI. See `package-lock.json` and `.github/workflows/ci.yml`.

## Frameworks

**Core:**
- Flue `2.0` (`@flue/runtime`, `@flue/cli`) - Agent runtime, typed tools, model/sandbox/skill hooks, routing, and CLI execution. See `agents/repo-assistant.ts`, `app.ts`, and `package.json`.
- Hono (transitive dependency resolved through the Flue runtime tree; not declared directly in `package.json`) - Lightweight route container used by the Flue v2 route map. See `app.ts`, `package.json`, and `package-lock.json`.

**Testing:**
- Node's built-in `node:test` runner, launched through `tsx`. See `package.json` and `tests/*.test.ts`.

**Build/Dev:**
- Vite `8.x` with `@flue/vite` - Bundles the Flue v2 application and packages the imported skill. See `vite.config.ts`, `flue.config.ts`, and `package.json`.
- TypeScript `7.x` with `tsc --noEmit` - Strict static checking. See `tsconfig.json` and `package.json`.
- `tsx` - Executes TypeScript test files. See `package.json`.

## Key Dependencies

**Critical:**
- `@flue/runtime` `^2.0.0` - Agent hooks, tool definitions, sandbox support, routing, and runtime configuration. See `agents/repo-assistant.ts`, `sandbox.ts`, `app.ts`, and `flue.config.ts`.
- `@flue/cli` `^2.0.0` - `flue run agents/repo-assistant.ts` entrypoint. See `package.json` and `AGENTS.md`.
- `valibot` `^1.1.0` - Runtime schemas for tool and planning inputs. See `tools/*.ts` and `planner/*.ts`.

**Infrastructure:**
- `just-bash` `^3.1.0` - Creates the in-memory Flue session environment while exposing no model-facing shell tools. See `sandbox.ts`.
- `vite` `^8.2.0` and `@flue/vite` `^2.0.0` - Build integration. See `vite.config.ts` and `package.json`.

## Configuration

**Environment:**
- `REPOSITORY_PATH` selects the only checkout the custom tools may inspect; it defaults to `../oak`. See `.env.example`, `agents/repo-assistant.ts`, and `tools/repository.ts`.
- `REPO_ASSISTANT_MODEL` selects the Flue model, defaulting to `openrouter/qwen/qwen3-coder`. See `.env.example` and `agents/repo-assistant.ts`.
- `OPENROUTER_API_KEY` is required by the default provider. See `.env.example` and `README.md`.
- `REPO_ASSISTANT_MAX_STEPS` controls the shared inspection budget from 1–20, default 8. See `.env.example` and `tools/repository.ts`.
- Reliability settings include `REPO_ASSISTANT_MAX_ATTEMPTS`, `REPO_ASSISTANT_INITIAL_DELAY_MS`, `REPO_ASSISTANT_MAX_DELAY_MS`, and `REPO_ASSISTANT_TIMEOUT_MS`. See `.env.example` and `reliability/retry.ts`.
- `REPO_ASSISTANT_DEBUG` enables safe tool/reliability logs; failure-injection variables are demo/test controls. See `.env.example`, `tools/repository.ts`, and `reliability/failure-injection.ts`.

**Build:**
- `flue.config.ts` sets the runtime target to Node.
- `vite.config.ts` enables the `@flue/vite` plugin.
- `tsconfig.json` uses ES2024, bundler resolution, strict checking, no emit, and `.ts` extension imports.
- `app.ts` is the Vite/Flue route map.

## Platform Requirements

**Development:**
- Node.js `>=22.19.0`, npm, an installed dependency tree, an LLM provider key, and a local repository checkout. See `AGENTS.md` and `README.md`.

**Production:**
- Node-targeted Flue application; no deployment platform or persistent service is configured in this repository. CI only runs checks on Ubuntu. See `flue.config.ts` and `.github/workflows/ci.yml`.

---

*Stack analysis: 2026-08-01*
