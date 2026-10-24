# Flowly already has a factory; the gaps are enforcement and recovery

[Research index](./README.md) · [Target and MVP](./target-and-mvp.md)

Baseline: [Flowly revision](https://github.com/jellydn/flowly/commit/a97857f7a38fc455c4cc161157d5770e4982b6dd),
2026-10-24. This audit distinguishes shipped source from deployment evidence.

## Current execution path

```text
GitHub issue label
  → event router → Actions factory job (one concurrency group per issue)
  → intake/classifier → repository-grounded planner
  → implementation autonomy gate (default: stop at plan)
  → isolated clone + Flue implementer / just-bash ReadWriteFs
  → trusted commit → host verification shell in denied-network namespace
  → pristine-tree check → push factory/* branch
  → publication autonomy gate → independent reviewer
  → create/reuse draft PR → completed
  → human review and merge outside Flowly

Run snapshots + appended events: bot-authored GitHub issue comment or local JSON
Workspace identity + lifecycle: local files; clone contents: local disk
```

`completed` means draft publication finished. It does not mean a human accepted,
merged, or deployed the change. Independent review happens **after the branch
push**, not before all external mutation.

## Existing capabilities and their limits

| Capability               | Direct evidence                                                                                                                                                                            | Assessment                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intake and routing       | [workflow](../../../.github/workflows/event-router.yml), [dispatch](../../../factory/dispatch.ts), [intake](../../../factory/intake.ts)                                                    | Implemented. Label dispatch and per-issue Actions concurrency; not a general durable queue.                                                                                                                                    |
| Repository analysis      | [inspection registry](../../../tools/inspection-registry.ts), [planner adapter](../../../factory/model-adapters.ts), [relationship index](../../../index/repository-relationship-index.ts) | Six bounded inspection tools, TF-IDF retrieval, related context. Do not add another retrieval layer without measured need.                                                                                                     |
| General agent vs factory | [agent](../../../agents/repo-assistant.ts), [sandbox](../../../sandbox.ts), [factory entrypoint](../../../scripts/run-factory.ts)                                                          | General agent is read-only. Factory uses real model classifier/planner/reviewer and a writable implementer; no-op defaults are not the production path.                                                                        |
| Stage orchestration      | [run](../../../factory/run.ts), [orchestrator](../../../factory/orchestrator.ts)                                                                                                           | Typed states, planning lease, recorded transitions, stage resume branches. Not proof that every interrupted external effect can be recovered.                                                                                  |
| Autonomy                 | [policy](../../../factory/autonomy.ts), [tests](../../../tests/factory-run.test.ts)                                                                                                        | Plan-only by default, graduated levels, demotions, one-boundary confirmations. Current workflow does not set a policy or confirmation, so a label alone does not enable implementation.                                        |
| Least capability         | [profiles](../../../factory/capabilities.ts), [guards](../../../factory/capability-guard.ts)                                                                                               | Restrict-only overlays, stage-specific tools/context/GitHub operations; merge/approve/deploy excluded. Policy is not an OS sandbox.                                                                                            |
| Writable isolation       | [implementer](../../../agents/factory-implementer.ts), [workspace manager](../../../factory/workspace-lifecycle.ts), [Git adapter](../../../factory/git.ts)                                | Root-confined virtual filesystem, separate clone, branch/remote ownership checks, GC and same-run reuse. Host verification and trusted Git have different boundaries.                                                          |
| Verification             | [runner](../../../factory/verification.ts), [implementation](../../../factory/implementation.ts)                                                                                           | Command count, output and timeout limits; Linux network namespace, no-new-privileges; checks exact commit and clean worktree. No mount/PID isolation shown. Commands come from the plan, not a mandatory trusted check policy. |
| Independent review       | [review](../../../factory/review.ts), [pipeline](../../../factory/pipeline.ts), [tests](../../../tests/factory-pipeline.test.ts)                                                           | Reviewer receives issue, criteria, diff, and check results, not implementer scratch. A failed review can still produce a draft when autonomy policy permits; tests explicitly cover this.                                      |
| PR safety and retries    | [publisher](../../../factory/publisher.ts)                                                                                                                                                 | Reuses an open draft by branch, rejects an open non-draft, never merges/approves. Read-before-create is not atomic under concurrent publishers.                                                                                |
| Run persistence          | [GitHub store](../../../factory/run-state-store.ts), [local store](../../../factory/store.ts)                                                                                              | Validated snapshots, bot-author filtering, expected versions. GitHub update is not conditional CAS; local serialization is not a distributed lock.                                                                             |
| Workspace recovery       | [lifecycle](../../../factory/workspace-lifecycle.ts), [ADR 0007](../../adr/0007-factory-workspace-lifecycle.md)                                                                            | Identity, base SHA, leases/lifecycle and retention are implemented. ADR explicitly states resume needs the directory on the same runner. No durable clone/patch export is wired in the Actions job.                            |
| Observability            | [events](../../../factory/events.ts), [CLI](../../../scripts/factory.ts), [ADR 0008](../../adr/0008-factory-operator-control-plane.md)                                                     | Append-only event projection, list/show/timeline/explain. Usage can be unknown; do not claim end-to-end billed cost or human acceptance metrics exist.                                                                         |
| Memory                   | [service](../../../memory/service.ts), [engine](../../../memory/engine.ts), [config](../../../memory/config.ts)                                                                            | Opt-in, evidence-derived instincts with confidence, decay and operator rejection. Not missing. Executable packages and arbitrary scheduled agents are a different, higher-risk feature.                                        |
| Campaigns                | [campaign runner](../../../factory/campaign-run.ts)                                                                                                                                        | Approved bounded migration batches, dependencies, failure propagation. Not missing; no reason to add unrestricted multi-agent coordination.                                                                                    |
| Operations digest        | [SQLite store](../../../ops-digest/store.ts), [operator docs](../../ops-digest.md)                                                                                                         | Existing local SQLite precedent and approval-gated publication; reuse experience, not the Slack-specific data model.                                                                                                           |
| Evaluation               | [framework](../../../eval/framework/runner.ts), [safety catalog](../../../eval/security/invariants.ts), [safety tests](../../../tests/factory-safety.test.ts)                              | Deterministic repository/benchmark/safety checks already exist. They are not a real-provider issue-to-human-acceptance benchmark.                                                                                              |

## Gaps ordered by consequence

1. **Execution boundary:** planner-selected shell commands can access the host
   filesystem. `safeEnvironment()` removes most environment keys but retains
   `HOME` and `PATH`. Network denial is useful, but it does not protect files,
   sibling workspaces, or local sockets. See [security findings](./security.md).
2. **Trusted Git boundary:** the implementer can write within the clone, including
   Git metadata unless separately denied. Trusted Git uses normal configuration
   and inherits its environment. Branch and remote checks do not establish that
   hooks, filters, and credential helpers are safe.
3. **Recovery and concurrency:** Actions run state outlives the clone; the clone
   is not restored on another runner. Read/check/write comment updates can race.
   Current per-issue workflow serialization narrows, but does not eliminate,
   writers from other processes or manual invocations.
4. **Human authorization:** `FACTORY_CONFIRM_BOUNDARY` is a trusted environment
   input, not an actor-bound, expiring receipt tied to plan/policy/commit digests.
   ADR 0010 accepts this simple operator boundary for the single-owner VPS pilot;
   it is not a shared-session authorization contract. Do not add mandatory
   review-before-push or exact-commit human receipts to the pilot.
5. **Evidence policy:** nonempty commands and successful exit codes do not prove
   required checks ran. Preserve repository-owner-defined mandatory checks, bound
   to the tested SHA; model-selected additions must not replace them.
6. **Outcome measurement:** current events and evals are a useful base. Connect
   factory runs to costs, time, human interventions, and accepted PR outcomes
   before choosing a second runtime.

## Unknowns that must not become promises

- No production runner, repository protection rule, GitHub App permission, live
  model bill, or deployed incident history was inspected. Source review cannot
  certify those controls.
- No exploit against a real credential or live repository was attempted. The
  security assessment identifies reachable boundaries in source and specifies
  disposable canary tests for follow-up work.
- Upstream sandbox quality and cross-version API compatibility were not tested.
- GitHub checks on a pushed draft are not awaited by the current factory pipeline;
  local verification and later GitHub CI are separate evidence streams.

Do not reopen completed foundations: issues #94, #119, #121, #138, #139, #140,
#141, and #142 already delivered factory stages, campaigns, autonomy, memory,
observability, capability profiles, workspace lifecycle, and safety evaluation.
The [roadmap](./roadmap.md) extends their contracts rather than duplicating them.
