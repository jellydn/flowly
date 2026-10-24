# Prove one recoverable, human-controlled issue-to-draft-PR path

[Research index](./README.md) · [Current state](./current-state.md) · [Roadmap](./roadmap.md)

This is the **proposed MVP specification**, not a newly implemented runtime or a
claim that a live issue was resolved. The umbrella issue requests research and a
design. Current code already supplies the stages; follow-ups strengthen their
contracts and supply missing evidence.

[ADR 0010](../../adr/0010-vps-pilot-and-provider-policy.md) accepts the user's VPS,
simple operator approval, BYOK and conditional ChatGPT subscription access.
[Operations/provider evidence](./deployment-and-providers.md) records applicability
and limits. This specification follows those decisions, not the rejected strict
approval proposal.

## Target architecture: keep policy in Flowly

```text
GitHub issue / trusted operator
       │ authenticated admission; pinned repo/base/policy
       ▼
Flowly orchestrator ───── transactional run store + event/effect journal
       │                         │
       │                         └── operator CLI / GitHub status mirror
       ▼
Grounded plan → existing operator implementation boundary
       │
       ▼
Disposable worker: existing Flue implementer → candidate tree/diff
       │               no GitHub token; no host home; no publication
       ▼
Trusted patch validation/commit → isolated mandatory verification
       │                         │
       │                    bounded check evidence
       ▼                         ▼
Trusted push after checks → existing publication boundary → independent review
       │
       ▼
Trusted publisher: reconcile → create/reuse draft PR on factory/*
       │
       ▼
Exact-head CI observation → human review/approval outside Flowly
```

Keep `FactoryOrchestrator`, stage capabilities, workspace lifecycle, independent
review and `FactoryDraftPrPublisher`. Extend the current `FactoryRunStore` and
`FactoryImplementer` seams instead of introducing a generic agent framework.
The trusted Git path must never execute candidate-controlled hooks or helpers.

### Control-plane ownership

- **Intake:** validates repository identity and admission authority; deduplicates
  deliveries. Pin issue snapshot and base SHA. An edited issue creates a new
  revision to approve; it must not silently change an approved run.
- **Policy:** reads repository-owner configuration from the trusted base, not
  candidate files. Record policy version and digest. Model and memory output can
  propose work, but cannot grant capabilities or change required checks.
- **State:** for the single-worker pilot on the user's VPS, use local SQLite transactions
  on persistent disk behind the existing store interface. This fits the repo's
  `ops-digest/store.ts` precedent. Store snapshots, event sequence, leases and
  effect intents atomically. GitHub comments become a projection. Multi-host
  scheduling and Postgres are not MVP requirements. Mount state/artifacts outside
  disposable containers; document encrypted off-host backup and a restore drill.
- **Execution:** keep Flue first. Run untrusted native commands in disposable
  containers with only the candidate tree, private temporary storage, resource
  limits and no egress. Prepare dependencies from a pinned lockfile/image in a
  separate restricted step. Do not mount host credentials or the Docker socket.
- **Approval:** keep the existing trusted operator policy and boundary confirmation.
  No mandatory review-before-push, exact-commit human approval or receipt service.
  Record the effective policy/decision for explanation. Machine check evidence
  still binds to the candidate SHA. Shared multi-user operation remains out of scope.
- **Providers:** BYOK remains supported. Optional ChatGPT subscription access must
  pass technical and contractual validation for the chosen route; no silent
  fallback to paid API usage. Keep all provider credentials outside candidate tools.
- **Publication:** only trusted code receives short-lived repository-scoped
  credentials. Reconcile remote state after ambiguous errors. Never approve,
  merge, deploy, widen permissions or publish to a non-owned branch.
- **Observation:** extend the CLI and current events. Publish bounded summaries,
  diagnostics and artifact digests, not implementer scratch or raw transcripts.

### Minimal persisted additions

These are contract requirements, not a mandate to use these exact field names.

| Record            | Required information                                                                                 | Invariant                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Run input         | Repository, issue/revision digest, base SHA, policy digest, runtime/version, attempt                 | Replay cannot silently change input                                             |
| Lease             | Owner, monotonically increasing fencing token, expiry                                                | A replaced worker cannot commit a stale transition                              |
| Effect            | Stable key, intent, expected head/base, result/remote identity, status `pending/confirmed/uncertain` | Timeout is not proof the effect did not happen                                  |
| Artifact          | Base/candidate SHA or patch digest, producer stage, bounded size, expiry                             | Restore verifies digest and ownership before execution                          |
| Check evidence    | Command identity, trusted policy digest, image digest, candidate SHA, exit/timeout, duration         | A different commit cannot reuse green evidence                                  |
| Operator decision | Effective policy, boundary result, run identity and reason                                           | Explain why execution/publication was allowed without per-commit human receipts |
| Outcome           | Draft PR identity, CI head, human verdict, interventions, usage source and unknown fields            | Draft creation is not human acceptance                                          |

### Retry and timeout policy

Keep read retries separate from side-effect retries. Transient model/read failures
may retry with bounded exponential backoff and jitter. An invalid structured
response gets a small bounded repair budget. A verification failure does not
become a transient retry: persist it, and require a new implementation attempt
under policy. A hard overall deadline caps all attempts and stage timeouts.

Never blindly retry a push or PR create after a timeout. Persist intent first;
query the exact repository/branch/head after recovery; reuse the confirmed effect
or stop as uncertain. A run store cannot make GitHub and SQLite one transaction.
The goal is **at-least-once delivery with reconciled effects**, not a claim of
general exactly-once execution.

## Recovery behavior must be observable

| Interruption                              | Required result                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Duplicate issue delivery                  | Same run revision; no second plan or PR                                                                             |
| Planner crash/expired lease               | New fenced owner resumes/replans the same pinned input                                                              |
| Implementer crash with partial tree       | Preserve diagnostics; new attempt from pinned base or validated checkpoint, never assume partial edits are complete |
| Missing worker directory                  | Restore verified artifact or stop with a clear recovery reason; never fabricate success from a run snapshot         |
| Crash after checks                        | Reuse evidence only for the exact immutable candidate and unchanged policy                                          |
| Crash after push, before recording        | Compare remote head to recorded intent; do not overwrite a different head                                           |
| PR creation succeeds but response is lost | Find and verify owned draft by repository/branch/base/head; record it once                                          |
| Changed head or policy                    | Invalidate stale check evidence; re-evaluate existing policy, not a new per-commit human receipt                    |
| Cancel or budget exhaustion               | Kill worker process group/container, record terminal reason, no new publication                                     |
| Worker restart                            | Resume durable orchestration; never replay a completed external effect as a new request                             |

## MVP vertical slice

Use a disposable fixture repository owned by the pilot operator. It contains a
small parser with a documented boundary bug, asymmetric inputs, and fixed tests.
The issue names expected behavior and a required test command. It does not
require a frontend, external service, migration or package release.

1. **Issue → plan:** admit one issue, pin base and policy, inspect the relevant
   files and return cited steps, risks and acceptance criteria. Duplicate the
   delivery and confirm one run. Stop at the existing plan-only gate.
2. **Plan → isolated implementation:** the trusted operator uses the existing
   autonomy policy/boundary confirmation. Flue changes only the candidate tree. Host
   and sibling canaries remain inaccessible; the worker has no GitHub credentials.
3. **Implementation → tests/review:** produce a trusted candidate commit. Run
   mandatory tests in the isolated verifier, including negative/boundary inputs.
   Any changed check definition is visible and requires review; it is not a
   new per-commit approval gate. Preserve candidate identity throughout checks.
4. **Tests/review → draft PR:** push the checked candidate under existing policy,
   then independently review the real diff and exact-SHA evidence. The existing
   publication boundary controls draft creation; a draft with findings remains
   permitted under configured policy. Include criteria, checks, review findings,
   costs/unknowns and run identity. Replay a lost response and reuse the same draft.
5. **Draft → human approval:** observe required CI on the exact PR head, and
   collect a human accept/reject verdict. Flowly never submits `APPROVE`, marks
   the PR ready, merges or deploys. A human may record acceptance without merging.

Start with deterministic fake model/GitHub boundaries and real disposable Git,
processes, storage and sandbox checks. Then run one provider-backed task in an
explicitly authorized disposable remote repository. The live phase is **not
authorized or executed by this research**; opening roadmap issues does not grant
permission to push generated code or spend provider budget.

## Release gates and measurement

Safety gates are absolute: no canary leakage, cross-workspace mutation, duplicate
draft, stale check evidence, unauthorized branch push, approve/merge/deploy call or
silent recovery. Test each crash row above. A failed check must block publication;
review findings remain visible and follow the existing draft-publication policy.

For usefulness, pre-register a small held-out corpus of 10 bounded tasks and run
three attempts per task per candidate runtime with the same repository revisions,
models where compatible, prompts, images, mandatory checks and spend/deadline
limits. Separate configuration differences when models cannot match. Keep
failed/cancelled runs in denominators and report raw counts; this small sample
does not justify broad statistical claims. Blind the human reviewer to runtime
where practical. Do not tune on the held-out tasks.

| Measure                   | Definition                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Successful draft delivery | Required checks pass and one reviewed draft reaches the human, divided by all admitted attempts                         |
| Human acceptance          | Explicit accepted verdict for the exact candidate, divided by all admitted attempts; report rejected/pending separately |
| Human interventions       | Clarification, repair, retry and policy-exception actions per attempt; report routine approvals separately              |
| Cost per accepted task    | Sum of all attempt model charges + priced compute, divided by accepted tasks; undefined if none accepted                |
| Elapsed time              | Admission to human-ready draft and admission to verdict; report queue/approval wait separately, median and p95          |
| Recovery success          | Fault-injected attempts with correct state/effect reconciliation divided by injected attempts                           |

Record provider-reported billed usage where available; otherwise mark estimates
with pricing version and unknowns. Include failed attempts and local inference
hardware cost. Choose numeric budget and quality targets before the live pilot;
none are claimed from this research. A second runtime must pass every safety gate
and improve acceptance or cost/time without hiding increased human effort.

## Rollout and rollback

Land R1/R2 isolation without enabling more autonomy. Add R3 state and R4 simple
operator guidance; retain the old read-only operator view. Add R5
mandatory evidence, then R6 worker-loss recovery and R7 pilot measurements.
Start with one repository and one worker on the user's VPS; expand only after
reviewed pilot data. R10 validates optional subscription access; BYOK need not wait.
Updates/restarts/deployment remain separately authorized operations, not automatic
on merge. Verify deployed revision and worker health after an authorized update.

Rollback disables new intake and returns to plan-only. Drain/cancel worker leases,
preserve run records and failed artifacts for the agreed retention period, revoke
publication credentials, and leave existing drafts untouched for human review.
Do not roll back by letting old workers ignore fencing or required check evidence.

Out of scope: replacing Flue, general multi-agent swarms, shared live UI,
self-modifying orchestration, arbitrary executable memory, production migration,
automatic merge/deployment, or a hosted multi-tenant platform.

## Research verification

The research is documentation-only. After the accepted VPS/provider decisions on
2026-10-24, `npm run check` passed: typecheck, 689 tests (zero failures or skips),
deterministic evaluation gates, build, and documentation checks (10 indexed ADRs).
The build emitted existing `use agent` directive warnings. Source-link validation
checked 50 distinct local targets and 194 external references with zero errors,
using HTTP for source/docs and Git/API checks for commit identities. The two
unavailable policy pages noted in the provider analysis remain a terms-review
limitation, not evidence of permission. Targeted oxfmt and whitespace checks
passed. These checks establish document/source consistency, not runtime safety.

Runtime isolation, remote recovery and live-provider performance remain proposed
acceptance tests, not completed implementation evidence. No upstream code was
executed and no live factory task, merge or deployment was performed.
