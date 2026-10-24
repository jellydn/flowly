# 10. User-owned VPS pilot with simple approval and flexible provider access

Date: 2026-10-24

## Status

Accepted

## Context

[Research #176](https://github.com/jellydn/flowly/issues/176) proposed keeping
Flue while improving execution isolation and recovery. The initial proposal also
required review before push and human approval tied to an exact commit. The owner
rejected that extra approval machinery and selected their VPS for the pilot.

The owner's Amp projects `dunghd/ai-flow` and `dunghd/hermes-hub` map to public
repositories `jellydn/ai-flow` and `jellydn/hermes-hub`. Their inspected source and
the current OpenAI documentation provide [operational and provider evidence](../research/software-factories/deployment-and-providers.md),
not proof that Flowly is deployed or that a subscription integration is ready.

The [per-job environment comparison](../research/software-factories/job-environments.md)
adds current Amp, Cursor and Devin evidence. It separates a persistent worker from
its disposable job environments and proposes a rootless-container pilot with
explicit shared-kernel limits. This supports the existing VPS decision; it does
not select a hosted vendor, certify isolation, or authorize implementation/deployment.

## Decision

1. **Run the pilot on the user's VPS.** Retain Flue and Flowly's control plane.
   Use one supervised worker, persistent state outside disposable containers,
   bounded execution and a documented backup/restore procedure. Reuse ai-flow's
   separation of release, worker and health checks where applicable; do not copy
   its PHP stack, automatic deployment trigger or shared credentials.
2. **Keep approval simple.** Retain existing operator-controlled autonomy and
   boundary confirmation. Do not require review before push, per-commit human
   approval, or an actor/digest/expiry receipt system for this single-owner pilot.
   Tests still precede push; independent review still informs draft publication.
   A draft with findings remains permitted under the configured policy. Human
   GitHub review remains the final acceptance step.
3. **Support BYOK and conditional ChatGPT subscription access.** BYOK remains a
   supported baseline. ChatGPT subscription access may be used only where the
   selected account, client, runtime, model, workload and terms permit it. Prefer
   documented provider authentication; do not copy a third-party OAuth client
   identity or treat subscription tokens as general-purpose API keys. Keep access
   mode explicit; no silent paid fallback or quota circumvention.
4. **Keep machine evidence exact, not human approval elaborate.** Checks and
   recovery records still identify the candidate SHA, policy and runtime. This
   prevents stale test reuse without asking the owner to approve every SHA.
5. **No auto-merge or deployment.** Flowly remains draft-only and never submits
   GitHub `APPROVE`. Deployment, shared migrations, resource changes and live
   provider spending require their own authorization. This ADR does not enable a
   worker, install an adapter or change the existing plan-only default.

## Consequences

### Positive

- Matches the owner's infrastructure and avoids a second hosted control plane.
- Keeps approval understandable and preserves existing factory behavior.
- Allows provider choice without coupling orchestration to one billing method.
- Separates tested-candidate integrity from optional human authorization features.

### Negative and residual risks

- A branch can be pushed before independent review. A failed review does not
  remove already published content. Minimize secrets in candidates and retain
  branch ownership checks; human review and branch protection remain necessary.
- A trusted VPS operator can reuse a broad boundary confirmation. This is not a
  multi-user authorization design. Revisit the decision before shared operation.
- VPS disk loss, backup failure and host compromise remain risks. Isolation,
  off-host encrypted backups and restore tests are follow-up work, not completed
  controls. Do not give candidate processes access to sibling apps or Docker.
- BYOK keys and subscription refresh tokens are secrets. File permissions do
  not protect them from a compromised host. Subscription quotas, renewal,
  revocation, workspace permissions and terms can change. No live subscription
  inference, refresh or restore was verified in this research.
- Model names and successful OAuth login do not prove access. Validate one real
  inference and recovery behavior in an authorized private trial before relying
  on a subscription route. Ineligible or uncertain routes remain disabled.

## Alternatives not selected

Mandatory review-before-push and exact-commit approval receipts were rejected
for the pilot, not declared valueless for a future shared service. Hosted control
planes, replacing Flue, and copying HermesHub's device-flow implementation are
not selected. BYOK-only is unnecessary, but unconditional subscription support
would overstate both technical compatibility and contractual permission.
