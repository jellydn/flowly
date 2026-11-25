# 12. Experimental opt-in Fly.io Sprite executor

Date: 2026-11-24

## Status

Rejected (2026-11-25)

**Reason:** Fly.io Sprites use usage-based billing. It has no fixed cost limit,
and the owner requires a fixed monthly cost. Flowly does not implement this
executor. The rest of this record stays unchanged as a record of the proposal.
The fixed-cost smolvm executor (`factory/smolvm.ts`, experimental) replaces it under [ADR 0010](./0010-vps-pilot-and-provider-policy.md).

## Context

A product proposal (Nov 2026) asked for a Fly.io Sprite execution backend,
Sprites Connector use and crash recovery for the factory. [ADR 0010](./0010-vps-pilot-and-provider-policy.md)
remains accepted: the user's VPS is the pilot host, approval stays simple and
Flowly stays draft-only. The research roadmap lists a runtime adapter as R8, after
the isolation and recovery contracts. This record adds one experimental executor.
It does not replace ADR 0010 or ADR 0011.

Sprites facts that shape the design (Fly.io docs, Nov 2026): egress is open by
default and a DNS-based network policy, set from outside the Sprite, restricts it.
Connectors keep the provider credential in the Sprites gateway
(`api.sprites.dev/v1/gateway/...`). The gateway authorizes the calling **Sprite**,
not a process, by name prefix or labels. Endpoint rules match paths, not HTTP methods.
Checkpoints belong to their Sprite. The Fly.io trial ($1 for 7 days) and the Free
plan both limit an organization to 3 Sprites.

## Decision

1. **Opt-in only.** `FLOWLY_EXECUTOR=sprite` selects the Sprite executor.
   `local` stays the default. An unknown value fails at startup. The executor
   never falls back silently to host execution.
2. **Flowly stays the trusted control plane.** The orchestrator, run store,
   autonomy gates, all model calls, Git commit and `git push`, and independent
   review stay outside the Sprites. Model calls use the orchestrator's existing
   provider key. `git push` uses the orchestrator's `GITHUB_TOKEN` from the
   trusted clone. The OpenRouter connector is not used in the MVP.
3. **Two Sprites per run, no raw tokens in either.** No GitHub, model or Sprites
   token enters a Sprite's environment, files or command arguments.
   - The **worker Sprite** runs the implementer's tool calls and the bounded
     verification commands, through the existing `FactoryImplementer`,
     `FactoryVerifier` and Flue `SandboxDriver` seams. It runs candidate code, so
     it has no connector grant and its network policy denies all egress.
   - The **publisher Sprite** runs only trusted Flowly commands: it reads the
     issue and creates or finds the draft PR through the GitHub connector. Its
     egress is limited to the Connector gateway. The connector policy grants it
     by name prefix and pins endpoints to the one target repository (the issue
     path and `/pulls`). No candidate code or repository content runs in it.
4. **`SPRITES_TOKEN` stays with the orchestrator.**
   - The operator gets the token with `sprite login` or at sprites.dev/account.
     Its format is `org/token-id/secret`.
   - It is stored as an Amp secret in the flowly project. Only the orchestrator
     reads it, to call the Sprites API. It never goes into a Sprite (exec calls
     send an explicit environment without it), logs or persisted run state.
   - When `FLOWLY_EXECUTOR=sprite`, startup checks that the token is present, has
     the `org/token-id/secret` shape and passes one authenticated read call.
     Otherwise the run fails before any side effect, with an error that names
     `SPRITES_TOKEN` and the setup steps but never prints the value.
   - Billing: the $1 trial lasts 7 days. The recommended plan is the Free plan
     with a card ($5 of usage each month, 3 Sprites).
5. **Exact evidence.** The repository enters the worker Sprite from a trusted
   clone at a pinned base SHA. The candidate change returns as a validated diff
   that the trusted clone applies and commits. Verification evidence must match
   the committed tree.
6. **Recovery at phase boundaries only.** On restart, Flowly reconciles the
   persisted run and its Sprites, then continues from the last completed phase.
   It never resumes inside a command: an interrupted phase restarts from its
   checkpoint, within a maximum attempt count. The run branch name and the draft
   PR (found by head branch and a run marker) are the idempotency keys for branch
   creation and PR publication. A deleted or expired Sprite produces an explicit
   recovery error.
7. **Delete each Sprite after its run.**
   - The executor's `cleanup()` deletes the worker and publisher Sprites when the
     run completes or fails.
   - A Sprite stays only while recovery can still resume the run. When the retry
     limit is reached, the run fails and cleanup deletes its Sprites.
   - Cleanup is idempotent and treats "not found" as success.
   - At startup, Flowly deletes orphan Sprites whose names start with
     `FLOWLY_SPRITE_PREFIX` and belong to no active run. With
     `FLOWLY_MAX_CONCURRENT_RUNS=1` and two Sprites per run, this keeps the
     organization under the 3-Sprite limit.
8. **Demo target.** The demo repository has no dependencies and its checks run
   offline, because the worker Sprite has no package registry access.
9. **Unchanged boundaries.** Plan-only default, autonomy gates, `factory/*`
   branches, draft-only publication, no `APPROVE`, no merge and no deployment.

## Consequences

### 📋 Positive

- A hardware-isolated backend for native execution, without a second control plane.
- Credentials stay in the trusted orchestrator or the Connector gateway.
- Local execution and its tests stay unchanged.
- No Sprites remain after a finished run, so cost stays bounded.

### 📋 Negative

- The implementer gets a real shell inside the worker Sprite instead of the
  in-process just-bash emulator. The Sprite VM and its deny-all egress contain it.
- With egress closed, verification cannot install dependencies (see decision 8).
  Real candidate repositories need offline checks or a prepared, trusted base
  checkpoint.
- Connector rules cannot restrict HTTP methods, and the GitHub connector uses an
  OAuth token with broad scopes. Only trusted commands may run in the publisher
  Sprite.
- Checkpoints are deleted with their Sprite, so a run cannot recover after cleanup
  or manual deletion.
- The startup sweep deletes any prefixed Sprite without an active run. Operators
  must not use `FLOWLY_SPRITE_PREFIX` for other Sprites.
- New vendor dependency and cost. Experimental: no production use until a later
  ADR accepts it.
