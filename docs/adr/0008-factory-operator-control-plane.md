# 0008. Factory operator control plane

Date: 2026-09-10

## Status

Accepted

## Context

Factory runs persist snapshots in GitHub comments or local JSON, but operators
cannot reconstruct why a run stopped without reading logs. Issue #139 asks for
an append-only event stream, a deterministic projection, and a local inspection
CLI that does not become a hidden context channel or a merge path.

## Decision

Trusted orchestration appends schema-validated `FactoryRunEvent` records as
stages transition. The transition and its events are one atomic factory-run
snapshot. Workspace lifecycle events use the same durable run store. The
operator view is a pure function of those events. Usage fields stay explicitly
unknown when a provider does not report them. Chain-of-thought and raw
transcripts are stripped from metadata at every nesting level.

`npm run factory -- runs list|show|timeline|explain` is the MVP inspection
surface. It reads GitHub issue-comment state by default or `FACTORY_RUN_STORE`
for local development. It cannot merge, approve, deploy, or expand
capabilities.

## Consequences

### 📋 Positive

- Retries keep prior attempt evidence because events are append-only.
- Explain answers use gate reasons and policy versions, not model scratch.
- Observability cannot bypass publication or capability boundaries.

### 📋 Negative

- Historical runs from before this log have no events to project.
- A web dashboard is still out of scope.
