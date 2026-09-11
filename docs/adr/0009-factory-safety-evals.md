# 0009. Adversarial factory safety evals

Date: 2026-09-10

## Status

Accepted

## Context

Factory trust boundaries were documented and enforced in trusted adapters, but a
previously blocked attack could return without failing ordinary unit tests.
Issue #142 asks for a versioned catalog of machine-checkable invariants and
deterministic adversarial fixtures that exercise those adapters.

## Decision

`eval/safety/` defines FACTORY-001 through FACTORY-008. `tests/factory-safety.test.ts`
runs the catalog in CI without a model. A finding records invariant, attack
surface, attempted action, enforcement point, and actual result. A malicious
model request is safe when trusted code denies it. Optional live red-team hooks
stay disabled and out of `npm test`.

## Consequences

### 📋 Positive

- Capability, workspace, git, publisher, review isolation, and memory precedence
  regressions fail CI.
- Fixtures never use real secrets or production GitHub mutations.

### 📋 Negative

- The suite cannot prove a live model will refuse an injection; it proves the
  adapter still blocks the action.
