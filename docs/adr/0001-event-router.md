# 0001. GitHub event router for agent dispatch

Date: 2026-08-04

## Status

Accepted

## Context

The target architecture requires GitHub events to trigger autonomous agent
workflows: a PR review agent should run on `pull_request` events, a planner on
new issues, a CI-repair agent on failed workflow runs. Before this decision,
`flue-repo-assistant` was pull-only — a single agent answered repository
questions, and no code mapped incoming GitHub events to agent IDs.

Two conflicting needs shaped the design:

1. The mapping must be **configurable** — which event family, action, branch,
   label, or actor dispatches to which agent should not require code changes.
2. The router must be **safe to run in CI** — a malformed config or an
   unsupported event must not crash the workflow, and redelivered webhooks
   must not double-dispatch an agent.

## Decision

Add a dependency-light event router in `github/events/` that maps normalized
GitHub events to configured agent IDs, and nothing else. Agent execution stays
out of scope — the router only decides; a workflow wires the actual dispatch.

Key choices:

- **Declarative JSON config** validated by Valibot with actionable field-path
  issues. Two shapes: a shorthand map (`"pull_request.opened": "review"`,
  `"workflow_run.completed.failure": "ci-fix"`) and an explicit array form
  with `event`/`action`/`agent` plus AND-ed filters (`branch`, `label`,
  `actor`, `repository`, `conclusion`).
- **Normalized event model** (`github/events/types.ts`) with a stable dedupe
  fingerprint, so webhook and GitHub Actions payloads share one internal shape.
- **First-match routing** with filters AND-ed per route.
- **Duplicate-delivery detection**: a memory store for single runs and a
  file-backed store (`EVENT_ROUTER_STORE`) so rerunning a workflow does not
  re-dispatch the same delivery.
- **Safe failure modes**: unsupported or malformed events are ignored (exit 0
  with a structured log line); invalid configs fail with named issues.
- **CLI entrypoint** `scripts/route-event.ts` (`npm run route-event`) reads
  `GITHUB_EVENT_NAME`/`GITHUB_EVENT_PATH`, prints the JSON decision, and writes
  `agent=<id>` to `$GITHUB_OUTPUT` for downstream workflow branching.
- Structured JSON decision logs that never log payload content.

## Consequences

### 📋 Positive

- Event → agent mapping is declarative and reviewable; no code change needed to
  add a route.
- Safe for CI: unsupported events, malformed payloads, and duplicate
  deliveries all fail softly.
- Fully tested (27 tests) and dependency-light (Valibot only), matching the
  codebase's no-heavy-framework convention.
- Payload content and the GitHub token never reach the model — the router runs
  in trusted application code.

### 📋 Negative

- Routing is decision-only: the actual agent invocation (how a workflow turns
  `agent=review` into a running agent) is left to each workflow.
- Three-part shorthand keys (`workflow_run.action.conclusion`,
  `event.action.label`) add a small parsing special case.
- Stacks/grouping require GitHub stacked-PRs enabled on the repository
  (`gh stack submit` exits code 9 otherwise) — unrelated to the router itself
  but a deployment prerequisite for stacked agent workflows.
