# 11. Project identity and risk-based local and VPS runners

Date: 2026-10-24

## Status

Proposed

## Context

The owner requires local use against any local project, GitHub repository use on
their VPS, and VPS coordination of a connected local runner. Flowly already reads
an arbitrary `REPOSITORY_PATH`, but execution, GitHub destination and state are
configured separately. See the [source audit and design](../research/software-factories/projects-and-runners.md).

[ADR 0010](./0010-vps-pilot-and-provider-policy.md) remains accepted. This record
adds execution placement and project identity, without changing approval, provider
or publication policy. [PR #187](https://github.com/jellydn/flowly/pull/187) supplies
the proposed untrusted execution profile; it is not yet an implemented service.

## Decision

1. Start with an operator-owned registry outside target repositories. Opaque
   project IDs bind runner-local canonical roots; GitHub projects additionally
   bind API host and repository numeric ID to approved clone/push destinations.
   Freeze this identity and base SHA for each attempt before any side effect.
2. Use one job contract in three stages: local-only invocation, one VPS worker,
   then authenticated outbound local-runner polling. No mandatory local daemon,
   inbound runner port, shared network SQLite or multi-user service in the MVP.
3. Select containment by threat. Confined read-only inspection needs neither
   worktrees nor containers. Trusted local writes use managed worktrees by default;
   explicit single-job in-place use can preserve the user's checkout. Trusted host
   commands require operator consent. Concurrent jobs need separate checkouts.
4. Worktrees separate changes but share Git metadata, not a security boundary.
   Untrusted code/checks use private candidate files in a bounded container, never
   the developer's shared Git directory. Stronger threats require a separate VM
   or refusal. Missing containment cannot silently downgrade to host execution.
5. Extend existing workspace/journal contracts with project, runner, attempt and
   fencing identity. Scope artifacts, memory and caches. Stop leased work on runner
   disconnect expiry; reject stale results. Preserve unknown/dirty resources until
   ownership and recovery evidence are reconciled. Do not equate Git worktree locks
   with distributed job leases.
6. Keep Git/provider credentials outside candidate execution. VPS publication uses
   a clean trusted checkout, fixed repository identity and exact tested content.
   A connected runner has no publication authority. Preserve tests-before-push,
   independent review before draft publication, simple operator approval and no
   automatic merge, GitHub approval or deployment.

## Alternatives

- **Arbitrary Git URLs first:** rejected for SSRF, transport and destination
  ambiguity. Registered GitHub repository intake is sufficient for the VPS MVP.
- **Containers for every local action:** adds no useful containment to read-only
  tool access and breaks useful host SDK/device workflows. Keep them optional for
  trusted reproducibility and required for the untrusted native-execution profile.
- **Worktrees as universal isolation:** rejected because common Git metadata,
  host files and credentials remain accessible to host processes.
- **Full remote shell / scheduler:** unnecessary for a single owner. Start with
  one leased job and bounded tool results, adding concurrency only after fencing.

## Consequences

Local inspection stays simple, and existing control-plane/verification modules
remain the source of behavior. Cross-project execution requires admission and
state binding before write support; a new path flag alone is insufficient.
Trusted host execution can damage files or access credentials with that account's
authority. Connected-runner evidence requires trust in the runner, not merely TLS.
Containers retain shared-kernel risk. Source transfer to the VPS/model provider is
explicit. Linux execution is first; other OS capabilities need tested cancellation
and path semantics. This proposed ADR enables no live runner or spending.
