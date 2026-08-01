# Technology Stack

**Analysis Date:** 2026-08-01

## Languages

**Primary:**
- TypeScript with strict checking and ES modules. Application code, tools, planning, investigation, reliability, and tests are TypeScript. See `tsconfig.json`, `agents/`, `tools/`, `planner/`, `investigation/`, and `reliability/`.

**Secondary:**
- Markdown for user and agent documentation, evaluation notes, and this map.
- HTML/CSS for the static showcase in `docs/index.html`.
- YAML for GitHub Actions configuration.
- JSON for package metadata, lockfile, and Renovate configuration.
- Shell scripts for deterministic demos and evaluation launchers in `demo/` and `eval/`.

## Runtime

- Node.js `>=22.19.0` is required locally; CI pins Node `24.18.1`. See `package.json` and `.github/workflows/ci.yml`.
- ECMAScript modules are enabled through `package.json` (`"type": "module"`).
- npm is the package manager. The committed lockfile and CI use `npm ci`.

## Frameworks and Build Tools

- **Flue 2.0** (`@flue/runtime`, `@flue/cli`, `@flue/vite`) provides agent hooks, typed tools, model/sandbox/skill integration, routing, CLI execution, and Vite packaging. See `agents/repo-assistant.ts`, `app.ts`, `vite.config.ts`, and `package.json`.
- **Hono** is used by the route map through the Flue runtime dependency tree. See `app.ts`.
- **Vite 8.x** builds the Flue application and packages the imported skill. See `vite.config.ts` and `flue.config.ts`.
- **TypeScript 7.x** runs with `strict`, `noEmit`, ES2024, and bundler module resolution. See `tsconfig.json`.
- **tsx** executes TypeScript tests using Node's native `node:test` runner.

## Runtime Dependencies

- `@flue/runtime` `^2.0.0`: agent runtime, tool definitions, sandbox support, skill loading, and routing.
- `@flue/cli` `^2.0.0`: `flue run` command used by the CLI entrypoint.
- `@flue/vite` `^2.0.0`: Vite integration for Flue agents and skills.
- `just-bash` `^3.1.0`: in-memory sandbox implementation with no model-facing shell tools.
- `valibot` `^1.1.0`: runtime schemas for tool and planning inputs.
- `vite` `^8.2.0`, `tsx` `^4.20.6`, and `typescript` `^7.0.0`: build and development tooling.

## Configuration

**Environment variables:**
- `REPOSITORY_PATH`: configured repository root; defaults to `../oak`.
- `REPO_ASSISTANT_MODEL`: Flue model specifier; defaults to `openrouter/qwen/qwen3-coder`.
- `OPENROUTER_API_KEY`: provider key required by the documented default model.
- `REPO_ASSISTANT_MAX_STEPS`: shared inspection budget, constrained to 1–20 and defaulting to 8.
- `REPO_ASSISTANT_DEBUG`: enables sanitized tool and reliability logs.
- `REPO_ASSISTANT_MAX_ATTEMPTS`, `REPO_ASSISTANT_INITIAL_DELAY_MS`, `REPO_ASSISTANT_MAX_DELAY_MS`, and `REPO_ASSISTANT_TIMEOUT_MS`: reliability policy controls.
- `FAIL_FIRST_N_REQUESTS`, `SIMULATE_TOOL_TIMEOUT`, `SIMULATE_MALFORMED_RESPONSE`, and `FAIL_OPERATION`: deterministic failure-injection/demo controls.

**Build/runtime configuration:**
- `flue.config.ts` targets Node.
- `vite.config.ts` enables the Flue Vite plugin.
- `app.ts` mounts `/agents/repo-assistant` and `/api/ping`.
- `tsconfig.json` includes application and test TypeScript, allows `.ts` imports, and emits nothing.

## Platform Requirements

Development requires Node.js 22.19+, npm dependencies, an LLM provider key for live runs, and a local checkout to inspect. CI runs `npm ci` followed by `npm run check` on Ubuntu. No production hosting or persistent database is configured in this repository.

---

*Stack analysis: 2026-08-01*
