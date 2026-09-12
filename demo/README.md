# Flowly examples

These examples show Flowly's main capabilities before you connect it to your own GitHub
repository. Start with the deterministic examples. They need Node.js 22.19 or newer and
`npm install`, but no model key and no GitHub token.

## Newcomer path

From the Flowly checkout:

```bash
npm install
npm run demo:repository -- auth
npm run demo:factory
npm run demo:end-to-end
```

Expected results:

1. `demo:repository` searches and reads the bundled fixture, then prints a grounded answer,
   citations, confidence, and the tools used.
2. `demo:factory` prints each factory stage's built-in capability limit, workspace retention
   defaults, the security invariant catalog, and a sample operator timeline. It is read-only and
   does not call GitHub, Git, the network, or a model.
3. `demo:end-to-end` builds the TF-IDF index, retrieves evidence, runs inspection tools, prints a
   cited answer, and executes the seven-scenario deterministic evaluation.

Shell entrypoints are also available:

```bash
./demo/repository-analysis.sh auth
./demo/factory-controls.sh
./demo/end-to-end.sh
```

## Examples by feature

| Example | What it shows | Requirements |
| --- | --- | --- |
| `npm run demo:repository` | Bounded repository search, file reads, negative evidence, citations, and confidence | No key |
| `npm run demo:factory` | Least-capability stages, workspace lifecycle, FACTORY-001–008, verification, independent review, draft-only publication, and read-only operator output | No key |
| `npm run demo:end-to-end` | Indexing → retrieval → tool execution → cited answer → evaluation report | No key |
| `./demo/reliability.sh [1-4]` | Live retry, timeout, response validation, and baseline behavior | Provider key |

The deterministic examples use `eval/fixtures/sample-repo`. They demonstrate real Flowly
contracts, but they do not create a branch or pull request. The factory production path is a
GitHub Actions integration with explicit credentials and repository-native verification.

Flowly also includes a read-only PR reviewer, a declarative GitHub event router, opt-in repository
memory from structured outcomes, and approved migration campaigns that pass each batch through the
same factory verification and draft-publication boundary. These are operator-facing capabilities,
not simulated actions in the examples. The [main README](../README.md) documents their configuration
and limits.

## Use your own repository

For read-only analysis, copy `.env.example` to `.env`, set a provider key, and point
`REPOSITORY_PATH` at an absolute local checkout:

```bash
REPOSITORY_PATH=/absolute/path/to/repository \
  npm start -- --input '{"message":"Explain the architecture and cite the files you used."}'
```

The default model needs `OPENROUTER_API_KEY`. Set `REPO_ASSISTANT_MODEL` to use another model from
the Flue catalog.

For issue-to-draft-PR automation, follow
[Use Flowly with any GitHub repository](../README.md#use-flowly-with-any-github-repository). You
must adapt the checked-in workflow, provide the target checkout and credentials, and install its
toolchain. The factory writes only in an isolated clone and a `factory/*` branch. It stops on failed
verification, never approves or merges, and publishes only a draft PR after independent review.

## Next steps

- [Evaluation guide](../eval/README.md): deterministic gates, live model comparisons, custom suites,
  and security invariants.
- [Main README](../README.md): complete configuration, factory policy, operator commands, repository
  memory, migration campaigns, and PR review.
- [Architecture decisions](../docs/adr/README.md): accepted design boundaries and trade-offs.
