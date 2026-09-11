# 0007. Isolated factory workspace lifecycle

Date: 2026-09-10

## Status

Accepted

## Context

Factory implementation already clones into an isolated directory, but the clone
was an implementation detail of `FactoryGitAdapter.createWorkspace`. Retries,
concurrent jobs, and abandoned CI runners can leak directories, reuse the wrong
workspace, or delete a live run.

Issue #141 asks for a persisted workspace resource with an explicit lifecycle,
idempotent allocation per run/attempt, recorded hydration refs, suspend/resume
checks, and deterministic garbage collection.

## Decision

`FactoryWorkspaceManager` is the only allocation path for writable factory
workspaces. Each record stores owning run, attempt, repository, branch, path,
base ref/SHA, and lifecycle timestamps. Allocation is idempotent for the same
run/attempt and refuses a silent base-ref change. Use-time checks revalidate
path confinement through the implementer capability profile.

Garbage collection first lists a deterministic candidate set, skips active or
unexpired workspaces, and is idempotent after a partial delete. Lifecycle events
are emitted to an optional sink so later operator observability can record them.

## Consequences

### 📋 Positive

- Workspace identity survives process crashes and duplicate deliveries.
- Failed runs can be retained for debugging without blocking GC of expired ones.
- Cleanup cannot remove another run's active workspace.

### 📋 Negative

- Operators must configure retention; the defaults keep failed workspaces for a
  day, which uses disk until GC runs.
- Resume still depends on the local directory remaining on the same runner.
