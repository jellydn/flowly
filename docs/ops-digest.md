# Ops Slack Digest pilot

Implements [#166](https://github.com/jellydn/flowly/issues/166). This is a bounded,
operator-run TypeScript job, not a deployed Slack bot or an exact copy of the private
Grok template. It uses Node's built-in SQLite and adds no dependencies. Node 22.19+
is required; Node can print an experimental SQLite warning.

## Trust boundaries

`collect → frozen SQLite snapshot + deterministic draft → human approval → separate publisher`

Flue agents and their tools are unchanged. This pilot uses a deterministic, cited
event digest, not an LLM summary. There is no provider data transfer, model key,
Pi integration, or second model framework. Slack instructions cannot invoke tools,
approve a run, select a destination, or cause a write. All excerpts are untrusted;
the digest does not infer severity, ownership, resolution, or remediation. A future
Flue summarizer needs separate data-sharing approval and output validation.

The collector gets only `OPS_SLACK_READ_TOKEN`. The separately invoked publisher
gets only `OPS_SLACK_PUBLISH_TOKEN` and `OPS_SLACK_DESTINATION`. Do not put both
tokens in the same service environment. Use separate Slack apps: reader membership
only in source channels, publisher membership only in the destination. Grant history
access for the approved public/private channels, and `chat:write` only to the
publisher. No DMs, channel discovery, broad search, `chat:write.public`, admin scopes,
or user impersonation. Verify installed-token access to replies in a test workspace;
unsupported access becomes a coverage gap, never broader credential access.

Human approval is a **local trusted-operator boundary**, not remote authentication.
The CLI uses the operating-system username, not a supplied actor argument. Anyone
who can write the DB or execute code as that operator can bypass this boundary.
Protect the host, configuration, DB, WAL and backups. The CLI sets umask 077 for new
files; it does not repair existing permissions. Use a private directory, separate
service environments and authenticated SSH for review. Do not expose these CLIs as
an unauthenticated service. No deployment, timer, credentials, or Slack posts are
included or authorized by this pilot.

## Explicit configuration

Create `.ops-digest/config.json` in a private directory. The following IDs are
placeholders. Supply real values only after separate authorization for a test
workspace. The timezone and approver must be chosen, not inferred.

```json
{
  "workspace": "TEXAMPLE",
  "channels": ["COPS", "CREQUESTS", "CERRORS"],
  "destination": "CDIGEST",
  "timezone": "America/New_York",
  "cutoff": "08:00",
  "approvers": ["your-os-user"],
  "audienceConfirmed": true
}
```

Set `audienceConfirmed` to true **only** after confirming everyone in the destination
may see every source channel. This is an operator attestation; the job cannot prove
audience equivalence. Private sources must not be copied to a broader audience.

One run per workspace and civil date is allowed. The frozen config, evidence,
coverage notes and final text are hashed together. Recollection returns the original
run, even if config or Slack content changed. Approval binds that hash, actor and
time. There is no edit-after-approval command. Do not delete sent/ambiguous runs to
force another send.

## Run and review

These commands are examples for a separately approved environment, not activation
instructions for production. `collect` calls Slack; `show`, `approve`, `track` and
`resolve` do not. `show` contains sensitive evidence: review privately, not in CI logs.

```bash
npm run ops-digest -- collect .ops-digest/config.json .ops-digest/state.db 2026-03-09
npm run ops-digest -- show .ops-digest/config.json .ops-digest/state.db 2026-03-09
# Inspect exact text, destination, gaps and source evidence, then copy the displayed hash.
npm run ops-digest -- approve .ops-digest/config.json .ops-digest/state.db 2026-03-09 REVIEWED_HASH
```

In the separate publisher environment, `OPS_SLACK_DESTINATION` must match the frozen
destination. Publication uses plain text with mention parsing and unfurls disabled.
Excerpt URLs, mention delimiters and control characters are removed. These measures
do not detect every secret: the human must check excerpts for sensitive data.

```bash
npm run ops-digest:publish -- publish .ops-digest/state.db TEXAMPLE:2026-03-09
# Only for a run left in sending after a crash or uncertain response:
npm run ops-digest:publish -- reconcile .ops-digest/state.db TEXAMPLE:2026-03-09
```

The publisher commits `sending` with FULL SQLite synchronization **before** calling
Slack. A crash, timeout, rate limit or invalid response leaves it there. It never
blindly resends. Reconciliation scans destination history from send intent minus
60 seconds, requires complete bounded coverage, exactly one message with the exact
approved text/run marker, and the same authenticated publisher identity. Missing,
modified, duplicate or inaccessible messages require manual investigation. There is
no reset/resend command. Even a crash before the HTTP send can require investigation.
This favors missed delivery over duplicate delivery; it does not promise exactly-once
Slack delivery. Normal success and reconciled success both persist a receipt.

## Windows, old threads and limits

- Window: previous **scheduled weekday** cutoff through requested weekday cutoff,
  start inclusive/end exclusive. Monday includes Friday daytime and the weekend.
  This is not strictly evening-to-morning. Both cutoffs use the configured IANA zone;
  DST weekends can be 71 or 73 hours. Missing/ambiguous local cutoffs fail closed.
- No holiday calendar or automatic catch-up. Invoke after cutoff with an explicit
  date; future cutoffs and weekend dates are rejected. For missed weekdays, run each
  missing date explicitly. A later run does not silently include missed dates.
- Newly observed roots remain tracked until an operator resolves them. New replies
  on tracked old roots are collected even if no new parent appears in history.
  Seed known unresolved roots with `track CONFIG DB CHANNEL THREAD_TS`; remove a
  resolved root with `resolve CONFIG DB CHANNEL THREAD_TS`. Resolution is not inferred
  from message content. Roots never observed/seeded, deleted messages and edits to
  old messages are outside polling coverage; every draft discloses this limitation.
- At most 10 source channels, 50 tracked roots, 3 pages × 100 rows per history/replies
  request, 100 retained events, 1,000 characters of evidence per event, 140-character
  excerpts, and 35,000 characters of final text. Oversized drafts fail before approval.
  Pagination, access and limit failures appear in coverage notes. Partial digests can
  be approved, but their warnings are part of the immutable published text.
- Each HTTP attempt has a 10-second timeout and a 2 MB decoded response cap. Reads
  retry HTTP 429 at most twice, respecting Retry-After up to 60 seconds. Transport,
  5xx and API errors are not retried. The client has a 10-minute total time budget.
  At most 543 HTTP attempts are possible for collection (auth + 60 paginated streams).
  Publish never retries its write, even on 429.
- Frozen inputs contain truncated raw Slack evidence. There is no automatic retention
  or redaction policy in this pilot. Before activation, choose retention, encrypted
  backup/storage and deletion procedures. Do not expire delivery tombstones or restore
  a pre-send backup without reconciling Slack: either can permit duplicate delivery.
  Run state volume grows by one record per date; disk retention is an operator task.

## Deterministic verification

```bash
node --import tsx --test tests/ops-digest.test.ts
npm run check
```

Tests use fake Slack transports and disposable SQLite databases. They cover
pagination/retry limits, old-root replies, Monday/DST windows, missing access,
prompt injection, immutable approvals, concurrent claims and crash-after-send
reconciliation. They do not validate real Slack app permissions, rendered Slack
messages, production credentials or deployment. Live validation requires separate
authorization and a test workspace.
