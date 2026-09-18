# Flowly

> AI-native engineering automation for GitHub repositories.

[![CI](https://github.com/jellydn/flowly/actions/workflows/ci.yml/badge.svg)](https://github.com/jellydn/flowly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Flowly is a [Flue](https://flueframework.com/) application with three jobs:

- answer questions about a local repository with file citations;
- review pull requests without approving them; and
- turn labeled GitHub issues into independently reviewed **draft** pull requests.

Flowly runs in your own environment. It is not a hosted service or a one-click GitHub App.

## Choose a path

| Goal | Start here |
| --- | --- |
| Try Flowly without credentials | [Run the demos](#try-it-without-credentials) |
| Ask questions about a local checkout | [Analyze a repository](#analyze-a-repository) |
| Automate issue-to-draft-PR work | [Run the GitHub factory](#run-the-github-factory) |
| Review pull requests | [Run the PR reviewer](#run-the-pr-reviewer) |
| Benchmark models or inspect safety controls | [Read the evaluation guide](./eval/README.md) |

## What Flowly does

### Repository assistant

The repository assistant uses six read-only tools:

- `list_files` — discover repository structure;
- `read_file` — read a bounded line range;
- `search_code` — search source files;
- `search_docs` — search documentation;
- `retrieve` — semantic retrieval over a lazy TF-IDF index; and
- `related_context` — find cited imports, owners, dependencies, linked docs, and issue references.

It collects evidence within a shared inspection budget, then answers with file and line citations. It is not given a shell, write access, Git access, or network access.

### PR reviewer

The PR reviewer reads the diff and relevant repository context, validates findings against changed lines, and posts one GitHub review. It can comment or request changes, but it cannot approve, merge, or modify code.

### GitHub factory

The factory handles this flow:

```text
labeled issue
  → classify
  → plan
  → implement in an isolated clone
  → run repository checks
  → independent review
  → open a draft PR
```

It stops when an issue is not actionable or verification fails. It never auto-approves, auto-merges, deploys, or writes to the source checkout. Factory branches use the `factory/*` prefix.

## Try it without credentials

Requirements: Node.js `>=22.19.0` and npm.

```bash
npm install
npm run demo:repository -- auth
npm run demo:factory
npm run demo:end-to-end
```

These deterministic demos use the bundled fixture. They do not call GitHub, change a repository, or require a model key.

See [demo/README.md](./demo/README.md) for the examples and their shell entrypoints.

## Analyze a repository

Install Flowly and create a local environment file:

```bash
git clone https://github.com/jellydn/flowly.git
cd flowly
npm install
cp .env.example .env
```

Set `OPENROUTER_API_KEY` in `.env`, then point `REPOSITORY_PATH` at the checkout you want to inspect:

```bash
REPOSITORY_PATH=/absolute/path/to/repository \
  npm start -- --input '{"message":"Explain the architecture and cite the files you used."}'
```

The default model is `openrouter/qwen/qwen3-coder`. Set `REPO_ASSISTANT_MODEL` to another model from [Flue's model catalog](https://flueframework.com/models.json).

For a direct Flue invocation:

```bash
npx flue run agents/repo-assistant.ts \
  -m "Find the main application entry point and explain how it starts."
```

`REPOSITORY_PATH` defaults to `../oak` for the example configuration. The assistant only reads the configured checkout.

## Run the GitHub factory

The checked-in workflow is configured for this repository. To use Flowly in another repository:

1. Copy and adapt [`.github/workflows/event-router.yml`](./.github/workflows/event-router.yml) in the target repository.
2. Check out the target repository with full Git history.
3. Make the Flowly source available in a separate directory and run `npm ci` there.
4. Set `REPOSITORY_PATH` to the target checkout and `GITHUB_REPOSITORY` to `owner/repo`.
5. Add `OPENROUTER_API_KEY`, or configure another supported provider.
6. Install the target repository's language and build tools so its verification commands can run.
7. Label an actionable issue `factory` (implementation runs only when autonomy policy evidence or explicit confirmation opens the gate; the default is `plan-only`).

The workflow runs Flowly from its own directory and keeps the target checkout as the repository under test, once the target workflow is adapted with a separate Flowly checkout (or working directory) plus the target checkout. The factory creates an isolated clone for implementation, runs the planner's repository-native checks, and publishes a draft PR only after verification and independent review pass.

Important limits:

- the current production path uses `origin/main` as its factory base ref;
- Flowly does not install itself into the target repository;
- Flowly does not provision toolchains or production credentials; and
- Flowly never approves, merges, or deploys.

The factory autonomy defaults to `plan-only` and only proceeds on explicit policy evidence or confirmation (see `.planning/codebase/ARCHITECTURE.md`); repository memory, graduated autonomy, and migration campaigns are implemented in the factory code and covered by the deterministic safety tests, with design rationale in the [ADRs](./docs/adr/README.md).

## Run the PR reviewer

GitHub Actions supplies these variables in the routed `review` job:

```text
GITHUB_TOKEN
GITHUB_REPOSITORY
PR_NUMBER
BASE_SHA
HEAD_SHA
REPOSITORY_PATH
```

To run it locally:

```bash
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
BASE_SHA=... HEAD_SHA=... REPOSITORY_PATH=. OPENROUTER_API_KEY=... \
  npm run review-pr
```

The reviewer supports full reviews and incremental reviews after new commits. It reads repository guidance from these files when present:

- `AGENTS.md`
- `CONTRIBUTING.md`
- `.github/pull_request_template.md`
- `.flowly/review-instructions.md`
- `.flowly/repository-learnings.md`

The agent may propose repository learnings, but it never writes them automatically.

## GitHub event router

The event router maps GitHub events to configured agent IDs. It decides what should run; the workflow performs the dispatch.

```bash
GITHUB_EVENT_NAME=... \
GITHUB_EVENT_PATH=... \
EVENT_ROUTER_CONFIG=event-router.config.json \
  npm run route-event
```

It supports pull requests, issues, issue comments, pull request reviews, pull request review comments, and workflow runs. Duplicate deliveries can be deduplicated in memory or through `EVENT_ROUTER_STORE`.

The default configuration routes:

- pull request open/reopen/sync/ready-for-review events to `review` (the workflow review job additionally skips drafts, so drafts never trigger review); and
- `issues.labeled.factory` to `factory`.

## Configuration

The most common settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPOSITORY_PATH` | `../oak` | Checkout the assistant may inspect |
| `REPO_ASSISTANT_MODEL` | `openrouter/qwen/qwen3-coder` | Flue model specifier |
| `REPO_ASSISTANT_MAX_STEPS` | `8` | Shared inspection-call limit, from 1 to 20 |
| `REPO_ASSISTANT_DEBUG` | `false` | Log safe tool-call summaries |
| `REPO_ASSISTANT_SEARCH_FALLBACK` | `false` | Fall back from search to a known-path read |
| `GITHUB_TOKEN` | unset | GitHub access for review and factory workflows |
| `GITHUB_REPOSITORY` | unset | Target repository in `owner/repo` form |
| `PR_NUMBER` | unset | Pull request to review |
| `BASE_SHA` / `HEAD_SHA` | unset | Commits that define the PR diff |

PR review limits are separate from the assistant budget:

- `PR_REVIEW_MAX_FILES` — default `30`;
- `PR_REVIEW_MAX_DIFF_LINES` — default `4000`;
- `PR_REVIEW_MAX_CONTEXT_READS` — default `20`; and
- `PR_REVIEW_MAX_FINDINGS` — default `10`.

Reliability settings include `REPO_ASSISTANT_MAX_ATTEMPTS`, `REPO_ASSISTANT_INITIAL_DELAY_MS`, `REPO_ASSISTANT_MAX_DELAY_MS`, and `REPO_ASSISTANT_TIMEOUT_MS`.

Copy `.env.example` to `.env` for the provider configuration. Do not commit `.env` or credentials.

## Safety boundaries

Flowly keeps model decisions separate from trusted mutation code:

- repository inspection is read-only and path-confined;
- files, symlinks, dependencies, generated output, and oversized reads are bounded or skipped;
- factory implementation runs in an isolated clone with no network access;
- trusted adapters control Git and GitHub mutations;
- verification runs have timeouts, bounded output, and command limits;
- factory branches must be `factory/*`;
- independent review receives the issue, acceptance criteria, diff, and verification results, not implementer scratch data; and
- draft publication has no approval or merge path.

Deterministic adversarial checks cover these boundaries. Run them with:

```bash
npm test
```

See [eval/README.md](./eval/README.md) for the `FACTORY-001` through `FACTORY-008` safety catalog and model-evaluation commands.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Typecheck, test, evaluation gate, build, and documentation checks |
| `npm run typecheck` | Run TypeScript checks |
| `npm test` | Run Node's built-in test suite |
| `npm run build` | Build with Vite |
| `npm run eval:repository` | Run seven deterministic repository scenarios |
| `npm run demo:repository` | Run repository-analysis demos |
| `npm run demo:factory` | Inspect factory controls without side effects |
| `npm run demo:end-to-end` | Run indexing, retrieval, citation, and evaluation demo |
| `npm run factory -- runs list` | Inspect persisted factory runs |
| `npm run memory -- list` | Inspect repository instincts |
| `prek run --all-files` | Run the local oxlint and oxfmt hooks |

## Project structure

```text
agents/       Repository assistant, PR reviewer, and factory implementer
factory/      Issue pipeline, capability guards, workspaces, and publisher
github/       GitHub client, review adapter, and event router
review/       Diff parsing, review limits, state, and specialist pipeline
memory/       Opt-in repository instincts from structured outcomes
planner/      Plan, execute, replan, and reflect helpers
reliability/  Retry, timeout, validation, fallback, and safe errors
tools/        Confined repository inspection tools and TF-IDF retrieval
eval/         Deterministic/live benchmarks and security evaluations
demo/         Key-free examples
docs/         Architecture decision records (0001–NNNN) and the static site
  adr/          # architecture decision records (0001–0009)
```

## Development

```bash
npm install
npm run check
```

`npm run check` runs these checks in order:

1. TypeScript typecheck
2. tests
3. deterministic evaluation gate
4. Vite build
5. documentation-tree check

Linting and formatting are managed separately by `prek` and use `oxlint`/`oxfmt` from `PATH`.

## More documentation

- [Runnable examples](./demo/README.md)
- [Evaluation and safety guide](./eval/README.md)
- [Architecture decisions](./docs/adr/README.md)
- [Flue quick start](https://flueframework.com/docs/getting-started/quickstart/)
- [Flue tools](https://flueframework.com/docs/guide/tools/)

## License

MIT
