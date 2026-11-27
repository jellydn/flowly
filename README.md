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

| Goal                                              | Start here                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Try Flowly without credentials                    | [Run the demos](#try-it-without-credentials)                                  |
| Ask questions about a local checkout              | [Analyze a repository](#analyze-a-repository)                                 |
| Automate issue-to-draft-PR work                   | [Run the GitHub factory](#run-the-github-factory)                             |
| Run the factory in offline VMs on your Mac        | [smolvm executor (experimental)](#run-the-factory-in-smolvm-vms-experimental) |
| Review pull requests                              | [Run the PR reviewer](#run-the-pr-reviewer)                                   |
| Benchmark models or inspect safety controls       | [Read the evaluation guide](./eval/README.md)                                 |
| Prepare an approval-gated Slack operations digest | [Ops digest pilot](./docs/ops-digest.md)                                      |

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

## Run the factory in smolvm VMs (experimental)

> **Experimental and opt-in.** The default executor is `local`. Flowly uses smolvm only when you set `FLOWLY_EXECUTOR=smolvm`. If smolvm is not available, the run stops. It never falls back to `local`.

### What it is and when to use it

The smolvm executor runs the factory implementer tools and the verification commands in [smolvm](https://github.com/smol-machines/smolvm) microVMs on your own Mac. Use it when you run Flowly on a repository or an issue that you trust less, and you want:

- **a fixed cost**: the VMs run on hardware that you already have; there is no usage billing;
- **VM isolation**: each attempt gets a new microVM with its own kernel;
- **no network in the VM**: Flowly never passes `--net` and mounts no host directory; and
- **no tokens in the VM**: the model key, the GitHub token, the agent loop, and Git stay on the host.

[ADR 0010](./docs/adr/0010-vps-pilot-and-provider-policy.md) (VPS pilot) does not change. [ADR 0012](./docs/adr/0012-experimental-sprite-executor.md) records why Flowly does not use Fly.io Sprites: usage billing has no fixed cost limit.

### Requirements

- macOS on Apple silicon (arm64);
- smolvm 1.37.0 or later: `brew install smol-machines/tap/smolvm`;
- Node.js >= 22.19.0 and `npm ci` in the Flowly checkout; and
- a model key on the host, for example `OPENROUTER_API_KEY`.

The guest image needs only `sh` and `tar`. It does not need Git. `node:24-alpine` works.

### Quick start

```bash
brew install smol-machines/tap/smolvm
npm ci
export OPENROUTER_API_KEY=...            # stays on the host
FLOWLY_EXECUTOR=smolvm \
FLOWLY_VM_IMAGE=node:24-alpine \
FACTORY_RUN_STORE=$HOME/.flowly/runs \
FACTORY_AUTONOMY_POLICY=./autonomy-policy.json \
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
GITHUB_EVENT_NAME=issues GITHUB_EVENT_PATH=./event.json \
REPOSITORY_PATH=/path/to/target-checkout \
npm run run-factory
```

The autonomy policy must allow `implement-and-verify`. Without a policy, the run stops at `plan-only`, before any VM starts. See [`factory-autonomy.example.json`](./factory-autonomy.example.json) for the format.

### Configuration

| Variable                                  | Default                                             | Purpose                                                                   |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `FLOWLY_EXECUTOR`                         | `local`                                             | `smolvm` selects the VM executor. Other values fail.                      |
| `FLOWLY_VM_IMAGE` / `FLOWLY_VM_BASE_PACK` | unset                                               | Guest source: an OCI image or a `.smolmachine` pack. Set exactly one.     |
| `FLOWLY_VM_PREFIX`                        | `flowly`                                            | Prefix. VM names are `<prefix>-<repo hash>-<run-id>-a<attempt>`.          |
| `FLOWLY_VM_CPUS`                          | `2`                                                 | vCPUs for each VM (1–8).                                                  |
| `FLOWLY_VM_MEMORY_MB`                     | `4096`                                              | Memory for each VM in MiB (512–16384).                                    |
| `FLOWLY_RUN_TIMEOUT`                      | `1800`                                              | Timeout in seconds for each command in the VM (1–7200).                   |
| `FLOWLY_MAX_ATTEMPTS`                     | `3`                                                 | Maximum attempts for each run (1–10).                                     |
| `FACTORY_RUN_STORE`                       | required                                            | Local run-state directory. The orphan VM sweep reads it at startup.       |
| `FACTORY_AUTONOMY_POLICY`                 | unset (`plan-only`)                                 | Policy file. It must allow `implement-and-verify` for the VMs to run.     |
| `FACTORY_MODEL`                           | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | Model for classification, planning, implementation, and review (on host). |
| `OPENROUTER_API_KEY`                      | unset                                               | Model key. It stays on the host and never goes into a VM.                 |

### Security model

- The model loop runs on the host. Only the tool calls (read, write, shell) go into the VM, through a Flue `SandboxDriver` that is confined to `/work`.
- The VM gets the committed tree as a `git archive` tar. It never gets the `.git` directory, host mounts, or credentials. Flowly refuses to pass environment variables with secret-like names into the VM.
- Before Flowly imports the result, it parses the tar from the VM on the host and fails closed. It refuses absolute paths, `..`, `.git`, hard links, devices, symlinks that leave the tree, new or changed symlinks, macOS AppleDouble entries, and protected paths (`.github/`, `.flowly/`, `.flue/`, `.agents/`, `.gitmodules`, `.gitattributes`).
- Verification runs in a new offline VM, made from the commit that Flowly made on the host.
- Git reads `.gitattributes` and `.gitmodules` in every directory, so Flowly protects them at any depth. The base tree goes into the VM without `export-ignore` or `export-subst` changes.
- The `FACTORY-009` safety evals in `npm test` check these boundaries. See [eval/README.md](./eval/README.md).

### The stop before push

The smolvm path **stops after verification, before `git push` and before PR creation**. It makes no GitHub writes: progress goes to stderr, repository learning is off, and the draft PR publisher refuses, also for a stored run that already reached review. The run ends in `verifying` with the commit and the verification results in the run store. A later PR will remove this stop, but only after approval.

### Recovery and attempt limit

- An implementation lease (30 minutes) makes sure that only one process implements a run at a time. The holder renews it before verification and every 5 minutes while the checks run. A process that lost its lease cannot write results, and it deletes only its own attempt's VMs, never a later attempt's VM.
- After a restart, Flowly reclaims a run only after its lease expires, and only at a phase boundary. It never resumes in the middle of a command.
  - A run in `implementing` starts again with a new clone and a new VM, `-a<N+1>`. Flowly deletes the VMs of earlier attempts first.
  - A run in `verifying` runs verification again. The implementer does not run again.
- When a reclaim goes above `FLOWLY_MAX_ATTEMPTS`, the run goes to `failed` and Flowly deletes its VMs.
- At startup, Flowly deletes the VMs with its prefix that belong to no run with a live lease. It deletes only VMs whose names match `<prefix>-<repo hash>-<UUID>-a<N>`, so it does not touch other tools' VMs or another repository's VMs on the same host. It reads each run again before it deletes its VM.
- Each run has one `factory/*` branch, and each draft PR body has a hidden run marker. The publisher refuses a draft PR without the marker of the run.

### Limits

- Plan for about 4 GB of memory for each VM. One VM runs at a time for each run; use 1–2 VMs on a 32 GB Mac.
- The Mac must stay awake while a run is active (for example, use `caffeinate`).
- You start runs manually. There is no hosted trigger for the smolvm path yet.
- smolvm pulls the image on the host when the VM starts, so the first run takes longer.

### Check it end to end

`scripts/smolvm-e2e.ts` makes a small demo repository with no dependencies and runs the real `run-factory` with `FLOWLY_EXECUTOR=smolvm`. It uses a random dummy `GITHUB_TOKEN`, so no GitHub write is possible. It runs 8 checks: the run stops before push, the run is in `verifying` with a commit, all verification commands pass, the VM of attempt 1 is recorded, no protected path changed, nothing was pushed, no VM of this e2e run remains, and the model key is not in the output. The script uses its own random VM prefix, so it never touches the VMs of other runs.

```bash
OPENROUTER_API_KEY=... FLOWLY_VM_IMAGE=node:24-alpine npx tsx scripts/smolvm-e2e.ts
smolvm machine ls --json | grep -c '"name": *"flowly-' || true   # expect 0
```

Set `KEEP_SMOLVM_E2E=1` to keep the temporary directory.

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

| Variable                         | Default                       | Purpose                                        |
| -------------------------------- | ----------------------------- | ---------------------------------------------- |
| `REPOSITORY_PATH`                | `../oak`                      | Checkout the assistant may inspect             |
| `REPO_ASSISTANT_MODEL`           | `openrouter/qwen/qwen3-coder` | Flue model specifier                           |
| `REPO_ASSISTANT_MAX_STEPS`       | `8`                           | Shared inspection-call limit, from 1 to 20     |
| `REPO_ASSISTANT_DEBUG`           | `false`                       | Log safe tool-call summaries                   |
| `REPO_ASSISTANT_SEARCH_FALLBACK` | `false`                       | Fall back from search to a known-path read     |
| `GITHUB_TOKEN`                   | unset                         | GitHub access for review and factory workflows |
| `GITHUB_REPOSITORY`              | unset                         | Target repository in `owner/repo` form         |
| `PR_NUMBER`                      | unset                         | Pull request to review                         |
| `BASE_SHA` / `HEAD_SHA`          | unset                         | Commits that define the PR diff                |

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

See [eval/README.md](./eval/README.md) for the `FACTORY-001` through `FACTORY-009` safety catalog and model-evaluation commands.

## Useful commands

| Command                        | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `npm run check`                | Typecheck, test, evaluation gate, build, and documentation checks |
| `npm run typecheck`            | Run TypeScript checks                                             |
| `npm test`                     | Run Node's built-in test suite                                    |
| `npm run build`                | Build with Vite                                                   |
| `npm run eval:repository`      | Run seven deterministic repository scenarios                      |
| `npm run demo:repository`      | Run repository-analysis demos                                     |
| `npm run demo:factory`         | Inspect factory controls without side effects                     |
| `npm run demo:end-to-end`      | Run indexing, retrieval, citation, and evaluation demo            |
| `npm run factory -- runs list` | Inspect persisted factory runs                                    |
| `npm run memory -- list`       | Inspect repository instincts                                      |
| `prek run --all-files`         | Run the local oxlint and oxfmt hooks                              |

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
  adr/          # architecture decision records (0001–0012)
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
- [Software factory research and roadmap](./docs/research/software-factories/README.md)
- [Flue quick start](https://flueframework.com/docs/getting-started/quickstart/)
- [Flue tools](https://flueframework.com/docs/guide/tools/)

## License

MIT
