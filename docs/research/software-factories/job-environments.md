# Keep the worker persistent and each job environment disposable

[Research index](./README.md) · [ADR 0010](../../adr/0010-vps-pilot-and-provider-policy.md) · [Roadmap](./roadmap.md)

Checked **2026-10-24** for [#176](https://github.com/jellydn/flowly/issues/176).
This extends the existing [security analysis](./security.md) and
[VPS/provider research](./deployment-and-providers.md); it does not replace them.
Vendor statements below come from current official documentation, not product
trials or an audit of proprietary infrastructure. Links are the evidence; prices,
plan eligibility and lifecycle limits can change. Unknown means not established.

## Recommendation and terms

**Keep Flue, one supervised worker, and durable state on the user's VPS. Allocate
a fresh, credential-free execution environment for every run attempt.** Separate
implementation from verification with a fresh verifier environment. A job owns its
files; a later job never inherits its writable filesystem, processes or credentials.

- A **checkout/worktree** separates edits, not OS users, processes or secrets.
- A **sandbox** is an enforced execution boundary. A container shares its host
  kernel; a VM adds a guest-kernel boundary. Neither makes injected credentials safe.
- A **persistent runner** is a service that receives work. It can launch a fresh
  sandbox per job; persistence and isolation are independent choices.
- A **prepared image** accelerates new jobs. A **job checkpoint** preserves one
  job's work. Neither is an off-host backup, nor evidence that checks passed.

Use rootless containers as the KISS pilot backend, conditional on the host checks
and threat limits below. Do not build a cloud platform, a warm machine fleet,
Kubernetes, memory snapshots or a multi-vendor runtime abstraction for this pilot.
Do not replace the existing workspace manager with an unrelated scheduler.

## Managed environments: compare the actual unit of isolation

| Concern              | Amp-hosted Orbs                                                                                                                                                                                        | Cursor-hosted Cloud Agents                                                                                                                                                          | Devin-managed Cloud sessions                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning         | Fresh environment per orb thread; default E2B microVMs. Project snapshots matched to source/shared configuration accelerate creation [A1, A2].                                                         | One VM boundary per agent, documented Firecracker-based microVMs in a separate AWS account; prepared Builds [C1, C2].                                                               | One isolated machine per session; fresh copy of a prepared VM snapshot [D1, D2]. Hypervisor details not established here.                                                                               |
| Repository isolation | Project repositories cloned/updated inside the orb, additional repos in separate directories. Not a shared host worktree [A2].                                                                         | Repositories cloned into the machine; requested branch applied over active Build. Multi-repo environment is one shared trust domain [C2].                                           | All configured repos cloned into the snapshot, then relevant repos updated at session start. Separate repo directories are not isolation from each other [D1].                                          |
| Persistence          | Same thread wakes with disk and memory; services survive pause. New thread receives prepared project state, not another thread's edits [A1, A3].                                                       | Encrypted disk snapshots support resume; Builds preserve disk, not running processes or shell exports [C2, C3]. Do not infer live-memory recovery.                                  | Sleep can wake on a message; new sessions start clean, and session changes do not update the base snapshot. End-of-session changes are discarded per blueprint docs; no full-memory guarantee [D1, D5]. |
| Lifecycle            | Pause after both 5 minutes without agent work and 20 minutes without interaction; archive pauses immediately. Pause is not deletion [A4].                                                              | Archive hides a run. Delete API removes transcript/artifacts, not snapshots; snapshots expire after 30 inactive days, renewed on use [C3].                                          | Default sleep after 30 idle minutes; Lite/API sessions generally after 5. Sleeping incurs no usage. Sleep, termination and a new session are distinct [D5].                                             |
| Snapshots/caching    | Prepared project snapshots reused up to 72 hours; setup changes alone do not invalidate them. Setup and resume hooks are separate [A2].                                                                | Docker layer caching and active Build. Failed Build leaves previous successful Build active; startup commands restart services [C2].                                                | Blueprints rebuild on configuration change and roughly daily; pin a recent successful/partial Build. Partial builds can lack dependencies for some repos [D1].                                          |
| Secrets              | Secret env values are redacted in shell output; scoped OIDC can issue temporary credentials. Setup lacks personal/thread identity; files written during setup can leak into shared snapshots [A2, A5]. | Env vars are visible; runtime secrets remain env vars but are redacted in tool results/transcripts/commits; terminal users can read them. Build secrets and OIDC are separate [C3]. | Org, personal, repo and session scopes; secrets bound to relevant commands/tools. Blueprint scripts can persist secret values in config files despite injection cleanup [D1, D4].                       |
| Networking           | Git, tools and private connectivity supported; OIDC/Tailscale available. Consult configured policy; reviewed orb pages do not establish a default-deny egress guarantee [A2, A5].                      | Internet on by default. Domain allowlists and Enterprise locking; essential Cursor/SCM endpoints remain reachable even in allowlist-only mode [C3].                                 | Network profiles restrict machine egress with mandatory/recommended policy; required Devin destinations and allowed MCP paths are exceptions. Private connectivity available [D2, D6].                  |
| Privileges           | Sudo and software installation inside orb; isolation from host does not mean least privilege inside guest [A2, A3].                                                                                    | Automatic terminal execution; Docker workflows supported inside another container layer. MicroVM boundary is distinct from guest privilege [C1, C2].                                | Shell, browser and editor inside devbox. Exact managed guest UID/capability/seccomp configuration not established [D2].                                                                                 |
| Concurrency          | Independent orb threads; documented burst of 20 metered orb starts, then one new start per five minutes. This is pacing, not a simultaneous-job guarantee [A1].                                        | Independent managed VMs; resource profile limited, larger profiles by Enterprise request. Exact account concurrency limit not established here [C2].                                | Parallel sessions depend on plan. Build serialization is separate from session concurrency; exact account session cap not established [D1, D5].                                                         |
| Human access         | Shared terminal/files/desktop and authenticated portals; human edits change the same workspace [A1, A3].                                                                                               | Shared terminals, files, forwarded ports and artifacts [C2].                                                                                                                        | Interactive IDE/desktop; CLI SSH, port forwarding and scp [D2, D7].                                                                                                                                     |
| Auditability         | Thread conversation, diff, files, hook/provider logs. Immutable, complete OS command audit is not established by these pages [A1–A3].                                                                  | Session logs, signed commits, run diagnostics; Enterprise auth/admin audit export. These are not proof of every process syscall [C1, C3].                                           | Session Insights includes per-session usage; vendor logging and data controls documented. Complete immutable shell audit/export and exact deletion SLA not established here [D5, D8].                   |
| Recovery             | Resume same orb; `.agents/resume` repairs connections. Setup failure does not publish a snapshot but can still start the orb. Flowly should instead fail closed on required setup failure [A2].        | Resume retained disk; recover setup from last successful Build. Snapshot expiry is not a backup/restore contract [C2, C3].                                                          | Wake sleeping session; select known Build for new sessions. Do not equate a reusable environment snapshot with recovery of unpublished job edits [D1, D5].                                              |

References use the source keys in the evidence index below. In every product,
redaction is an output control, **not** a barrier that prevents candidate code from
reading an injected secret. A domain allowlist can still allow exfiltration through
Git, artifacts or a permitted API. A signed commit proves attribution, not safety.

## Self-hosting changes who owns the boundary

| Mode                            | Execution, persistence and repository behavior                                                                                                                                                                                         | Constraints and responsibility                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amp self-hosted Orbs [A3]       | Outbound provider dispatch receives idempotent `spawn`, `pause`, `delete`; one orb per thread. Docker example keeps disk but loses memory/terminal sessions; project snapshots are host-local. Other backends differ.                  | All workspaces can configure a provider. Operator owns isolation, resources and storage. Tool outputs, read file contents, diffs and attachments still go to Amp; agent loop/inference remain hosted. Dispatch must complete within five minutes. Sample Docker script is not a hardened hostile-code launcher. |
| Amp runner [A6]                 | Connects an existing machine/checkouts. Optional sibling Git worktree per thread; worktrees stay until removed.                                                                                                                        | No per-thread VM boundary follows from a worktree. Runner removal refuses dirty/unmerged work. Useful for trusted local work, not a replacement for Flowly's sandbox.                                                                                                                                           |
| Cursor My Machines [C4]         | Existing checkouts and credentials; multiple agents can run on one machine. No automatic clone/branch switch.                                                                                                                          | Personal authentication; machine network policy applies, not hosted egress settings. Live workspace runs as worker OS user.                                                                                                                                                                                     |
| Cursor Team Pools [C4]          | One agent per worker; persistent or dynamically created machines. Any-repo workers can clone requested refs. Operator supplies setup hooks/images, caches and teardown.                                                                | Enterprise plan and service-account key. Optional secret sync differs from managed environments; `.cursor/environment.json` is not read. No inbound ports needed; code/tool results and artifacts still leave for Cursor.                                                                                       |
| Devin Outposts [D3, D9]         | Queue → atomic claim → worker. Long-lived workers reuse machines unless operator provisions one per session. N workers serve N concurrent sessions. Resume needs both working directory and worker state, with unique worker identity. | Available on Pro/Max/Teams; dedicated tenants require enablement. Outbound HTTPS; agent loop stays in Devin cloud. Operator owns isolation, firewall and recovery. Sudo guidance explicitly limits it to dedicated, recycled machines.                                                                          |
| Devin dedicated deployment [D2] | Cognition-managed single-tenant VPC with PrivateLink/IPSec to customer resources.                                                                                                                                                      | Not the same as running the service on a user VPS. Agent brain remains hosted. Outposts is the separate bring-your-own-compute route.                                                                                                                                                                           |

**Do not conclude that self-hosted means offline or that a worker creates a sandbox.**
Cursor's hosted network settings do not govern its self-hosted workers. Devin
publishes the effective Outposts network policy but does not install the firewall;
the operator must enforce it [C4, D6]. Amp's dispatch contract likewise delegates
the machine boundary to the operator [A3]. These are useful patterns, not reasons
to replace Flowly or to send Flowly jobs through these paid control planes.

Devin's enterprise overview alone would miss Outposts. Its statement that the
compound system does not support third-party LLM keys also does not negate the
separately documented self-serve ChatGPT integration. Read product modes separately.

## Cost comparison is not a benchmark

Checked prices are USD, before applicable tax; confirm account terms before use.

- **Amp:** metered orb compute is billed per minute while awake. Small (2 CPU,
  4 GB) is $0.17/hour; medium (4 CPU, 8 GB) is $0.33/hour, each with 60 GB disk.
  Paused compute costs zero. Model usage/plan allowances are separate. Self-hosted
  compute remains the customer's bill; docs announce free self-hosted orb service
  for Hobby/Individual/Teams and standard compute-equivalent charges for Enterprise
  after October 29 [A4]. Do not generalize a temporary offer to all accounts.
- **Cursor:** current Premium is $30/month and includes Cloud Agents; selected
  model usage/credits still matter. Managed execution infrastructure is included;
  self-hosted hardware and operations are extra. Team Pools require Enterprise,
  not merely a personal paid plan [C4, C5]. Legacy account pricing differs.
- **Devin:** self-serve Pro $20/month, Max $200/month, Teams minimum $80/month;
  quota plus on-demand credits. Enterprise uses contracted ACUs. Usage includes
  actions and machine time; waiting for tests is not entirely free while the VM
  runs. Outposts adds owned infrastructure costs [D3, D5, D10].
- **Flowly:** VPS fixed cost, off-host backup storage, image maintenance and
  operator time plus BYOK usage or eligible subscription allocation. Track failed
  attempts as well as successes. No dollars-per-accepted-PR conclusion is possible
  without the held-out pilot in [#183](https://github.com/jellydn/flowly/issues/183).

Devin documents eligible ChatGPT Go/Plus/Pro use for owned sessions on its
self-serve paid plans, not Enterprise. Only covered GPT requests shift billing;
machine time and other usage remain. Cloud pauses at subscription quota exhaustion,
whereas its CLI/Desktop can retry on paid Devin usage [D11]. **Borrow explicit
access-mode accounting, not automatic paid fallback.** This is evidence that
subscription integration can be product-supported, not permission or an adapter
for Flowly. [#184](https://github.com/jellydn/flowly/issues/184) still gates Flowly's
optional route; BYOK does not wait for it. ADR 0010 needs no policy reversal.

## A small VPS design with explicit trust boundaries

The following is proposed implementation, not a deployed control. Retain the
existing [capabilities](../../../factory/capabilities.ts),
[workspace lifecycle](../../../factory/workspace-lifecycle.ts), and operator API.

```text
Operator → supervised Flowly worker → SQLite journal + bounded artifacts
                    │
                    ├→ fresh job container: candidate files, no credentials
                    ├→ fresh verifier container: frozen candidate, offline checks
                    └→ trusted Git/publisher: exact tested candidate → draft PR
```

1. **Admission and ownership:** keep plan-only default and simple boundary
   confirmation. Claim one run/attempt with a lease and fencing generation in the
   proposed SQLite journal (#179). Global concurrency starts at one; queue excess
   jobs. Disable overlapping Actions execution when a separately authorized VPS
   cutover occurs; a single VPS worker alone does not fence the Actions path.
2. **Preparation:** operator-reviewed, digest-pinned image contains toolchain and
   dependencies for a pinned base/lockfile/platform. Prepare dependencies in a
   separate bounded build, with no publisher credentials. Deny lifecycle scripts
   while registry credentials are available; run required scripts later offline
   without credentials. Candidate setup files cannot choose host mounts or flags.
   Fail closed if preparation or offline checks cannot meet the policy.
3. **Allocation:** extend `FactoryWorkspaceManager` to record runtime resource ID,
   run/attempt, lease generation, image/base/policy digests and cleanup state. Use
   one rootless Docker backend first, under a dedicated executor OS account distinct
   from the credential-bearing worker. A narrow operator-owned launcher accepts
   validated IDs and fixed profiles, not arbitrary Docker arguments or shell text.
   Only the launcher controls the runtime socket; never expose it to candidates.
4. **Execution:** private mount/PID/IPC/network namespaces, non-root container user,
   read-only root filesystem, private writable HOME/tmp and job volume; drop all
   capabilities, no-new-privileges, default seccomp plus host AppArmor/SELinux where
   available. No sudo, devices, host namespaces, host home, sibling volumes,
   SSH agent, Docker socket, provider keys or GitHub tokens. Deny candidate network
   entirely, including DNS, host gateways and metadata. Internal test services may
   share only that job's isolated network if explicitly required and tested.
5. **Model boundary:** retain Flue orchestration and its bounded virtual tools.
   Candidate code runs only in the execution backend; the trusted model client
   retains provider access. A future native CLI needing model HTTP must use a
   separate constrained model endpoint, not general egress or mounted credentials.
   That endpoint is not needed for the initial verifier slice. Do not move the
   credential-bearing agent process into an unrestricted candidate shell.
6. **Verification/publication:** export only validated candidate content, with
   bounded paths, sizes, symlinks and no Git metadata (#178). Freeze a content
   manifest, create the candidate commit in a clean trusted checkout, and run
   mandatory checks in a fresh container from that exact tree (#181). Tests may
   write scratch/build output but cannot change the frozen publication input.
   Bind results to candidate SHA, image and policy. Only trusted Git gets scoped
   credentials. Tests precede push; independent review informs draft publication.
   Preserve policy-controlled red-review drafts and no merge/approve/deploy.
7. **Limits and access:** enforce CPU, RAM, PID, disk/inode, output and wall-clock
   budgets at the runtime/host boundary. Reserve capacity for sibling apps and the
   worker. Preflight cgroup enforcement and disk quota support; reject native work
   if any required limit is ineffective. Operator debugging uses an authenticated
   shell into the job container, never a public SSH port or the worker shell.
   Record attach events; human edits invalidate candidate check evidence.

Rootless mode reduces daemon privilege but still shares the kernel [H1]. On a VPS
with sensitive sibling services, do not run deliberately hostile third-party code
until the owner accepts this residual risk or a separate VM boundary is available.
For a stronger threat model, use a dedicated execution VM or per-job microVM after
checking nested virtualization/KVM support. A VPS may not expose it. Failure to
support the selected boundary means remain plan-only, not fall back to host shell.

## Threat model and acceptance evidence

Trust the single operator, deployed worker/launcher, pinned policy and image
build path. Treat issues, repository files, dependencies, generated code, test
scripts, model output, job artifacts and interrupted workers as untrusted.
Protect host/sibling data, credentials, other jobs, evidence and publication rights.
These tests extend S1–S5; they do not add new audited vulnerability counts.

| Threat                                              | Required control and disposable acceptance test                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host/sibling access, local socket or process attack | Private namespaces/mounts and separate executor identity. Host and sibling canaries cannot be read/changed; host processes and sockets are unreachable.                                           |
| Exfiltration or injected instructions               | No credentials/network in native candidate execution. DNS, IPv4/IPv6 TCP, metadata and gateway probes fail; canary strings do not reach retained logs/artifacts. Redaction alone is insufficient. |
| Git hooks/config or path escape at export           | Fresh trusted Git, explicit config/environment, reject unsafe metadata/paths and bound extraction. Hook/filter/helper/symlink canaries cannot execute or escape.                                  |
| Fork, disk, inode or output exhaustion              | Verify actual resource enforcement, not flag presence. Kill a fork tree, fill a disposable quota, cap logs; worker and sibling health remain within reserved budget.                              |
| Cache or snapshot poisoning                         | Trusted prepared image is immutable; jobs get private copies. No job writes shared dependency caches; a poisoned job cannot affect the next job's sentinel.                                       |
| Stale worker or duplicate publication               | Lease fencing at effects and resource ownership; ambiguous outcomes reconciled. Kill after remote success/before local save; retry creates no second draft.                                       |
| False checks, changed tree or human edit            | Trusted mandatory checks plus exact candidate/image/policy identity. Mutation after test invalidates evidence; weak model-selected commands cannot replace required checks.                       |
| Host root/kernel compromise                         | Outside the container guarantee. Patch host, separate executor account, encrypted off-host backup; use stronger isolation before hostile multi-tenant workloads.                                  |

## Cleanup is part of correctness

- Stop the entire container/cgroup on completion, cancellation, timeout, quota
  breach or lease loss. Revoke temporary access immediately; do not leave a debug
  container running. Record exit, OOM/timeout/cancel reason and cleanup outcome.
- Export validated bounded evidence before deleting job files. Preserve the
  existing workspace retention defaults: completed/cancelled 1 hour, failed
  24 hours, explicit debug retention 7 days. These govern stopped workspace data,
  not continued compute. Never auto-delete the only checkpoint of resumable work.
- Run reconciliation on startup and periodic GC. Compare persisted owner IDs and
  leases with runtime labels; age alone is not ownership. Never run global Docker
  prune or delete unknown/unlabelled resources. Quarantine mismatches for the operator.
- Record deletion intent then result; retry partial deletion idempotently. Active
  or unexpired leases block GC. If stop cannot be confirmed, block new native work
  and publication until reconciled; do not launch a replacement beside a live stale job.
- Keep metadata/checkpoints outside job volumes. Proposed pilot retention for
  terminal-run logs/artifacts is 30 days with size caps; owner must choose disk
  budgets and backup retention before activation. Suspended runs need explicit
  resume/cancel before evidence expiry. Full transcripts and secrets are not backup
  payloads. Deleting files is not guaranteed secure erasure on shared storage.
- Reuse only trusted read-only image layers, keyed by toolchain/image digest,
  base/lockfile/platform and policy. Defer shared writable caches and VM snapshots
  until measured provisioning time justifies their extra trust and cleanup rules.

## Recovery must not depend on an immortal machine

| Failure                             | Required behavior                                                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning fails or image missing | Record bounded diagnostic, remove owned partial resources, bounded retry; no host-shell fallback.                                                                                  |
| Worker crashes or VPS reboots       | Reconcile journal and resources before intake. Fence expired worker; stop orphan compute; restore a checkpoint into a fresh environment. Do not assume running processes survived. |
| Job timeout/OOM/cancellation        | Kill descendants, retain bounded reason/evidence, release capacity only after confirmed stop. No blind auto-resume of a cancelled run.                                             |
| Snapshot/cache corrupt or stale     | Discard cache and rebuild from pinned inputs; never reuse its check result. Missing candidate evidence blocks publication.                                                         |
| Push/PR request times out           | Query owned remote branch/PR and exact head using journaled effect intent before retry. Conflicting remote state requires operator action.                                         |
| Provider quota/auth failure         | Checkpoint and pause. Renew through supported credential owner or request re-authentication; no paid fallback without explicit opt-in.                                             |
| VPS disk loss                       | Restore SQLite consistently plus digest-checked artifacts from encrypted off-host backup on a clean host; recover secrets separately. Rerun checks if identity cannot be proved.   |

Recovery artifacts are a safe patch/content bundle plus base identity, not a copy
of candidate `.git`, HOME, process memory or login caches. A clone can be rebuilt;
unpublished work cannot be recovered unless checkpointed. State clearly how much
work a checkpoint interval can lose; no zero-loss or exactly-once claim is made.

## Incremental implementation without duplicate issues

| Phase | Deliverable and owner                                                                                                                                                                                                                                     | Exit evidence                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Host preflight and resource lifecycle follow-up (R11 below); no deployment in this research                                                                                                                                                               | Disposable host validates rootless/cgroup/quota/network prerequisites; failures remain plan-only.                                       |
| 1     | Existing [#177](https://github.com/jellydn/flowly/issues/177) verifier isolation and [#178](https://github.com/jellydn/flowly/issues/178) Git/credential boundary                                                                                         | Real offline checks and host/sibling/network/Git canaries pass, no host fallback.                                                       |
| 2     | Existing [#179](https://github.com/jellydn/flowly/issues/179) journal, R11 per-attempt native resource ownership, [#180](https://github.com/jellydn/flowly/issues/180) simple approval, [#181](https://github.com/jellydn/flowly/issues/181) exact checks | One queued job at a time; cancellation, reboot, orphan resource and duplicate effects tested.                                           |
| 3     | Existing [#182](https://github.com/jellydn/flowly/issues/182) candidate recovery plus backup/restore under #179                                                                                                                                           | Restore on clean disposable host without original directory; corrupt/missing artifacts fail closed; GC cannot delete active work.       |
| 4     | Existing [#183](https://github.com/jellydn/flowly/issues/183) authorized held-out VPS pilot; optional [#184](https://github.com/jellydn/flowly/issues/184) subscription validation                                                                        | Report acceptance, cost including failures, recovery, latency and human intervention. No runtime/vendor adoption without measured need. |

**R11 is the missing scope:** native runtime resource ownership across the whole
attempt, admission capacity and host preflight. #177 owns verifier confinement;
#182 owns candidate transport. R11 should extend ADR 0007 rather than reopen it.
Track it in [#186](https://github.com/jellydn/flowly/issues/186).
No follow-up should enable autonomy or deploy as a side effect of merging.

## Unknowns before activation

- Actual VPS kernel, cgroup delegation, user namespaces, disk quotas, free
  capacity, sibling workload sensitivity, KVM availability and backup restoration.
- Compatibility of each repo's tests with offline, non-root execution; private
  dependency preparation without leaking credentials or permitting install scripts.
- The operator's resource/retention budgets and acceptable shared-kernel risk.
- Flowly subscription route eligibility, terms, refresh and real inference; vendor
  subscription support does not transfer entitlement to another application.
- Vendor exact account concurrency, disaster-recovery SLA and full command-audit
  guarantees where not stated above. No proprietary isolation escape tests were run.

## Official evidence index

All sources read on 2026-10-24. This is an access-date inventory, not an immutable
vendor snapshot. Claims concern the linked product mode only.

| Key | Official source                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| A1  | [Amp Orbs](https://ampcode.com/docs/orbs)                                                                             |
| A2  | [Amp setup, resume and project snapshots](https://ampcode.com/docs/orbs/customizing)                                  |
| A3  | [Amp self-hosted dispatch, persistence matrix and data flow](https://ampcode.com/docs/orbs/self-hosted)               |
| A4  | [Amp sizes, costs and pause rules](https://ampcode.com/docs/orbs/sizes-and-costs)                                     |
| A5  | [Amp secrets and OIDC](https://ampcode.com/docs/orbs/handling-secrets)                                                |
| A6  | [Amp persistent runners and worktrees](https://ampcode.com/docs/cli/runners)                                          |
| C1  | [Cursor managed security boundary and auditability](https://cursor.com/docs/cloud-agent/security.md)                  |
| C2  | [Cursor setup, Builds and recovery](https://cursor.com/docs/cloud-agent/setup.md)                                     |
| C3  | [Cursor secrets, network and retention](https://cursor.com/docs/cloud-agent/security-network.md)                      |
| C4  | [Cursor Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted)                                        |
| C5  | [Cursor models and pricing](https://cursor.com/docs/models-and-pricing.md)                                            |
| D1  | [Devin blueprints, snapshots and sessions](https://docs.devin.ai/onboard-devin/environment/blueprints)                |
| D2  | [Devin managed enterprise deployments](https://docs.devin.ai/enterprise/deployment/overview)                          |
| D3  | [Devin Outposts overview and limits](https://docs.devin.ai/cloud/outposts/overview.md)                                |
| D4  | [Devin secret scopes and command binding](https://docs.devin.ai/product-guides/secrets)                               |
| D5  | [Devin usage and sleep](https://docs.devin.ai/admin/billing/usage.md)                                                 |
| D6  | [Devin security profiles and Outposts network enforcement](https://docs.devin.ai/product-guides/security-profiles.md) |
| D7  | [Devin SSH, forwarding and file access](https://docs.devin.ai/cli/ssh.md)                                             |
| D8  | [Devin security, privacy and retention statements](https://docs.devin.ai/admin/security.md)                           |
| D9  | [Devin claims, teardown and resume directories](https://docs.devin.ai/cloud/outposts/orchestration.md)                |
| D10 | [Devin self-serve plans](https://docs.devin.ai/admin/billing/self-serve.md)                                           |
| D11 | [Devin ChatGPT integration and fallback differences](https://docs.devin.ai/admin/billing/chatgpt.md)                  |
| H1  | [Docker rootless mode and prerequisites](https://docs.docker.com/engine/security/rootless/)                           |
