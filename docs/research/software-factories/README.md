# Software factory research: harden Flowly before adding runtimes

Research for [issue #176](https://github.com/jellydn/flowly/issues/176), checked **2026-10-24**.
Status: research with [Accepted ADR 0010](../../adr/0010-vps-pilot-and-provider-policy.md).
Implementation work remains proposed; no runtime migration or deployment is included.

**Keep Flowly's deterministic factory control plane. Harden execution, recovery,
and human authorization before adding another coding runtime.** Flowly already
implements most of the requested issue-to-draft-PR path. Rebuilding it around an
upstream project would discard working controls without proving better results.

## Deliverables

| Document                                                   | What it answers                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Current state and gaps](./current-state.md)               | What exists in source, what is missing, and what remains unknown                                                      |
| [Upstream comparison](./comparison.md)                     | All 16 named projects, Warp Factories separately, licenses, maintenance, hosting, and transferable patterns           |
| [Evidence snapshot](./upstream-snapshot.json)              | Exact revisions, commit dates and subjects, recent commits, canonical repositories, and inspected source/license URLs |
| [Security analysis](./security.md)                         | Trust boundaries, source-supported risks, mitigations, and adversarial checks                                         |
| [Target architecture and MVP](./target-and-mvp.md)         | Incremental design, recovery rules, one vertical slice, and measurable acceptance                                     |
| [Prioritized follow-ups](./roadmap.md)                     | Small delivery units, acceptance criteria, dependencies, complexity, and issue links                                  |
| [VPS and provider evidence](./deployment-and-providers.md) | ai-flow operations, HermesHub BYOK/subscription paths, official provider constraints and accepted policy              |

For local projects, VPS repository intake and connected local runners, see
[Projects and runners](./projects-and-runners.md) and
[proposed ADR 0011](../../adr/0011-projects-and-runners.md). These extend the
research; they do not enable remote execution or change accepted ADR 0010.

## Findings that change the recommendation

- **Clone isolation is not host isolation.** Flowly's implementer uses a confined
  virtual filesystem, but verification runs host shell commands. Network denial
  does not prevent access to host files. Trusted Git also runs against a writable
  clone. Harden both boundaries first.
- **Persistence is not exactly-once execution.** GitHub comment snapshots survive
  Actions retries, but version checks are a read followed by an update. Workspace
  records remain local. Do not promise cross-runner recovery or concurrent-writer
  safety from those controls alone.
- **Simple approval is the accepted pilot policy.** Keep the existing trusted
  operator boundary confirmation. Exact-commit human receipts and mandatory
  review-before-push were rejected; shared multi-user authorization remains out of scope.
- **Current upstreams differ from older descriptions.** OpenHands is now Agent
  Canvas in the named repository. Warp's client is open source; its Factories
  control plane remains hosted. Kody is now `kody-hq/kody` and FSL-licensed.
  Continue and GPT Pilot explicitly say they are no longer maintained. Ultimate
  explicitly offers no compatibility or support commitment.

## Method and limits

The Flowly baseline is [this revision](https://github.com/jellydn/flowly/commit/a97857f7a38fc455c4cc161157d5770e4982b6dd).
Read the owning implementation, workflow, tests, and existing ADRs before proposing
changes. Relative Flowly links refer to this checkout; the baseline makes the
audit reproducible after those files change.

For each named upstream, read a shallow default-branch checkout, root license,
README, and the source paths listed in the snapshot. Read GitHub repository
metadata and up to five recent default-branch commits. Two supplemental checkouts
cover the OpenHands SDK and Warp's factory examples. No upstream dependencies or
code were installed or executed. In particular, GPT Pilot was read as text only.

The comparison is **source inspection, not a deployment certification or a
benchmark**. A file's presence does not prove its production reliability. An
unknown means the sampled evidence did not establish the property; it does not
mean the project lacks it. Commit recency is a maintenance signal, not a quality
score. GitHub's `pushed_at` can reflect a non-default branch and is not the last
default-branch commit date. Stars were not used for ranking.

Licenses below describe the pinned root source, not every dependency, model,
trademark, hosted service, or future release. FSL is source-available with use
restrictions, not equivalent to MIT or Apache-2.0. Any code reuse needs a separate
license review. The recommendation transfers design patterns, not upstream code.

## Accepted decisions and remaining operational checks

1. **Pilot host:** the user's VPS, with one supervised worker and persistent
   state outside disposable execution containers. ai-flow provides operations
   patterns, not proof of Flowly isolation or backups.
2. **Approval:** retain simple operator-controlled boundaries and push-after-tests.
   Independent review informs draft publication; no mandatory review-before-push
   or exact-commit human receipt. Keep exact-SHA machine evidence and human PR review.
3. **Providers:** BYOK remains supported; ChatGPT subscription access may be used
   where technically and contractually valid. HermesHub is comparison evidence,
   not a ready Flowly adapter. No silent paid fallback or shared account tokens.

Provider entitlement/terms, quota and spend limits, VPS capacity, backup retention
and a restore drill remain checks before a separately authorized live pilot.
Keep the existing `plan-only` default. No automatic merge or deployment is
authorized. Verification is recorded in [the MVP document](./target-and-mvp.md#research-verification).
