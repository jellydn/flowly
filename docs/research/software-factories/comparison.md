# Compare control planes separately from coding runtimes

[Research index](./README.md) · [Exact source and commit inventory](./upstream-snapshot.json)

Checked 2026-10-24. **No replacement is recommended.** Borrow bounded workflow
and recovery patterns; evaluate one extra runtime only after Flowly's boundaries
and outcome measurements are ready. The snapshot contains pinned links to every
root license, README, inspected implementation, and latest commit, plus up to
five recent default-branch commit subjects. Those are the evidence behind the
tables; the analysis below links the implementation that most affects each choice.

## Maintenance and licensing can disqualify an otherwise useful design

Dates are the checked-out default-branch commit dates (UTC), not API `pushed_at`.
All 16 API responses reported `archived: false`; this is **not** proof of active
maintenance. In particular, Continue's own maintenance notice overrides that signal.

| Project and pinned revision                                                                                        | Root license inspected                         | Maintenance assessment at snapshot                                                                             | Local/self-hosting constraints and costs                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands/commit/fee10e3d2909ebbf9950578575b1ee011492171e) | MIT                                            | Active; 2026-10-24 UI changes, multiple recent commits                                                         | Node 24+, Python/uv; Docker recommended. Local control UI + agent server + automation service. Host mode gives agents host access. Model and compute cost; Cloud/Enterprise optional.                                               |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT/commit/11cdf466d042aece04fc6cfd13b28e1a70341b1f)             | MIT                                            | Low recent activity; 2026-01-21 merge of Windows-terminal support; no newer default-branch commit observed     | Python roles and tools run locally; Docker/configuration is operator responsibility. Multiple role calls increase model spend; budget manager exists. Do not infer hosted MGX rights from this license.                             |
| [SSSF](https://github.com/disler/super-simple-software-factory/commit/de31374882e7a4e3e5b7bb9bd09e69dc2f779356)    | MIT                                            | One commit returned, 2026-08-02; template snapshot, not demonstrated ongoing maintenance                       | Python/uv, Pi, SQLite; Bun for visualizer. Stamps code into the target repository. Model keys and local execution; not a turnkey isolated service.                                                                                  |
| [Warp client](https://github.com/warpdotdev/warp/commit/1e6c3ae465d6a925a9b97ae03877aaadd159b8f1)                  | AGPL-3.0; `warpui` and `warpui_core` MIT       | Active; 2026-10-22 ACP tool projection; recent remote-sandbox support                                          | Rust client build is available. Client source does not establish ownership of cloud services. Review AGPL obligations before reuse; hosted usage has separate terms.                                                                |
| [HumanLayer](https://github.com/humanlayer/humanlayer/commit/2f66a45b186d88488fa356862be0117db1ccae9f)             | Apache-2.0; vendored notices apply             | Active; 2026-10-24 README merge; recent removal of deprecated packages                                         | Bun monorepo, daemon, web/desktop, Postgres/Electric stack. Local devstack exists; self-hosting guides are in progress. Change default Compose passwords. Harness credentials/subscriptions and operations cost remain.             |
| [Kody](https://github.com/kody-hq/kody/commit/1e01a0514305d2e1c378ef447ccb3f7218d0a2b1)                            | FSL-1.1-ALv2                                   | Active; 2026-10-24 package-app publisher identity changes. Original repository redirects to `kody-hq/kody`.    | Cloudflare Workers, D1, KV, Durable Objects and related services. Local Wrangler is development, not evidence of vendor-neutral production hosting. Cloudflare/embedding/model costs; competing-use restrictions need legal review. |
| [Ultimate](https://github.com/tobi/ultimate/commit/11d1d4cd3f383150ca8b14b0ca6092cbfd9c85c2)                       | MIT                                            | Active; 2026-10-24 automation lock fix. Explicit personal project: no issue/PR support or migration guarantees | Node 26, pnpm, Pi credentials, SQLite, optional Chromium. Local-first and loopback server; extensions execute code. Runtime upgrades carry operator maintenance cost.                                                               |
| [OpenCode](https://github.com/anomalyco/opencode/commit/20a6cc72917586eb5314be075f96dbb21d16c480)                  | MIT at root; inspect package licenses on reuse | Active `dev` branch; 2026-10-24 models snapshot and recent reported-cost work                                  | Local runtime/server and clients, provider configuration, plugins. Permissions are not an OS sandbox. Model cost or local inference hardware; hosted offerings separate.                                                            |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent/commit/3ea751c087f32b16e039a2233dd6eefecef325d5)                | MIT                                            | 2026-07-16 benchmark/URL fixes; README recommends mini-SWE-agent going forward                                 | Python with SWE-ReX deployment; Docker default. Models, image setup and benchmark compute cost. Evaluate maintenance direction before adopting old agent APIs.                                                                      |
| [GPT Pilot](https://github.com/Pythagora-io/gpt-pilot/commit/9b763fdaf0020c7d8abacc7b58b2b09e57494623)             | FSL-1.1-MIT                                    | Explicitly unmaintained; 2026-06-12 security-removal merge, not normal feature maintenance                     | Python/database/local tools. Source notice reports credential-stealing code present Aug 2025–Jun 2026. Text inspection only; no deployment recommendation. FSL future conversion depends on the release date, not repository age.   |
| [Codex CLI](https://github.com/openai/codex/commit/970111f6cb62cc02fe36a82ea7d71b37a2889c97)                       | Apache-2.0                                     | Active; 2026-10-23 provider configuration and Guardian work                                                    | Local Rust runtime; platform-specific execution sandbox and permission profiles. Provider/account terms separate; local runtime does not make inference offline.                                                                    |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/commit/cd1b45c2db0a5ea7b7fc3b67c1ba5879601d6005)          | Apache-2.0                                     | Active; 2026-10-23 model discovery and cancellation fixes                                                      | Node CLI, provider/auth setup, configurable sandbox. Quota/API/infrastructure cost; no guaranteed free allowance assumed.                                                                                                           |
| [Cline](https://github.com/cline/cline/commit/40c5d99031fe1128189c5b52e40638d2b7787754)                            | Apache-2.0                                     | Active; 2026-10-24 desktop/SDK/SSH changes                                                                     | Editor/desktop/CLI and Hub surfaces now coexist. Local tools and provider keys; UI approval is not host isolation. Compute/provider and optional hosted-service costs.                                                              |
| [Goose](https://github.com/aaif-goose/goose/commit/0276d567aa00d426161c51e9c0f52baabe5958ea)                       | Apache-2.0                                     | Active; 2026-10-24 HTTPS/redirect allowlist hardening. `block/goose` redirects to `aaif-goose/goose`.          | Rust agent, CLI/desktop, SQLite sessions, MCP extensions/recipes. Tool capabilities and extension trust need configuration. Model and worker costs.                                                                                 |
| [Aider](https://github.com/Aider-AI/aider/commit/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)                         | Apache-2.0                                     | Low recent activity; 2026-05-22 model list update, earlier repomap changes                                     | Python local Git editing; no host sandbox established by sampled code. Provider/local model cost. Good bounded edit baseline, not a queue or approval service.                                                                      |
| [Continue](https://github.com/continuedev/continue/commit/5522c6f44ca0ac3528b37244818fbfa39b5af470)                | Apache-2.0                                     | Explicitly no longer actively maintained/read-only; 2026-07-21 removal of retired sign-in docs                 | Final 2.0.0 CLI/editor tools, local config and sessions. Headless defaults allow Bash and wildcard tools. Fork maintenance and provider costs; not a new dependency recommendation.                                                 |

FSL grants permitted internal use but restricts competing uses; its future
Apache/MIT license is time-dependent per version. Warp Factories is evaluated
below as a service plus configuration examples, **not** as AGPL client code.
No legal compatibility decision is implied by a permissive root license.

## Capability matrix: intake, orchestration and execution

**S** = observed in sampled source; **D** = documented by upstream, implementation
not fully audited here; **U** = unknown/not established in inspected scope.
“Harness” means the coding runtime, not the model provider. Switching models is
not harness independence. A role system is not automatically an agent supervisor.

| Project         | Task intake and planning               | Multi-agent orchestration                            | Harness independence                                          | Sandbox/worktree isolation                                             |
| --------------- | -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Flowly baseline | S issue event + grounded plan          | S typed stages, campaigns                            | S implementer interface; Flue-only production launcher        | S confined implementer clone; host verification gap                    |
| OpenHands       | D events/schedules, S service wiring   | D automation/ACP agents                              | D ACP backends; separate SDK                                  | S SDK Docker workspace; host mode explicitly unsafe for untrusted code |
| MetaGPT         | S idea → messages/roles                | S team/environment                                   | U external harness adapters; internal roles                   | U hardened per-task isolation                                          |
| SSSF            | S prompt/config → named phases         | S code-owned phase chains                            | S Pi adapter; other adapter files need separate validation    | S repository cwd; no mandatory task sandbox established                |
| Warp client     | S local/remote orchestration config    | S multi-agent request model                          | S harness field; D external CLI support                       | S remote selection; backend isolation not proven by client             |
| Warp Factories  | D GitHub/Slack/Linear/Jira → spec      | D factory agents/automations                         | D Warp/Claude/Codex options                                   | D managed Docker/Kubernetes/Direct; Direct shares host                 |
| HumanLayer      | S session dispatch; D tasks/plans      | S common lifecycle with agent executors              | S executor seam; D Claude/Codex/OpenCode/Pi                   | D host workspaces; U complete sandbox guarantees                       |
| Kody            | S MCP search/execute; not a planner    | S scheduled capability work; not a coding supervisor | S MCP capability interface, not interchangeable coding agents | S Cloudflare execution plumbing; U general repository OS sandbox       |
| Ultimate        | S project setup/harness                | D durable subagents/automations                      | S Pi Durable binding, not neutral harness contract            | S trust gate; U isolation from host after trust                        |
| OpenCode        | S session/permission services          | S durable child-job references                       | Runtime, not a neutral factory controller                     | U mandatory OS sandbox in sampled permission layer                     |
| SWE-agent       | D issue/benchmark input                | S agent/environment split                            | S SWE-ReX deployment seam, not harness interchange            | S Docker deployment default                                            |
| GPT Pilot       | S spec/architect/developer loop        | S role dispatch incl. parallel roles                 | U external harness seam                                       | U hardened host isolation                                              |
| Codex CLI       | Runtime task input; D planning         | U factory-stage orchestration                        | Runtime candidate                                             | S OS sandbox selection and network proxy integration                   |
| Gemini CLI      | Runtime task input; S plan mode policy | U factory-stage orchestration                        | Runtime candidate                                             | S sandbox mode/command policy; platform enforcement needs validation   |
| Cline           | Runtime sessions                       | U factory-stage orchestration                        | Runtime candidate / SDK                                       | S approval UI; U mandatory OS isolation                                |
| Goose           | Runtime sessions/recipes               | S session types include subagents                    | Runtime + MCP extensions                                      | U isolation defaults; approval modes are separate                      |
| Aider           | S edit/test loop                       | U factory-stage orchestration                        | Runtime candidate                                             | S local Git; U OS sandbox                                              |
| Continue        | S local sessions / plan policies       | U factory-stage orchestration                        | Runtime candidate                                             | S tool policies; plan mode still allows Bash                           |

## Capability matrix: recovery, gates, publication and measurement

The rows describe sampled evidence, not a ranking. “Can run tests” is weaker than
“cannot publish without required checks.” No inspected CLI alone establishes
Flowly's complete issue → review → idempotent draft-PR contract.

| Project        | Persistence/recovery                                 | Human approvals                              | Tests / CI gates                               | PR automation                                    | Observability / costs                                                       |
| -------------- | ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Flowly         | S snapshots/events/local lifecycle; cross-runner gap | S boundary gates; no actor-bound receipt     | S local command/pristine checks; CI separate   | S draft publisher/reuse                          | S events/evals; factory billed cost incomplete                              |
| OpenHands      | S mounted state + automation DB config; D recovery   | D agent confirmation                         | D automation checks; U mandatory PR gate       | D GitHub automations                             | D run UI; provider/compute cost                                             |
| MetaGPT        | S team/context serialization                         | U authenticated approval gate                | D role checks; U immutable release gate        | U trusted publisher                              | S shared cost manager                                                       |
| SSSF           | S SQLite trace + agent-session map                   | S engineer phase, not identity proof         | S typed envelopes + acceptance gates           | U GitHub idempotent publisher                    | S phases, tokens/cost; reported/estimated quality not validated             |
| Warp client    | U end-to-end durable effect replay                   | S orchestration approval state               | U factory release gate from client             | U from client alone                              | D session UI; service billing separate                                      |
| Warp Factories | D hosted run storage                                 | D spec/merge human reviews                   | D review workflows                             | D issue-to-reviewed-PR                           | D platform/compute/inference metering; external inference not fully counted |
| HumanLayer     | S synchronized sessions/approval records             | S explicit approved/denied session decisions | U mandatory check gate                         | S PR observation, not proof of gated publication | S session lifecycle + diagnostics; host/harness costs                       |
| Kody           | S memory and run idempotency; scheduled lanes        | D scoped grants/secret approvals             | U coding CI gate                               | U generic factory publisher                      | S run/timing/entitlement data; Cloudflare + models                          |
| Ultimate       | S SQLite harness + supervisor swaps                  | S project trust; U commit-bound approval     | S typecheck before core swap                   | U draft-only PR contract                         | S supervisor lifecycle logs; model/host cost                                |
| OpenCode       | S session DB/execution claims                        | S rules + ask/reply                          | U mandatory factory gate                       | U idempotent draft contract                      | S session store; recent cost reporting commits                              |
| SWE-agent      | D trajectories/replay                                | U human release gate                         | S environment commands; D benchmark evaluation | D PR workflows; not audited here                 | D trajectories/model budgets; benchmark compute                             |
| GPT Pilot      | S project state transitions/restoration              | S human-input role                           | S executor/task roles; U strict CI gate        | U trusted publisher                              | S stats/telemetry calls; historic security incident                         |
| Codex CLI      | U recovery contract in sampled execution layer       | S permission profile plumbing                | Can execute checks; U factory gate             | U draft-only contract                            | U normalized factory cost/acceptance outcome                                |
| Gemini CLI     | S JSONL session record/resume                        | S modes and approved tools                   | Can execute checks; U factory gate             | U draft-only contract                            | S session records; quota/model cost                                         |
| Cline          | U durable approval replay                            | S deny on missing/disconnected UI            | U mandatory factory gate                       | U draft-only contract                            | S approval events; provider cost                                            |
| Goose          | S SQLite session manager                             | S tool permission resolution                 | U mandatory factory gate                       | U draft-only contract                            | S session usage/cost types                                                  |
| Aider          | S Git history; U durable stage replay                | S interactive confirmation path              | S auto-lint; auto-test off by default          | S auto-commit, not trusted PR publisher          | S token/cost fields; provider pricing needed                                |
| Continue       | S JSON session resume                                | S TUI ask; headless auto-allow               | U mandatory factory gate                       | U draft-only contract                            | S session usage; no active maintenance                                      |

## Source-backed lessons and adoption choices

### OpenHands: reuse execution separation, not an old repository map

[Canvas entrypoint][oh] starts agent-server, automation, and static ingress.
Its [version pins][oh-pins] specify agent server 1.58.1 and automation 1.25.1.
The named repository is no longer the old Python monolith. The separate
[SDK DockerWorkspace][oh-sdk] provisions an agent-server container and exposes
remote operations; explicit volume/env forwarding makes the boundary reviewable.
The SDK snapshot is current source, not a claim that it exactly matches the
Canvas package pin. Local host mode explicitly grants full filesystem access.

**Borrow:** separate trusted orchestration from a replaceable execution backend,
pin images, and test mounts/credentials. **Do not infer:** the installed automation
package's PR retry behavior from the UI. Its complete implementation and exact
release pairing were not audited; deployment smoke tests remain necessary.

### SSSF: code owns acceptance; session continuation is not effect recovery

[Run.phase and Run.finish][sssf-run] distinguish a completed phase from an
accepted run. [Agent execution][sssf-agents] uses typed envelopes, bounded JSON
repair and gate corrections in the same Pi session. [Test gate][sssf-gates]
runs a shell command without a timeout at that call site: it is not evidence of
an end-to-end deadline. SQLite traces and session IDs preserve context, but do
not by themselves make pushes, commits or external writes exactly once.

**Borrow:** explicit acceptance predicates, bounded repair, stable attempt IDs,
and phase-level accounting. **Do not adopt wholesale:** the template operates in
the repository cwd and needs a stronger execution boundary. Flowly already owns
stage transitions; it does not need a second Python orchestrator.

### Ultimate: durable state and supervised swaps, with an explicit trust gate

[Harness][ultimate-harness] imports Pi Durable and SQLite storage.
[Supervisor][ultimate-supervisor] forks generations, checks replacements and
coordinates swaps; crash retry uses backoff. [Project setup][ultimate-trust]
requires a trust decision before loading project settings. The README says the
supervisor itself needs a manual restart and warns of incompatible changes with
no migration path. Thus “self-modifying” does not mean every process update is safe.

**Borrow:** persist intent before display/effects, stable process generations,
and explicit project-code trust. **Reject for the MVP:** self-rewriting control
plane and arbitrary hot-loaded tools. A worker restart must not alter approval
policy or silently rerun a remote effect.

### HumanLayer: normalize sessions and approvals without adopting its whole stack

[Shared session execution][humanlayer-session] separates lifecycle/interrupt
handling from agent-specific executors, including a lost-resume case and PR
observation. [Approval code][humanlayer-approval] explicitly recognizes approved
or denied states and scopes applied rules to a session. This is stronger evidence
than a “human in the loop” marketing claim, but does not require Flowly to adopt
commit-bound human approval. ADR 0010 keeps simple operator confirmation. The current Bun/Riptide monorepo is not just the
older HumanLayer approval SDK.

**Borrow:** typed normalized events, agent-specific adapters, explicit approval
states, and lost-session handling. **Defer:** shared live sessions and a
Postgres/Electric desktop/web control plane until multiple operators need them.
Self-hosting is possible in source, but production setup documentation is unfinished.

### Kody: discovery and durable capabilities are not a replacement coding agent

[Memory service][kody-memory] bounds records and supports ownership, audit,
lexical retrieval and optional vector indexing. [Search][kody-search] exposes a
bounded discovery surface. [Execute][kody-execute] accepts an optional idempotency
key and records/replays run results. [Scheduled lanes][kody-jobs] isolate failures
and distinguish retryable D1 contention. These are implemented capabilities, not
merely README promises. Reusable package/runtime code sits behind the MCP surface;
it requires permission and resource controls, not just a prompt catalog.

**Borrow:** narrow capability discovery with stable schemas, provenance and
idempotency keys. **Do not replace:** Flowly's existing evidence-based memory.
Defer executable packages and scheduled coding work until package provenance and
operator-authorized capabilities are enforced. FSL restrictions and Cloudflare production
dependencies rule out assuming a portable MIT-licensed drop-in.

### Warp client and Warp Factories are separate adoption questions

[Client orchestration configuration][warp-client] carries model, harness and
local/remote execution identity with approval state. Current source is real Rust
client code under AGPL/MIT, not merely an issue tracker. Recent commits add ACP
tool projection and Claude/Codex prewarmed-sandbox support (snapshot inventory).

The separately inspected [factory example][warp-example] is MIT configuration:
`workerHost` routes execution to customer compute. It is not source for the
factory scheduler. Current [infrastructure documentation][warp-security] says
Warp retains coordination, identity/configuration, storage, transcripts and
artifacts. Managed self-hosting requires Enterprise; platform charges remain
even with customer compute/inference. Prompts/results may leave the customer's
network. [Deployment patterns][warp-deployment] do not establish an offline,
self-hosted control plane. Factory implementation internals therefore remain **D/U**.

**Borrow:** factory-as-code and separate execution/inference/credential boundaries.
**Do not choose for a fully self-hosted Flowly requirement:** hosted control plane,
commercial dependency, and unaudited scheduler semantics. Confirm contract/pricing
if that requirement changes; do not copy client AGPL code into Flowly by default.

### MetaGPT and GPT Pilot: retain structured handoffs, avoid role proliferation

[MetaGPT Team][metagpt] serializes team/context, publishes messages and checks a
shared model budget. [GPT Pilot Orchestrator][pilot] dispatches specialist roles
from project state and restores earlier file state on human redo instructions.
These support staged planning, not proof of secure OS isolation or idempotent PR
delivery. Flowly already has classifier, planner, implementer and reviewer roles.

**Borrow:** explicit plan artifacts and acceptance feedback. **Do not adopt:** a
large role graph without a measured benefit. GPT Pilot is unmaintained and its
[security notice][pilot-notice] records a removed supply-chain payload; its last
merge is remediation, not a reason to trust or execute it. MetaGPT's low recent
activity makes adapter maintenance a material cost.

### OpenCode and the six runtime alternatives: compare behind one contract

- **OpenCode:** [permissions][opencode-permission] separate ask/reply/evaluate;
  [session store][opencode-session] records execution claims and suspended work.
  Versioned configuration/plugins and multiple clients make it a candidate, not
  an automatic factory replacement. Review plugin privileges before enabling them.
- **Codex CLI:** [execution sandbox][codex] has OS-specific sandbox transforms,
  network proxy and credential-boundary plumbing. This makes it a useful first
  isolation comparison; inspect actual policy defaults and supported platform
  behavior in a disposable adapter trial. Do not assume “CLI” implies offline.
- **Gemini CLI:** [sandbox policies][gemini] define plan/default/editing modes,
  per-command paths/network and overrides. [Recording][gemini-recording] writes
  JSONL and restores sessions. Validate cancellation and denial behavior rather
  than translating all modes to a generic “approved” boolean. The pinned README
  says unpaid-tier/Google One users moved to Antigravity CLI on 2026-06-18 and
  warns that Gemini CLI is not optimized for the newest models. Active commits
  therefore do not imply unchanged account eligibility or model support.
- **Cline:** [Hub approvals][cline] reject disconnected or missing UI approvals.
  A headless adapter must preserve that fail-closed behavior, not silently enable
  auto-approve when no operator is connected.
- **Goose:** [approval operation][goose] resolves tool permissions from session
  messages; [SQLite session manager][goose-session] has explicit schema version,
  session types and usage. Recipes/MCP are useful extension patterns, but a
  recipe is not Flowly's trusted release policy.
- **Aider:** [coder loop][aider] supports lint/test repair and Git commits;
  `auto_test` defaults false. Disable autonomous commit behavior in an adapter
  and let Flowly own evidence and publication. Lower recent activity raises risk.
- **Continue:** [default policies][continue-policy] allow Bash/wildcard tools
  headlessly, and plan mode still allows Bash. [Session storage][continue-session]
  is local JSON. Its explicit maintenance notice makes it a reference, not the
  preferred new runtime; plan-mode naming must never substitute for enforcement.

**SWE-agent** supplies the evaluation comparison: [environment][swe-agent] uses
SWE-ReX and defaults to Docker, with explicit per-command timeouts and environment
setup. Use pinned base revisions, repeatable containers, saved results and held-out
tasks. Do not compare published SWE-bench scores directly with Flowly's small
deterministic suite or call “patch produced” a human-accepted PR. The README now
recommends mini-SWE-agent; adoption of that separate project needs its own audit.

## Decision rule and alternatives

Prioritize: (1) enforced safety/correctness, (2) human control and recovery,
(3) local operation and maintainability, then (4) measured acceptance, cost and
elapsed time. Do not assign fabricated numeric scores to untested deployments.

| Choice                                    | Decision                              | Reason / condition to reconsider                                                                                              |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Keep Flue + harden Flowly                 | Recommended                           | Least migration work; preserves current policy, tests and draft-only contract                                                 |
| Add Codex or OpenCode implementer adapter | Experiment after MVP gates            | Accept only if the same safety suite passes and held-out tasks improve acceptance or cost/time                                |
| Adopt OpenHands control plane             | Defer                                 | Useful sandbox model, but migration duplicates orchestration; reassess if remote agent-server operations become a requirement |
| Adopt HumanLayer control plane            | Defer                                 | Shared session demand not established; heavier operational stack                                                              |
| Adopt Warp Factories service              | Not for full self-hosting requirement | Execution can be local, control plane is hosted and commercially gated                                                        |
| Adopt Kody/Ultimate wholesale             | Reject for MVP                        | Different product boundary; license/platform or unsupported self-modification risk                                            |
| Adopt MetaGPT/SSSF/GPT Pilot              | Reference patterns only               | Flowly already has typed stages; maintenance/isolation or supply-chain concerns outweigh replacement benefit                  |
| Add a dashboard first                     | Defer                                 | Existing CLI can expose new evidence; a UI cannot repair execution or recovery                                                |

[oh]: https://github.com/OpenHands/OpenHands/blob/fee10e3d2909ebbf9950578575b1ee011492171e/docker/entrypoint.sh
[oh-pins]: https://github.com/OpenHands/OpenHands/blob/fee10e3d2909ebbf9950578575b1ee011492171e/config/defaults.json
[oh-sdk]: https://github.com/OpenHands/software-agent-sdk/blob/acd96e6fa424c02432304395b9208f99be24b54d/openhands-workspace/openhands/workspace/docker/workspace.py
[sssf-run]: https://github.com/disler/super-simple-software-factory/blob/de31374882e7a4e3e5b7bb9bd09e69dc2f779356/.claude/skills/sssf/templates/adws/adw_modules/runner.py
[sssf-agents]: https://github.com/disler/super-simple-software-factory/blob/de31374882e7a4e3e5b7bb9bd09e69dc2f779356/.claude/skills/sssf/templates/adws/adw_modules/agents.py
[sssf-gates]: https://github.com/disler/super-simple-software-factory/blob/de31374882e7a4e3e5b7bb9bd09e69dc2f779356/.claude/skills/sssf/templates/adws/adw_modules/gates.py
[ultimate-harness]: https://github.com/tobi/ultimate/blob/11d1d4cd3f383150ca8b14b0ca6092cbfd9c85c2/server/harness.ts
[ultimate-supervisor]: https://github.com/tobi/ultimate/blob/11d1d4cd3f383150ca8b14b0ca6092cbfd9c85c2/bin/ultimate.ts
[ultimate-trust]: https://github.com/tobi/ultimate/blob/11d1d4cd3f383150ca8b14b0ca6092cbfd9c85c2/server/project-setup.ts
[humanlayer-session]: https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-daemon/src/agents/shared/run-session.ts
[humanlayer-approval]: https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-daemon/src/agents/claudecode/approvals.ts
[kody-memory]: https://github.com/kody-hq/kody/blob/1e01a0514305d2e1c378ef447ccb3f7218d0a2b1/packages/worker/src/mcp/memory/service.ts
[kody-search]: https://github.com/kody-hq/kody/blob/1e01a0514305d2e1c378ef447ccb3f7218d0a2b1/packages/worker/src/mcp/capabilities/meta/search.ts
[kody-execute]: https://github.com/kody-hq/kody/blob/1e01a0514305d2e1c378ef447ccb3f7218d0a2b1/packages/worker/src/mcp/capabilities/meta/execute.ts
[kody-jobs]: https://github.com/kody-hq/kody/blob/1e01a0514305d2e1c378ef447ccb3f7218d0a2b1/packages/jobs-worker/src/scheduled.ts
[warp-client]: https://github.com/warpdotdev/warp/blob/1e6c3ae465d6a925a9b97ae03877aaadd159b8f1/crates/ai/src/agent/orchestration_config.rs
[warp-example]: https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/07-self-hosted-worker/factory.yaml
[warp-security]: https://docs.warp.dev/factories/infrastructure-and-security
[warp-deployment]: https://docs.warp.dev/factories/deployment-patterns
[metagpt]: https://github.com/FoundationAgents/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/team.py
[pilot]: https://github.com/Pythagora-io/gpt-pilot/blob/9b763fdaf0020c7d8abacc7b58b2b09e57494623/core/agents/orchestrator.py
[pilot-notice]: https://github.com/Pythagora-io/gpt-pilot/blob/9b763fdaf0020c7d8abacc7b58b2b09e57494623/README.md
[opencode-permission]: https://github.com/anomalyco/opencode/blob/20a6cc72917586eb5314be075f96dbb21d16c480/packages/core/src/permission.ts
[opencode-session]: https://github.com/anomalyco/opencode/blob/20a6cc72917586eb5314be075f96dbb21d16c480/packages/core/src/session/store.ts
[codex]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/exec-server/src/process_sandbox.rs
[gemini]: https://github.com/google-gemini/gemini-cli/blob/cd1b45c2db0a5ea7b7fc3b67c1ba5879601d6005/packages/core/src/policy/sandboxPolicyManager.ts
[gemini-recording]: https://github.com/google-gemini/gemini-cli/blob/cd1b45c2db0a5ea7b7fc3b67c1ba5879601d6005/packages/core/src/services/chatRecordingService.ts
[cline]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/cline-hub/src/server/approvals.ts
[goose]: https://github.com/aaif-goose/goose/blob/0276d567aa00d426161c51e9c0f52baabe5958ea/crates/goose/src/agents/state_machine/ops_tool_approval.rs
[goose-session]: https://github.com/aaif-goose/goose/blob/0276d567aa00d426161c51e9c0f52baabe5958ea/crates/goose/src/session/session_manager.rs
[aider]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py
[continue-policy]: https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/permissions/defaultPolicies.ts
[continue-session]: https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/session.ts
[swe-agent]: https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/environment/swe_env.py
