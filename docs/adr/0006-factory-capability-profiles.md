# 0006. Least-capability profiles per factory stage

Date: 2026-09-10

## Status

Accepted

## Context

Factory stages previously relied on prompts and scattered adapter checks to stay
inside their jobs. As connectors, shell, repository memory, and GitHub mutation
grow, a shared tool surface lets prompt injection target unused capabilities,
and operators cannot audit what a run was allowed to do.

Issue #140 asks for a typed capability manifest per stage, enforced by trusted
code at mutation boundaries, with fail-closed resolution and no path to merge,
approve, deploy, or expand credentials through factory configuration.

## Decision

Trusted orchestration resolves a built-in least-capability profile for each
stage (`classifier`, `planner`, `implementer`, `verifier`, `reviewer`,
`publisher`) before that stage runs. An optional policy file may only restrict
the built-in profile. Untrusted issue or repository text is never an input to
resolution.

`factory/capability-guard.ts` checks tools, context sources, network, git,
GitHub actions, and workspace paths at the adapter boundary. The publisher
profile can create a draft PR or comment and cannot expose merge, approval, or
deploy operations. Each run persists the resolved `FactoryCapabilityAudit`.

## Consequences

### 📋 Positive

- Forbidden actions are unavailable at the adapter, not merely discouraged.
- New integrations stay off existing stages until a profile names them.
- Operators can audit the exact policy version and stage manifest for a run.

### 📋 Negative

- Built-in profiles are a second source of truth next to sandbox and git checks.
- A restrictive overlay can disable a stage that a repository still needs; that
  is fail-closed by design and requires a policy change rather than a fallback.
