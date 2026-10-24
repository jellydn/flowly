# Projects and runners: choose isolation by risk

Checked 2026-10-24 against [Flowly main](https://github.com/jellydn/flowly/commit/908714ae866200010d265227edf25d6f972ff869).
This is a source audit and proposed design, not an implemented runner service.
See [proposed ADR 0011](../../adr/0011-projects-and-runners.md). Preserve
[ADR 0010](../../adr/0010-vps-pilot-and-provider-policy.md): simple approval,
BYOK, conditional subscription access, plan-only default and draft-only publication.

## Recommendation

Use an operator-owned project registry and one execution contract in three stages:
local invocation, VPS execution, then an outbound connected local runner. Do not
require a container for read-only inspection or explicitly trusted local commands.
Use a worktree to separate concurrent changes, not to contain hostile code. For
untrusted native execution, use a private container and independent candidate
files, with a stronger VM boundary or refusal for threats the shared kernel cannot
contain. A remote runner is not automatically a sandbox.

The [job-environment research PR #187](https://github.com/jellydn/flowly/pull/187)
defines the untrusted VPS execution profile. Reuse it and
[#186](https://github.com/jellydn/flowly/issues/186), rather than creating another
scheduler or container backend. This document adds project selection and runner
placement. It does not incorporate that unmerged PR's files or change its status.

## Current behavior: other paths work, project selection is incomplete

| Surface / evidence                                                                                                                                | Current contract and limitation                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Repo assistant](../../../agents/repo-assistant.ts), [reader](../../../tools/repository.ts), [sandbox](../../../sandbox.ts)                       | `REPOSITORY_PATH` selects any readable local directory; default is `../oak`, not Flowly. The reader resolves the root, confines paths and skips symlinks. Six read-only tools; no native shell. This is not a remote runner or a per-request project selector.                                                                         |
| [PR reviewer](../../../agents/pr-reviewer.ts), [entrypoint](../../../scripts/review-pr.ts), [PR data](../../../review/pr-data.ts)                 | Checkout path defaults to cwd; GitHub repository/token and base/head SHAs come from environment. The launcher runs Flowly's agent path relative to its own cwd. Target checkout and installed Flowly must remain distinct.                                                                                                             |
| [Factory entrypoint](../../../scripts/run-factory.ts), [dispatch](../../../factory/dispatch.ts), [client](../../../github/client.ts)              | Path defaults to cwd. Task repository comes from payload; client/workspace repository comes from `GITHUB_REPOSITORY`. There is no single admission check here binding those identities to the source remote. Correct Actions configuration normally aligns them; arbitrary multi-project invocation must not assume that alignment.    |
| [Git adapter](../../../factory/git.ts)                                                                                                            | Creates separate clones, not linked worktrees; default base is `origin/main`. Checks workspace path, branch, remote and all push URLs against the source remote. This protects clone ownership but does not establish that the source remote is the GitHub client target. Git subprocesses inherit the host environment/configuration. |
| [Workspace lifecycle](../../../factory/workspace-lifecycle.ts), [store](../../../factory/workspace-store.ts)                                      | Tracks repository, run/attempt, base, leases and retention. Resume needs local resources. Default workspace root flattens `owner/repo` with a hyphen, which is not an injective repository key. Use opaque project IDs rather than extending this convention.                                                                          |
| [Verification](../../../factory/verification.ts), [implementation](../../../factory/implementation.ts)                                            | Commands run with workspace cwd and restricted environment plus Linux network isolation. HOME/PATH remain host values. Cwd and network isolation do not confine host files or shared caches. See existing [security analysis](./security.md), #177 and #178.                                                                           |
| [Run store](../../../factory/store.ts), [GitHub state](../../../factory/run-state-store.ts)                                                       | Issue lookup includes repository and number; this is already better than issue number alone. Local state is not a distributed lease authority. The proposed SQLite journal in #179 is not yet the factory default.                                                                                                                     |
| [Memory config](../../../memory/config.ts), [eval store](../../../eval/framework/store.ts), [share server](../../../scripts/eval-share-server.ts) | Memory is repository-associated, but local paths and policy are operator inputs. Eval storage defaults to cwd-relative `eval/results`, partitioned by suite/run, not a project authorization scope. Sharing has its own configured database. Do not claim all databases or artifacts are already project-scoped.                       |
| [Actions](../../../.github/workflows/event-router.yml), [event router](../../../github/events/router.ts)                                          | Actions checks out the repository containing Flowly and runs its npm scripts there. It does not install Flowly separately and acquire another target. Routing selects an agent, not a registered project/runner.                                                                                                                       |
| [API](../../../app.ts), [factory CLI](../../../scripts/factory.ts), [dashboard](../../../scripts/eval-dashboard.ts)                               | API mounts agents and ping; CLI inspects runs; dashboard reads one configured results directory. No project/runner registration API or job-placement UI exists. Do not accept arbitrary paths from prompts as a substitute.                                                                                                            |

**Available now:** from the installed Flowly checkout, set an absolute
`REPOSITORY_PATH` and invoke the existing read-only assistant:

```sh
REPOSITORY_PATH=/absolute/path/to/project npm start -- --input '{"message":"Explain the entry points"}'
```

This may send source content to the configured model provider and needs its key.
It was not live-run in this research. It does not enable factory writes, GitHub
publication, disconnected work, or cross-project server requests. Non-Git local
directories can be inspected; Git editing/publication needs a Git repository.

## Intake options

| Option                         | Benefit                                                                | Cost / decision                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured local registry      | No clone, explicit path permission, works offline apart from inference | **First.** Runner-local mapping from opaque project ID to canonical path; no path selected by job payload.                                                           |
| Clone on demand from Git URL   | Convenient clean VPS checkout                                          | **Second, but registered GitHub identity only.** Arbitrary URL intake adds SSRF, local transport, credential and submodule risks. No general URL fetcher in the MVP. |
| GitHub repository/issue intake | Natural continuation of current event router                           | Resolve authenticated repository ID to a registered project; reject unknown projects. Issue links select a task, not permissions. Same job contract as CLI.          |

Initially support registered `github.com` repositories on the VPS. Enterprise
hosts need explicit API/clone host configuration and tests, not inferred URL
rewrites. Local Git can have no remote; publication then remains disabled.

## Isolation decision matrix

“Trusted” means the operator accepts native code running with the selected local
account's authority, including dependency and generated-code risk. Ownership of a
repository alone is not that decision. Profiles cannot be downgraded by a model,
repository instructions, lack of Docker, or runner availability.

| Workflow / threat                                                           | Worktree                         | Sandbox/container                               | Reason                                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only local source questions, including non-Git folders                 | No                               | No                                              | Confined reader; do not execute repository scripts. Provider disclosure still needs permission.                                                        |
| Trusted local single edit in an explicitly chosen user checkout             | Optional                         | Optional                                        | Default to a managed worktree for writes. In-place use is explicit, exclusive, and preserves all pre-existing changes; no automatic reset/stash/clean. |
| Trusted local concurrent jobs                                               | Yes, distinct branch per attempt | No by default                                   | Separates index/files. Serialise shared Git mutations; worktree locks are not job locks.                                                               |
| Trusted local checks requiring host SDK/device                              | Optional managed worktree        | No, only with host-execution consent            | Useful host access is intentional. Bound processes/time/output; mark evidence as host-trusted, not isolated.                                           |
| Trusted worktree with reproducible dependency/runtime requirements          | Yes                              | Optional, both                                  | Container adds environment consistency. It must not expose shared Git metadata or sibling worktrees; export files if necessary.                        |
| Untrusted repository, PR, dependency scripts or unattended generated checks | No user-repo worktree            | Yes, independent clone/export in private volume | A worktree shares metadata/config/objects. Candidate gets no host credentials, HOME, sockets or sibling mounts.                                        |
| Deliberately hostile code on a VPS with sensitive sibling apps              | No                               | Separate VM boundary or refuse                  | Rootless containers share a kernel. Do not claim VM-equivalent isolation.                                                                              |
| Trusted publication of an isolated candidate                                | No requirement                   | Candidate container cannot publish              | Dedicated clean publisher checkout, exact tested content, fixed destination and scoped credential.                                                     |

For the untrusted profile retain #187's separate execution/verifier environments,
offline checks and resource limits. For trusted local work, do not mount credentials
into a container merely to imitate the host. “Both” is useful for concurrent trusted
work plus reproducibility, not a reason to mount a developer's common `.git` into
an untrusted container. A plain clone alone is not OS isolation either.

## Minimal architecture and contracts

```text
Local CLI ───────────────→ local admission → local executor
                                  │              │
                             local journal   managed checkout

GitHub / operator → VPS admission + journal → VPS executor
                            ↑         │
                     outbound poll    └→ trusted publisher → fixed GitHub target
                            │
                  registered local runner → local executor → bounded evidence
```

These are deployment modes of one job contract, not three orchestration systems.
In local-only mode journal and executor are in one process; no daemon or registration
service is required. VPS mode starts with one worker and concurrency one. Connected
mode adds outbound authenticated HTTPS polling; no inbound laptop port, remote
shell endpoint, SSH daemon or shared SQLite over a network filesystem.

### Identity, roots and configuration

- `projectId` is an opaque generated ID, not a directory basename or owner/repo
  slug. A local binding is `(runnerId, projectId, canonicalRoot)`. Git identity also
  records its canonical common Git directory; linked worktrees are the same repo.
- A GitHub binding adds API host plus immutable repository numeric ID, display
  owner/name, installation/credential reference, approved clone/push destination
  and base branch. Resolve base to a SHA at admission; do not assume `main`.
  Renames update display names only after authenticated identity confirmation;
  transfers require renewed operator permission. A fork is a different project.
- A job freezes project, runner, run/attempt, lease generation, base SHA, trust
  profile and policy revision. Candidate/check records add content/SHA and runtime
  identity. Issue/PR/event IDs are always paired with repository identity.
- Install Flowly outside targets. Resolve target cwd explicitly for each tool,
  verifier and Git operation. Never change global cwd or mutate shared process
  environment to switch concurrent requests. Provider clients and readers are
  job-scoped; cache keys include project/base/policy as applicable.
- Operator registry is outside candidate writes. Local runner allowlists exact
  roots or explicitly approved parent roots; resolve real paths and Git common
  directories before admission and again before destructive operations. Reject
  traversal, symlink escapes, reparse/mount substitutions and overlapping managed
  roots. String-prefix tests alone are insufficient. A user-owned local source
  directory is never a GC target. Concurrent hostile filesystem mutation needs
  OS isolation, not a claim that realpath eliminates every race.
- Repository instructions remain lower-priority data. The operator approves check
  commands and image/setup policy; candidate config cannot add mounts, secrets,
  network permissions or a publication destination. Submodules/LFS are off until
  explicitly allowed and acquired under the same host/credential policy.

### Runner registration and disconnects

- Local-only mode uses an implicit local runner. Connected mode requires a
  short-lived one-time pairing secret approved at the VPS and locally, then a
  cryptographically random, revocable per-runner credential stored outside projects.
  It authorizes only assigned project jobs and their artifacts, never administration
  or publication. Protect the HTTPS channel; reject replayed enrollment/nonces.
- Runner reports OS/architecture, tool versions, supported execution profiles,
  capacity and approved project IDs. VPS selects only the intersection with its
  policy; runner rechecks its local allowlist. Advertised capabilities are not
  attestation: the operator must trust a runner that can supply test evidence.
- A runner polls for one leased attempt, acknowledges it and renews its lease.
  Use a local monotonic deadline and coordinator fencing generation. No new work
  after disconnect; stop active command groups at lease expiry, retain bounded
  checkpoints, and report interrupted rather than success. The VPS must not reuse
  a local checkout until the runner confirms it is quiescent.
- On reconnect, submit current attempt/generation and artifact digests. The VPS
  rejects stale completions and never publishes them. A fenced retry on an isolated
  different executor can proceed, but cannot undo an offline host-trusted command's
  side effects. Therefore remote jobs must not contain deployments or shared-data
  writes; cancellation is best effort for those effects, not exactly once.
- Start with Linux execution. Other OS profiles may inspect files, but execution
  is advertised only after process-tree cancellation, path and permission tests
  pass on that OS. No silent host fallback when isolation is unavailable.

### Checkout ownership, locks and recovery

- Managed branch: `factory/<opaque-run-id>-a<attempt>`. Record project, runner,
  attempt, branch, canonical path, base SHA and generation before allocation;
  reconcile interrupted allocation before retrying. Do not adopt an existing
  unowned branch/directory or overwrite the user's dirty checkout.
- Worktrees use a dedicated managed parent outside the user's source tree; avoid
  branch reuse and force options. Serialise allocation, refs, fetch and cleanup
  by canonical common Git directory. Separate job leases protect active execution;
  Git's `worktree lock` only protects lifecycle operations/pruning.
- Keep current `FactoryWorkspaceManager` contracts and extend #179/#186 with
  project/runner keys. Local OS locks coordinate local processes; the VPS journal
  owns remote leases. Never treat a PID on another machine as a lock owner.
- Cleanup requires recorded ownership, terminal state, expired/no active lease,
  and retained recovery evidence. Inspect Git worktree state before removal;
  preserve dirty/untracked work for operator review. No global `git clean`,
  force-remove, Docker prune or age-only deletion. Missing removable disks and
  disconnected runners are unavailable, not disposable.
- After crash, reconcile journal against owned directories/containers and any
  remote effect. Restore bounded content through #182, not candidate `.git`,
  home directories or credentials. Missing/mismatched identity requires input.

### State, artifacts, secrets and publication

- Namespace state by project/run/attempt/generation, with repository IDs stored
  as data, not path segments. One VPS SQLite DB is sufficient if every key/query
  carries project identity; local-only mode has a local journal. Keep scratch
  per runner. Artifacts have project ownership, size limits, digest and retention;
  download/upload checks enforce the same assignment as jobs. No arbitrary paths.
- Eval history, memory, retrieval indexes and share records must carry project
  identity before a multi-project UI is enabled. Migration assigns legacy data to
  an explicit project or quarantines it; never infer ownership from suite names.
  No shared writable dependency caches initially. Read-only caches key on approved
  image/toolchain/platform/lockfile and policy, and must not contain credentials.
- Provider keys stay at the trusted model-call boundary. Standalone local mode
  uses the owner's local provider config. Connected mode initially retains model
  calls on the VPS and sends bounded tool work; approve source/artifact transfer
  during enrollment. Do not tunnel arbitrary HTTP or copy provider refresh tokens
  to candidates. Optional subscription validation remains #184.
- Separate acquire, execute and publish network policy. Acquire uses a fixed
  approved host and short-lived read credentials; refuse URL userinfo, local/file
  transports, redirects to unapproved hosts and private/metadata targets. Candidate
  execution is offline in the untrusted profile. Trusted-local host network access
  must be explicit and visible. Publisher alone gets write credentials.
- Publisher binds API repository ID, clone destination and push destination to
  the admitted project, including all push URLs and URL rewrite effects. Ignore
  candidate hooks/helpers/config as specified in #178. Recheck exact branch/head
  and generation before effects; a changed source remote cannot redirect a run.
  Push exact tested content, then independent review/draft publication under current
  policy. No forced push to unowned refs, automatic approve/merge/deploy.
- In VPS-coordinated mode the local runner never receives publication credentials.
  Export validated files/patch to the VPS publisher; rerun mandatory checks there
  when it has the required capability. Otherwise accept evidence only from an
  explicitly trusted runner profile and record that weaker provenance. No automatic
  remote publication from an untrusted runner's claimed test result.

## Cross-project risks and acceptance probes

No real credential leak or deployed multi-project exploit was demonstrated.
These are requirements for the proposed service, not claims that it exists today.
Existing host/Git execution gaps retain their severity in the earlier security
analysis. The highest-consequence new gap is repository confusion at admission.

| Risk                                                                                      | Required negative test                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong repository / publication (high if multi-project writes are enabled; OWASP A01:2021) | Payload A + environment/client B + checkout C must fail before model, file or GitHub writes; also test forks, same issue number, rename/transfer, changed push URL and non-main base. |
| Path/config escape (high for remote native execution; A03/A05:2021)                       | Reject `..`, symlinked roots, prefix-neighbor paths and job-supplied cwd; setup text cannot select mounts or commands with wider authority.                                           |
| Credentials/cache bleed (high; A01/A02:2021)                                              | Two projects with distinct synthetic canaries: no cross-project files, env, indexes, memory, caches or artifact downloads; candidate cannot read publisher HOME/socket.               |
| Stale runner/evidence (high for publication; A08:2021)                                    | Disconnect, expire lease, issue new generation, reconnect old process: old result cannot publish; only owned old resources can be cleaned.                                            |
| Local data loss (high impact; A01:2021)                                                   | Dirty user tree and sibling worktree survive allocate/cancel/crash/GC byte-for-byte; missing mount is not pruned.                                                                     |
| Resource exhaustion (operational; A05:2021)                                               | Oversized artifact/history, disk full and runaway children stop within policy without affecting another project; reserve host capacity.                                               |

Use [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
for object-level project/runner checks and
[SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
for acquisition. HTTP headers are not a substitute for those controls. The local
dashboard's redaction is not authorization or a public data-sanitization guarantee.

## Phased delivery and non-goals

1. **Local project registry and read-only invocation:** stable identity, separate
   Flowly/target roots, project-scoped context, explicit local selection. No daemon,
   containers or GitHub credentials required. This is the first safe vertical slice.
2. **Trusted local write lifecycle and registered VPS GitHub intake:** managed
   worktrees for trusted concurrency; independent clones/containers for untrusted
   execution. Bind identity before any side effect. Reuse #177–#182 and #186 for
   isolation, trusted Git, journal, exact checks and recovery; do not duplicate them.
3. **Connected local runner:** outbound pairing/polling, capability intersection,
   project allowlists, leases, bounded artifacts and disconnect tests. Depends on
   stages 1–2 and journal fencing; no remote shell product or general scheduler.

| Priority / complexity | Follow-up                                                                                   | Dependencies                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1 / M                | [#188: local identity and scoped context](https://github.com/jellydn/flowly/issues/188)     | ADR review; no container/VPS prerequisite                           |
| P1 / M                | [#189: trusted local worktree lifecycle](https://github.com/jellydn/flowly/issues/189)      | #188; reuse #179/#186 ownership contracts                           |
| P1 / L                | [#190: registered VPS intake and publication](https://github.com/jellydn/flowly/issues/190) | #188; #177/#178/#179/#181/#182/#186 before live untrusted execution |
| P2 / L                | [#191: connected local runner](https://github.com/jellydn/flowly/issues/191)                | #188–#190 and #179/#182/#186                                        |

M means several modules and integration tests; L crosses process/host boundaries
and needs fault injection. These are complexity estimates, not dates. Each issue
has independently testable acceptance criteria and can land disabled. This PR
contains no runtime slice: a partial path switch without identity and state binding
would imply safety it does not provide. The existing read-only path already works;
documenting it is safer than adding another unconnected CLI flag.

Before activation the owner must select registered roots/repositories, permit
source transfer to the VPS/provider, approve which projects may use host execution,
and accept the VPS container threat model or require a separate VM. Linux-first
execution and GitHub-only remote intake are proposed MVP limits, not requirements
to abandon other local projects. ADR 0011 remains proposed until reviewed.

## Evidence and verification limits

- [Git worktree manual](https://git-scm.com/docs/git-worktree), read 2026-10-24:
  linked worktrees share refs/config/object storage, separate HEAD/index; clean
  removal and explicit locks protect lifecycle, not security boundaries.
- [Docker security](https://docs.docker.com/engine/security/), read 2026-10-24:
  namespaces/cgroups, daemon/socket authority, unsafe mount configuration and
  shared-kernel residual risks. Rootless mode is not a VM.
- Flowly source links above anchor the audit to the stated main commit. PR #187
  is a separate proposed environment design; its conclusions are not runtime proof.
- No live inference, VPS connection, runner pairing, credential handling trial or
  hostile code execution was performed. Acceptance probes describe future tests.
  Documentation/link checks and a disposable Git worktree probe validate this
  document's mechanics, not the proposed distributed system.

Validation on this documentation branch: `npm run check` passed (691 tests,
zero failures, typecheck, deterministic eval gate, build and documentation guard;
11 ADRs indexed). Targeted `oxfmt --check` and relative-link checks passed; the
four external Git/Docker/OWASP references returned HTTP 200. Disposable probes
confirmed two independent non-Flowly reader roots with traversal denied, shared
worktree Git configuration, and refusal to remove dirty worktrees. The new ADR
card was rendered and inspected at 1280px and 390px. A pre-existing narrow-page
overflow remained 656px with or without the new 342px-wide card; no unrelated
layout fix is included. No live runner behavior is claimed by these checks.
