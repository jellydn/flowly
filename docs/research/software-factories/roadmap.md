# Deliver safety and recovery before runtime choice

[Research index](./README.md) · [Security findings](./security.md) · [MVP contract](./target-and-mvp.md)

Priorities: **P0** blocks unattended native execution; **P1** blocks the proposed
recoverable pilot; **P2** is an experiment after evidence exists. Complexity:
**S** = one module/contract, **M** = a few modules with integration tests,
**L** = cross-boundary behavior requiring fault injection. These are engineering
estimates, not dates or staffing commitments. Each item can land disabled without
enabling dependent functionality.

The repository issue inventory was checked before proposing these items. Do not
duplicate completed #94, #119, #121, #138–#142 or #168. Open eval UI/sharing/routing
issues #154–#156 remain separate; none solves the factory execution boundaries.

| ID  | Priority / size | Deliverable                                                  | Depends on                                                      |
| --- | --------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| R1  | P0 / M          | Isolate native verification from host files and credentials  | None; extends #140/#168                                         |
| R2  | P0 / M          | Keep candidate Git metadata out of trusted Git execution     | None; extends #140/#141                                         |
| R3  | P1 / L          | Transactional single-worker run/effect journal               | None; extends #139                                              |
| R4  | P1 / S          | Document and test simple operator approval                   | None; preserve existing gates                                   |
| R5  | P1 / M          | Mandatory checks bound to candidate and policy               | R1; extends existing verification                               |
| R6  | P1 / M          | Restore candidate evidence after worker loss                 | R2, R3, R5                                                      |
| R7  | P1 / M          | Reproducible pilot and factory outcome accounting            | R1–R6 for live pilot; accounting can land earlier               |
| R8  | P2 / M          | One optional runtime adapter comparison                      | R7; same R1–R6 safety contract                                  |
| R9  | P2 / M          | Trusted capability package discovery specification           | R4 and demonstrated user need; no executable package rollout    |
| R10 | P1 / M          | Validate optional ChatGPT subscription access alongside BYOK | R1/R2 before live candidate execution; not a BYOK pilot blocker |

## R1 — Isolate native verification from host files and credentials

**Owner modules:** `factory/verification.ts`, `factory/capability-guard.ts`,
`tests/factory-verification.test.ts`, factory execution configuration.
**Why:** S1; OpenHands/SWE-agent show a separate execution backend, while Flowly
already has network denial that must be preserved.

Acceptance criteria:

- [ ] A disposable execution backend has private HOME/tmp/PID space, no host
      credentials/socket mounts, resource/time/output limits and denied egress.
- [ ] Harmless host/sibling canaries cannot be read or written; DNS/TCP/local
      sockets are denied. Timeout/cancel removes child processes.
- [ ] A real offline test command succeeds. Missing isolation support fails
      closed with an actionable error, never falls back to host execution.
- [ ] Dependency preparation uses a pinned image/lockfile in a separate bounded
      step; candidate scripts cannot use preparation credentials or network.
- [ ] Existing network-denial and verification regression tests remain valid.

Non-goals: replacing the implementer, adding a cloud sandbox vendor, enabling
autonomy. Rollout: opt-in verifier backend, plan-only unchanged.

## R2 — Keep candidate Git metadata out of trusted Git execution

**Owner modules:** `agents/factory-implementer.ts`, `factory/git.ts`,
`factory/agent-implementer.ts`, workspace lifecycle and Git safety tests.
**Why:** S2; preserve branch/remote checks while enforcing the metadata boundary.

Acceptance criteria:

- [ ] Agent-writable files exclude Git metadata; a validated diff enters a fresh
      trusted checkout for commit/publication, including safe path/symlink rules.
- [ ] Trusted Git ignores candidate hooks, filters, helpers and config includes;
      tests use harmless execution canaries and assert no host effect.
- [ ] Explicit environment allowlists keep GitHub/provider secrets out of native
      candidate execution; only scoped publication operations receive credentials.
- [ ] Normal multi-file changes retain exact tested content and can only update
      the owned `factory/*` branch. Wrong remote/head fails closed.

Non-goals: broad Git abstraction rewrite, merge permission, token rotation in
production. Rollout: behavior-preserving publication interface with stronger inputs.

## R3 — Add a transactional single-worker run/effect journal

**Owner modules:** `factory/store.ts`, `factory/run-state-store.ts`,
`factory/orchestrator.ts`, `factory/events.ts`, `factory/publisher.ts`.
**Why:** S3; SSSF/Ultimate persistence patterns support explicit state/effect
records. `ops-digest/store.ts` provides a local SQLite precedent.

Acceptance criteria:

- [ ] Implement an opt-in SQLite store behind `FactoryRunStore`, with unique run
      revision keys and atomic snapshot/event updates. Preserve existing readers.
- [ ] Two processes racing the same expected version produce one winner; expired
      leases fence the old worker. Tests use real processes, not one in-memory lock.
- [ ] Record effect intent before push/PR creation; after ambiguous response,
      reconcile exact remote identity before retrying. Conflicting state stops.
- [ ] Fault injection after remote success but before local save creates no second
      draft or lost event; replay exposes `uncertain` rather than false success.
- [ ] GitHub comments are an explicitly documented mirror for this mode, not the
      lock authority. VPS persistent mounts, encrypted off-host backups, separate
      secret recovery, retention and schema migration are documented. A disposable
      restore test demonstrates recovery; no existing VPS backup is assumed.

Non-goals: distributed database, multi-host scheduler, general exactly-once claims.
Accepted host: the user's VPS, one supervised worker (ADR 0010).

## R4 — Document and test simple operator approval

**Owner modules:** operator docs, `factory/autonomy.ts`, existing factory
autonomy/pipeline tests. **Why:** S4 is an accepted trusted-operator risk for the
single-owner VPS pilot, not a requirement to add a receipt service.

Acceptance criteria:

- [ ] Document existing plan-only/default autonomy and trusted operator boundary
      confirmation on the user's VPS; issue/model text cannot grant authority.
- [ ] Preserve push-after-successful-checks and independent review before draft
      publication. Do not require review-before-push or exact-commit human approval.
- [ ] Show effective policy, decision reason and review findings in existing
      operator evidence. Red-review drafts remain permitted under configured policy.
- [ ] Existing public-behavior tests cover plan-only denial, allowed draft
      publication and no automatic GitHub approval, merge or deployment.
- [ ] Document residual risk: branches may be remote before review fails;
      trusted operator confirmation is not a multi-user identity service.

Non-goals: actor/digest/expiry receipts, a new approval UI, changes to push order,
or broad policy rewrites. No dependency on R2/R3 is needed for this scoped work;
their safety/recovery work remains required independently for the live MVP.

## R5 — Require trusted checks for the exact candidate

**Owner modules:** `factory/plan.ts`, `factory/implementation.ts`,
`factory/verification.ts`, persisted evidence schema and pipeline tests.
**Why:** S5; borrow SSSF's explicit acceptance distinction, not unchecked agent claims.

Acceptance criteria:

- [ ] Owner policy at the pinned base defines mandatory checks; a plan may add
      checks but cannot remove or replace mandatory ones with trivial commands.
- [ ] Evidence records command identity, policy/image/base/candidate digests,
      exit/timeout and duration. Any relevant change invalidates cached evidence.
- [ ] Candidate changes to check definitions require explicit review; a passing
      modified test script alone cannot erase a required acceptance criterion.
- [ ] Failed/missing checks block publication. Configured GitHub checks are
      observed against exact PR head before declaring it human-ready.
- [ ] Existing memory remains lower-priority context and cannot add authority.

Non-goals: automatic test generation as a replacement for required checks,
generic CI workflow engine. R1 supplies execution isolation.

## R6 — Restore candidate evidence after worker loss

**Owner modules:** `factory/workspace-lifecycle.ts`, `factory/workspace-store.ts`,
`factory/implementation.ts`, factory entrypoint and workspace integration tests.
**Why:** local lifecycle already exists (#141); extend it beyond one runner.

Acceptance criteria:

- [ ] Save a bounded, digest-addressed candidate patch/bundle and base identity
      without credentials, hooks, untracked secrets or raw model scratch.
- [ ] A second disposable worker with no original directory restores the same
      candidate, verifies ownership/digest, and reruns or reuses only valid checks.
- [ ] Missing/corrupt artifacts, changed base and stale fencing fail closed.
      Concurrent restore cannot adopt another run's files.
- [ ] GC respects active leases and artifact retention; interrupted deletion is
      idempotent. Cancellation leaves enough bounded evidence for explanation.
- [ ] Document persistent-worker and ephemeral-worker differences; do not claim
      Actions recovery until its artifact transport is wired and tested.

Non-goals: migrating full agent conversations or vendor-specific sandbox images.

## R7 — Measure the recoverable MVP on held-out tasks

**Owner modules:** `factory/events.ts`, `scripts/factory.ts`, `eval/framework/`,
existing factory integration/safety tests and demo documentation.
**Why:** use SWE-agent's reproducible environment/evidence discipline and current
Flowly eval infrastructure before comparing runtimes.

Acceptance criteria:

- [ ] Add deterministic fault scenarios for each recovery row in the MVP spec;
      they use real disposable storage/Git/process boundaries where relevant.
- [ ] Record reported vs estimated vs unknown model cost, compute cost inputs,
      stage/end-to-end time, retries and human interventions. Unknown is not zero.
- [ ] Distinguish draft delivery, exact-head CI, and human accept/reject/pending.
      Cost per acceptance includes all failed/cancelled attempts.
- [ ] Publish a reproducible 10-task × 3-attempt pilot configuration, pinned
      fixtures and raw results; no runtime or provider is declared better without data.
- [ ] Run on the user's VPS only after separate live-run authorization. BYOK is
      supported; subscription access requires R10 validation. Record access mode,
      retention/budget, target repository and branch protections. No silent paid fallback.
- [ ] One authorized live slice reaches one draft and a recorded human verdict
      without Flowly merge, approval, ready-for-review mutation or deployment.
      No mandatory review-before-push or exact-commit human receipt is added.

Non-goals: the dashboards/sharing/routing work in existing #154–#156.

## Deferred experiments: R8 and R9

**R8, one runtime adapter:** extend the existing implementer seam with version,
capability negotiation, cancel/deadline, opaque resume handle and usage. Start
with Codex CLI or OpenCode after a dedicated compatibility test; keep Flue the
default. Acceptance: both runtimes pass identical denial/cancellation/recovery
tests, return the same bounded evidence schema, and publish no GitHub mutations
themselves. Compare the same held-out corpus and report acceptance/cost/time and
human effort. Do not promise session portability between runtimes. Depends on R7;
complexity M. Open an implementation issue only after the pilot establishes need.

**R9, capability discovery:** specify a small, versioned catalog with package
digest, provenance, owner approval and stage capabilities; use Kody's search/execute
pattern without adopting its platform or copying FSL code. Acceptance: unapproved
package/version cannot execute, memory cannot grant capability, and scheduled
jobs use the same admission/approval/effect keys as manual work. No production
loader or scheduler in this item. Depends on R4 and demonstrated demand; complexity M.

## R10 — Validate optional ChatGPT subscription access alongside BYOK

**Priority/size:** P1 / M, required only before enabling the subscription route.
**Owner modules:** provider/runtime configuration, credential boundary, existing
provider tests and operator docs. Depends on R1/R2 before live candidate execution;
does not block the BYOK pilot or require adopting a new coding runtime.

Acceptance criteria:

- [ ] Document the selected supported client/protocol, account/workspace eligibility,
      applicable terms and permitted workload. Distinguish SIWC from Codex-managed
      auth; do not reuse HermesHub's fixed client ID without authorization.
- [ ] In a separately authorized private trial, verify completed inference,
      token renewal, revocation/expiry, cancellation and quota exhaustion. Do not
      infer entitlement from login or a static model catalog.
- [ ] Isolate credentials from candidate files/processes/logs; test redaction and
      serialized refresh ownership. Persist refreshed state securely; document
      re-authentication and encrypted backup/recovery without publishing tokens.
- [ ] Record provider/model/access mode and billed/estimated/unknown costs. BYOK
      remains available; paid fallback requires explicit opt-in. No quota bypass.
- [ ] Keep the subscription route disabled when validity is unknown. Preserve
      simple approval, draft-only publication and no auto-merge/no-deploy.

Non-goals: a hosted shared subscription proxy, account sharing, credential UI,
or production suitability claims based only on source inspection.

## GitHub tracking

Created after checking open and closed issues on 2026-10-24:

| Roadmap item                         | GitHub issue                                         |
| ------------------------------------ | ---------------------------------------------------- |
| R1: verifier isolation               | [#177](https://github.com/jellydn/flowly/issues/177) |
| R2: trusted Git boundary             | [#178](https://github.com/jellydn/flowly/issues/178) |
| R3: transactional state/effects      | [#179](https://github.com/jellydn/flowly/issues/179) |
| R4: simple operator approval         | [#180](https://github.com/jellydn/flowly/issues/180) |
| R5: mandatory exact-candidate checks | [#181](https://github.com/jellydn/flowly/issues/181) |
| R6: worker-loss recovery             | [#182](https://github.com/jellydn/flowly/issues/182) |
| R7: measured MVP                     | [#183](https://github.com/jellydn/flowly/issues/183) |
| R10: subscription compatibility      | [#184](https://github.com/jellydn/flowly/issues/184) |

Each issue includes scope, acceptance criteria, dependencies, complexity and
verification requirements. R8–R9 remain proposals to avoid speculative work.
No follow-up received the `factory` label; issue creation does not authorize
implementation, deployment, provider spending or generated-code publication.
