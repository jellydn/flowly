# Keep untrusted code outside credential-bearing processes

[Research index](./README.md) · [Follow-ups](./roadmap.md)

## Scope and posture

**Needs attention before unattended execution.** This is a focused source audit
of factory execution, state, authorization, and publication, not a full product
penetration test or dependency vulnerability scan. Findings: **2 high, 3 medium**.
Severity assumes an operator has allowed implementation; the default plan-only
gate materially reduces exposure. No live exploit or credential access was used.

Threat actors include a malicious issue author, a compromised dependency or
repository instruction, an injected model response, a malicious executable
extension, and an overlapping or stale worker. Protected assets are host files,
provider/GitHub credentials, other runs, the approved plan, and publication rights.

```text
UNTRUSTED: issue, repo files, dependency scripts, model output, memory evidence
                         │ data only
                         ▼
TRUSTED: admission → pinned policy/plan → run store → review/approval decisions
                         │ narrow execution request
                         ▼
ISOLATED: credential-free implementation and verification
                         │ bounded diff + check evidence, never authority
                         ▼
TRUSTED: revalidate SHA + approval → scoped publisher → draft PR
                         │
                         ▼
HUMAN: repository review / branch protection / merge outside Flowly
```

## S1 — High: network denial does not isolate verification from the host

**Evidence:** [FactoryVerificationRunner](../../../factory/verification.ts) executes
`/bin/sh -c` in the clone. Denied-network mode adds `unshare --net`, UID/GID
selection and `setpriv --no-new-privs`, but no private mount or PID namespace.
`safeEnvironment()` retains host `HOME`, `PATH`, and `TMPDIR`.
[The caller](../../../factory/implementation.ts) supplies plan commands.

**Impact:** once implementation is authorized, generated tests or dependency
scripts can read or change same-user host files. Blocking network routes does
not stop local tampering or copying data into a diff or output artifact. A clean
Git worktree check cannot detect writes outside that worktree.

**Fix:** run verification in a disposable container or stronger sandbox with
only the candidate tree mounted, private HOME/tmp/PID space, no Docker socket,
no host credentials, denied egress, resource limits, and fail-closed setup. Keep
dependency preparation separate from candidate execution. Deny access to cloud
metadata even when a preparation network allowlist is enabled.

**Acceptance evidence:** a harmless host canary and sibling workspace are unreadable
and unchanged; DNS, TCP and local host sockets are denied; timeout kills children;
real offline checks pass. Test the boundary, not only the capability manifest.
Follow-up **R1**. OWASP Top 10 **A04:2021 Insecure Design** and **A05:2021 Security
Misconfiguration**; [Docker security guidance][docker-security].

## S2 — High: trusted Git consumes metadata from a writable clone

**Evidence:** [implementer](../../../agents/factory-implementer.ts) roots
`ReadWriteFs` at the whole clone. [Git adapter](../../../factory/git.ts) runs Git
with its normal config lookup and inherited environment; commit and push do not
set a trusted hooks directory or exclude clone-controlled helpers/filters.
[The process launcher](../../../factory/agent-implementer.ts) also spreads
`process.env` into the Flue child. The model's virtual shell is not evidence that
trusted subprocess configuration is safe.

**Impact:** writing Git metadata can change later trusted command behavior. A
branch/remote ownership check is not a defense against all Git execution hooks.
The exact exploitability of each metadata path needs disposable testing; this
audit does not claim that a real token was exposed.

**Fix:** exclude `.git` and nested Git metadata from writable agent surfaces;
transfer a validated diff into a fresh trusted checkout for commit/publication.
Use explicit environment/configuration, disable hooks and external execution
features, and broker narrowly scoped credentials only for the final push/API
operation. Do not rely on prompt instructions to protect Git metadata.

**Acceptance evidence:** harmless hook, filter, helper, config-include, and
symlink canaries cannot execute in trusted operations; normal diffs publish to
only the owned branch. Follow-up **R2**. OWASP **A03:2021 Injection** and
**A08:2021 Software and Data Integrity Failures**;
[command injection guidance][command-injection].

## S3 — Medium: optimistic checks do not make remote effects atomic

**Evidence:** [GitHub run store](../../../factory/run-state-store.ts) reads a
version, checks it, then updates a comment with no atomic conditional write.
[Publisher](../../../factory/publisher.ts) finds then creates a PR. Actions
serializes its own per-issue jobs, but other writers are not part of that lock.
Local JSON persistence and local workspace lifecycle have separate lifetimes.

**Impact:** concurrent or crashed workers can lose an event, repeat work, or fail
to reconcile a successful remote effect after a timeout. This is a design risk,
not evidence that production has created duplicate PRs.

**Fix:** single authoritative transactional store for a dedicated worker, unique
run/effect keys, leased ownership with fencing, and intent/result records around
remote mutation. Reconcile uncertain push/PR outcomes before retry. Mirror state
to comments for display; do not use a comment update as a distributed lock.
Follow-up **R3**. OWASP **A04:2021 Insecure Design**;
[transaction authorization guidance][transaction-authorization].

## S4 — Medium: simple approval retains a trusted-operator risk

**Evidence:** [autonomy gate](../../../factory/autonomy.ts) compares a boundary
string; [entrypoint](../../../scripts/run-factory.ts) reads it from the trusted
environment. [Implementation](../../../factory/implementation.ts) pushes after
checks, before independent review. [Pipeline tests](../../../tests/factory-pipeline.test.ts)
allow a red-review draft under permissive policy.

**Impact:** turning the current interface into a shared service without a new
authorization contract would make stale approvals and overly broad publication
possible. The environment variable is not itself an unauthenticated network API.

**Accepted disposition:** [ADR 0010](../../adr/0010-vps-pilot-and-provider-policy.md)
retains the existing simple operator confirmation. Mandatory review-before-push
and exact-commit human receipts are not pilot requirements. Document the active
autonomy policy and operator boundary; retain exact-SHA checks, branch ownership,
independent review, draft-only publication and human GitHub review. A branch may
already be remote when review fails; a red-review draft remains policy-controlled.
This residual risk is accepted for the single-owner VPS, not a shared service.
Follow-up **R4** documents/tests these semantics. OWASP **A01:2021 Broken Access Control**;
[transaction authorization guidance][transaction-authorization].

## S5 — Medium: model-selected verification is not a mandatory check policy

**Evidence:** [verification](../../../factory/verification.ts) validates command
count/length and records exits. [Implementation](../../../factory/implementation.ts)
uses plan commands; learned commands cannot add commands outside that plan. This
limits memory authority, but does not ensure a repository's required checks run.

**Impact:** a weak or injected plan can select a passing command that does not
validate the change. A malicious candidate can also weaken its own test script.

**Fix:** resolve mandatory checks from a trusted base revision and owner policy,
record command/image/base/candidate digests, and treat changed check definitions
as review-sensitive. Require CI results for the exact published head where
configured. Keep independent review; tests are evidence, not a guarantee.
Follow-up **R5**. OWASP **A08:2021 Software and Data Integrity Failures**;
[CI/CD security guidance][cicd-security].

## Controls to retain and additional risks to test

- Keep plan-only default, restrict-only capability overlays, bot-author filtering,
  path confinement, output limits, no-network implementer tools, independent
  review evidence, and draft-only publication. Do not weaken these to fit a CLI.
- Treat issue text, repository instructions, retrieval and memory as untrusted
  data. A memory entry cannot change a tool, policy, command allowlist or approval.
  Preserve the existing [adversarial catalog](../../../eval/security/invariants.ts).
- A Git worktree separates edits, not users, processes, filesystems or credentials.
  A local runtime permission prompt is not an OS isolation boundary.
- Executable packages, MCP servers and hot-reloaded extensions are code. Pin
  digest/version, require owner approval, use stage-specific capabilities, and
  disable network by default. Do not import Ultimate's self-modification into the
  trusted orchestrator. Kody's discovery pattern is useful without its authority.
- Verify provenance before executing dependencies. GPT Pilot's current security
  notice is a concrete reason not to install research candidates on a trusted
  worker. Image pinning, lockfiles and dependency scans are required pilot inputs.
- Redact known secrets and omit raw transcripts from published evidence. Retain
  only bounded diagnostics and artifact digests; add canary-redaction tests.
  No retention period or external model data policy is assumed by this report.
- Confirm branch protection and scoped GitHub credentials in the pilot. Flowly's
  lack of a merge method does not constrain a stolen token outside Flowly.
- BYOK and subscription OAuth tokens stay outside candidate processes. The
  [provider comparison](./deployment-and-providers.md) identifies plaintext remote
  token storage, renewal and entitlement limits. A successful login is not proof
  of permitted unattended use. No automatic merge or deployment is authorized.

[docker-security]: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
[command-injection]: https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
[transaction-authorization]: https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
[cicd-security]: https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html
