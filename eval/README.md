# Flowly evaluations

This directory contains deterministic and live checks for Flowly's repository assistant, model
benchmark, and factory trust boundaries. Start with the key-free commands, then use live runs only
when you have configured a provider.

## Directory guide

| Path                    | Purpose                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `repository/`           | Seven deterministic repository-analysis scenarios and a five-scenario live tool-selection runner |
| `framework/`            | Config loading, providers, model loop, judges, metrics, gates, reports, and stores               |
| `suites/`               | Versioned benchmark configurations; `sample.json` is the bundled suite                           |
| `security/`             | FACTORY-001–008 invariant catalog and adversarial runner                                         |
| `fixtures/sample-repo/` | Small repository used by demos and evaluations                                                   |
| `results/`              | Generated benchmark reports; ignored by Git                                                      |

## First run: no key required

From the Flowly checkout:

```bash
npm install
npm run eval:repository
npm run check:eval
```

`eval:repository` runs seven scenarios and reports citation accuracy, retrieval relevance, tool
success, and answer completeness. `check:eval` runs the bundled suite against its versioned gate
without saving a report. Both commands use deterministic decision functions and return a non-zero
exit code on failure.

The equivalent shell entrypoint is `./eval/repository/run-deterministic.sh`.

## Benchmark models

The benchmark CLI uses `eval/suites/sample.json` when no config path is given:

```bash
npm run eval -- run                         # deterministic; saves reports
npm run eval -- gate --no-save              # deterministic gate
npm run eval -- compare                     # compare configured models
npm run eval -- leaderboard --suite capstone
npm run eval -- report <run-id>
npm run eval -- regression <baseline-run-id> <candidate-run-id> --json
npm run eval -- review <run-id> --accept cap-1,cap-2 --reject cap-3
```

A report includes pass count, quality, latency, token usage, cost, tool success, judge rationale,
and SHA-256 suite and repository-corpus lineage. Provider-reported usage and billed cost are used
when available; otherwise the report marks the values as estimated.

### Compare saved model versions

`regression` loads two saved reports from `FLOWLY_EVAL_RESULTS_DIR`. It makes no provider calls
and does not write reports. Exit code 0 means no quality regression, 1 means a regression or
incompatible/missing reports, and 2 means invalid command usage. `--json` prints the checks,
baseline and candidate run IDs, and regressed scenario IDs for CI consumers.

Reports must have matching suite and repository-corpus digests, suite IDs, execution modes,
judges, and non-empty scenario ID sets. Model IDs may differ. Reports without lineage must be
rerun; the command does not guess whether older inputs match. It checks pass rate, quality, and
tool success, including individual scenario losses that aggregate improvements could hide.
There is no loss tolerance. Live scores can vary, so review repeated runs before a model change.
Latency, tokens, cost, optional patch checks, and human verdicts do not affect this regression
check. Use explicit `suite.gate` limits for latency and cost.

For CI, retain the baseline JSON artifact, restore it under the results directory, run the same
suite/corpus with the candidate model, and pass both saved run IDs to `regression`. The existing
key-free `check:eval` remains the default gate; it needs no downloaded artifact or provider key.

### Issue #38 implementation audit

The [original issue](https://github.com/jellydn/flowly/issues/38) has no comments. The initial
framework landed in PRs [#39](https://github.com/jellydn/flowly/pull/39),
[#40](https://github.com/jellydn/flowly/pull/40), and [#41](https://github.com/jellydn/flowly/pull/41).
PR [#45](https://github.com/jellydn/flowly/pull/45) added provider usage and human acceptance;
PRs [#67](https://github.com/jellydn/flowly/pull/67)–[#71](https://github.com/jellydn/flowly/pull/71)
added per-model clients, the live model loop, and CLI judge support. The September 2026 audit
found no open PR or remaining eval branch to reuse.

| Requirement                                  | Current support                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Run, compare, leaderboard, report            | `npm run eval -- …`; Flowly CLI, not a new upstream Flue command                                                                   |
| Configurable suites                          | Validated JSON; YAML is not implemented                                                                                            |
| Multiple providers                           | Provider registry and OpenAI-compatible endpoints, including routed models through OpenRouter                                      |
| Quality, latency, tokens, cost, tool success | Stored per scenario and aggregated; unknown cost is not zero                                                                       |
| Human acceptance                             | Persisted accept/reject verdicts through `review`                                                                                  |
| LLM judge                                    | `--judge-model`; recorded in each report                                                                                           |
| Model-version regression                     | Saved-run `regression` plus versioned absolute `gate` thresholds                                                                   |
| CI integration                               | `npm run check` includes the deterministic gate; optional report artifact example                                                  |
| Patch applicability                          | Programmatic `measurePatch` hook only; the bundled path-reference heuristic does **not** prove a diff applies                      |
| Real issues, PR reviews, coding tasks        | Custom prompts can cover repository questions; dedicated GitHub task ingestion and executable coding benchmarks remain future work |
| Stretch goals                                | Historical reports and CLI leaderboard exist; dashboard, routing recommendations, and hosted sharing remain future work            |

The bundled CLI does not measure patch applicability. Applications that need it must supply a
real validator through `measurePatch`, in an isolated workspace. A passing keyword/path heuristic
must not be used as evidence that a patch applies. Deterministic runs exercise fixed decisions,
not model capability; use live runs for actual model comparisons.

### Live model runs

Copy `.env.example` to `.env`, configure the key required by each `models[]` entry, then run:

```bash
npm run eval -- run eval/suites/sample.json --live
npm run eval -- run eval/suites/sample.json --live \
  --judge-model openrouter/qwen/qwen3-coder
./eval/repository/run-live-tool-selection.sh
```

The bundled suite names OpenRouter, Anthropic, and DeepSeek models. A live run needs the matching
key for every configured model, or a custom suite containing only the providers you configured.
Provider defaults are safe for ordinary suite files. If a reviewed local config uses per-model
`baseUrl` or `apiKeyEnv` overrides, add `--trust-model-overrides`; Flowly rejects those fields
without this explicit operator decision because they control where credentials are sent.
Use `FLOWLY_EVAL_API_KEY` and `FLOWLY_EVAL_BASE_URL` as product-wide fallbacks, and
`FLOWLY_EVAL_RESULTS_DIR` to change the report directory. The former `FLUE_EVAL_*` names remain
supported as legacy fallbacks, but new configuration should use `FLOWLY_EVAL_*`.
The tool-selection script points the live repository assistant at the bundled fixture and prints
safe debug lines so you can compare observed tool calls with the expected patterns.

Live model output is non-deterministic and is not part of the default CI gate. The optional
[evaluation workflow](../.github/workflows/eval.example) shows how to retain generated reports.

## Use another repository or suite

Copy `eval/suites/sample.json` and change:

- `suite.id`, `name`, and `description`;
- `suite.repositoryPath` to the checkout to inspect;
- each scenario's prompt, expected sources, expected keywords, and tool/citation requirements;
- `suite.gate` thresholds; and
- `models[]` provider, model ID, and optional `apiKeyEnv` or `baseUrl`.

Live mode supports new scenario IDs directly. Deterministic mode requires a matching decision
function in `eval/repository/scenarios.ts`; it rejects an unknown ID instead of inventing behavior.
Run a custom gate with `npm run eval -- gate path/to/suite.json --no-save`.

## Repository-tool scenarios

The five live tool-selection prompts cover direct reads, search followed by read, structure
discovery, negative search, and a conceptual answer that needs no tool. Their contracts are tested
deterministically in `tests/eval-scenarios.test.ts`. Search results are treated as leads; a model
must read relevant files before it makes a code claim. Negative results must not become fabricated
features.

The fixture is intentionally small. It includes authentication and configuration code, supporting
documentation, and misleading payment keywords in a notes file. Dependency noise under
`node_modules/` must be ignored.

## Factory security evaluations

`security/` is the versioned factory trust-boundary catalog. Deterministic attacks run in
`tests/factory-safety.test.ts` as part of `npm test`. That file also imports the optional
model-backed hooks in `security/live.ts`; those hooks stay disabled by default, so CI does
not execute the live model calls.

| ID          | Invariant                                            |
| ----------- | ---------------------------------------------------- |
| FACTORY-001 | Issue text cannot grant a new tool                   |
| FACTORY-002 | Repository content cannot authorize network access   |
| FACTORY-003 | The implementer cannot write outside its workspace   |
| FACTORY-004 | The implementer cannot push a non-`factory/*` branch |
| FACTORY-005 | The reviewer cannot receive implementer scratch data |
| FACTORY-006 | The publisher cannot approve or merge                |
| FACTORY-007 | Repository memory cannot override policy             |
| FACTORY-008 | Path and symlink tricks cannot escape confinement    |

These checks cover capability manifests, path confinement, workspace ownership, review evidence
isolation, and draft-only publication. They do not claim that a model or workflow is safe without
the trusted enforcement code and repository-specific verification.

## Related guides

- [Runnable examples](../demo/README.md)
- [Use Flowly with any GitHub repository](../README.md#use-flowly-with-any-github-repository)
- [Factory controls and operator commands](../README.md#controlled-factory-implementation)
- [Architecture decisions](../docs/adr/README.md)
