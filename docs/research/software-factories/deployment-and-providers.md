# Apply VPS operations patterns without inheriting their authority

[Research index](./README.md) · [Accepted ADR 0010](../../adr/0010-vps-pilot-and-provider-policy.md)

Checked 2026-10-24. Amp project metadata resolves `dunghd/ai-flow` to
`jellydn/ai-flow` and `dunghd/hermes-hub` to `jellydn/hermes-hub`. Both repositories
are public. Only source, history and existing Actions evidence were inspected;
no SSH session, secret retrieval, login, deployment or live inference was run.

## ai-flow: useful VPS operations evidence, not a Flowly deployment

Pinned [revision d90c93f](https://github.com/jellydn/ai-flow/commit/d90c93fc30fa922a1610c5400c11da5abc71c667)
is the 2026-10-24 release commit. The relevant recent changes are
[main-push deployment](https://github.com/jellydn/ai-flow/commit/db9c4080ac9f41f32051db6b2ad69ebc5117e882)
and [deployed revision verification](https://github.com/jellydn/ai-flow/commit/bb78c2bdac4b621a3be0b876adfac39fc09db276).

| Area        | Inspected evidence                                                                                                                                        | Apply to Flowly                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment  | [Dokku guide][ai-deploy] and [Dockerfile][ai-image] build the `backend` app and separate release from runtime                                             | Use the existing VPS operations model; a Flowly-specific image/service and resource budget are still needed                                                            |
| Supervision | [Procfile][ai-proc] separates release/web/worker; [Supervisor][ai-supervisor] restarts nginx/PHP-FPM; worker runs as `www-data`                           | One supervised Flowly worker with bounded shutdown and restart; do not adopt PHP or assume a supervisor makes work idempotent                                          |
| Persistence | Guide configures PostgreSQL, database queue/cache, explicit `DATABASE_URL` → `DB_URL`; release runs migration/seeding                                     | Keep Flowly's proposed single-worker SQLite journal and candidate artifacts on persistent storage outside the image; do not infer that container files survive updates |
| Secrets     | [Docker exclusions][ai-ignore] exclude `.env`; [credential cipher][ai-cipher] encrypts saved keys; [config][ai-key] separates encryption key from app key | Operator-managed BYOK through restricted service configuration; no keys in repo, image, logs, run store or candidate environment. No saved-key UI is required          |
| Backup      | Config warns to back up the credential encryption key; no scheduled backup/restore procedure was found in deployment docs, scripts or workflows           | Define encrypted off-host state/artifact backups, separate key recovery, retention and a disposable restore test. Persistence alone is not backup                      |
| Updates     | [Workflow][ai-workflow] serializes deployments, retries only Dokku lock failures, then compares `GIT_REV` and checks processes/API                        | After a separately authorized update, verify actual revision, worker state and a bounded smoke run; never remove a live deploy lock                                    |

[Existing successful deploy run](https://github.com/jellydn/ai-flow/actions/runs/40092641170)
has head `7c79afc` and success status. The originating deployment investigation
reported running web/worker and API health. This is ai-flow evidence; no Flowly
VPS state, disk mount, backup, restore or reboot survival was verified here.

Do **not** copy ai-flow's push-to-main deployment trigger or Renovate auto-merge
policy. Do not copy its `config:show` diagnostic into logs: it can expose secrets.
Its workflow collects an SSH host key with `ssh-keyscan`; Flowly operations should
verify the fingerprint through an independent trusted channel before pinning it.
Dokku supervision is not a sandbox for generated code. Candidate execution must
not mount the Docker socket, host home, service secrets or sibling application data.

## HermesHub: subscription and API access are distinct paths

Pinned [revision a2a310d](https://github.com/jellydn/hermes-hub/commit/a2a310dc5f3fb256ac3fc83fce6220959958a9eb)
is a 2026-10-19 dependency update. Recent default-branch commits are dependency
maintenance; the relevant [OAuth feature commit](https://github.com/jellydn/hermes-hub/commit/7ed94c644364dad0f4a18dd9be97b17abe18a0b9)
is from 2026-06-07. Root [license][hh-license] is MIT; it does not grant rights to
OpenAI services or establish the deployed Hermes image's dependency licenses.

| Concern            | BYOK in HermesHub                                                                                                      | ChatGPT subscription in HermesHub                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | Hub magic-link session; user-owned provider records                                                                    | Same Hub session plus server ownership checks, then OpenAI device-code exchange in [handler][hh-auth]                                                                                                    |
| Storage            | [AES-256-GCM][hh-crypto] encrypts stored API credentials with versioned keys; deployment material decrypts for runtime | Tokens pass through Hub memory, then SSH writes access/refresh tokens to `.hermes/auth.json` on the VPS with mode 0600; this is plaintext token storage, not Hub DB encryption                           |
| Routing            | [Backend resolver][hh-route] returns provider, base URL, model and encrypted key                                       | Separate subscription record takes precedence; `chatgpt` maps to `openai-codex`, not ordinary `openai` BYOK                                                                                              |
| Availability       | Required-key checks before deployment                                                                                  | [Status parser][hh-store] tests token presence only, not expiry, entitlement or inference; [metadata][hh-models] disables connection test and permits custom model names                                 |
| Operational limits | Key validity, provider quotas and charges apply                                                                        | [Session store][hh-session] holds one pending login per user in memory with 15-minute TTL; restart loses it. Refresh, revocation and quota handling depend on the deployed runtime and were not verified |

The [Compose builder][hh-compose] mounts persistent Hermes data and inserts BYOK
values into service environment. The same data volume holds subscription tokens;
the optional Web UI also mounts Hermes data. Containers restart `unless-stopped`,
but this source is not evidence of hostile-task isolation or encrypted host disk.
The gateway publishes port 8642 on all host interfaces; firewall and access-control
configuration were not inspected. The [SSH transport][hh-ssh] requires a stored
host-key pin after initial registration, a useful improvement over blind keyscan.

The token writer uses a base64 shell payload (encoding, not encryption), writes
the file before `chmod`, and does not show atomic replacement. The status endpoint
must not be treated as a production readiness check. Do not copy these mechanics
into Flowly without file-permission, concurrent-write and log/process-leak tests.

## Current OpenAI support is not permission to reuse any OAuth client

Official documentation checked live on 2026-10-24:

- [Sign in with ChatGPT for open-source apps][siwc] describes eligible Responses
  API requests under the user's plan, user/workspace-bound dynamic client
  registration, consent, PKCE, scopes and a stable host ID. Paid or remotely hosted
  offerings are directed to a separate interest process; the user's self-hosted
  VPS is not a general authorization to offer a hosted service to others.
- [Self-hosted VMs][siwc-vm] describes local login with the same client/user/workspace,
  secure credential transfer, preserving the VM host ID, and VM-owned refresh.
  Host-specific usage attribution and revocation for transferred sessions are
  explicitly not yet available.
- [Codex app-server integration][siwc-codex] describes a supported Responses
  provider with an authorized token. A model catalog is not an entitlement check;
  a completed inference verifies access for that request. Token renewal and
  restarting/resuming app-server are explicit integration duties.
- [Codex authentication][codex-auth] distinguishes API and ChatGPT data policies
  and recommends API keys for programmatic workflows. [Advanced managed-auth
  CI guidance][codex-ci] requires trusted private infrastructure, serialized token
  ownership and preserving refreshed credentials; it explicitly excludes public
  or open-source repositories and generic OAuth clients. Do not use that recipe
  to justify Flowly's public-repository CI or HermesHub's custom device flow.

HermesHub uses a fixed Codex client ID and `chatgpt.com/backend-api/codex`
([constants][hh-constants]). That is **not** the dynamically registered SIWC
Responses integration above. Technical code availability does not establish
contractual permission to reuse that client ID or backend in Flowly.

The current consumer terms page returned HTTP 403 and the services agreement
could not be fetched reliably in this research. Search excerpts are not a complete
terms review. The applicable account agreement, workspace permissions, supported
models, credits/limits, data retention and permission for the intended unattended
workload must be checked before activation. No legal clearance or production
suitability is claimed. The source licenses and service terms are separate.

## Accepted Flowly policy and operational follow-through

**BYOK remains supported. ChatGPT subscription access may be used where technically
and contractually valid.** Keep Flue as the initial runtime. Current Flowly
[provider registry](../../../eval/framework/providers.ts) is not a subscription
token adapter. Select a supported integration only after R10 compatibility checks;
do not treat a token as a drop-in `OPENAI_API_KEY`.

- Record provider, model, access mode and runtime version per run; never tokens.
  Require explicit operator selection and explicit opt-in for any paid fallback.
- Keep credential storage outside candidate trees. Serialize refresh ownership,
  redact failures, and test expiry/revocation/cancellation. Re-authenticate rather
  than bypassing account limits. Stop safely when route validity is uncertain.
- BYOK charges, subscription fees/credits and VPS compute are different costs.
  Record measured/estimated/unknown values; subscription access is not zero cost
  or unlimited inference. Set task limits before a live pilot.
- R3 owns persistent state and backup/restore documentation. R6 tests candidate
  recovery on a clean worker. R7 measures the authorized VPS pilot. R10 validates
  optional subscription access without blocking BYOK delivery.
- Keep approval simple under ADR 0010; no mandatory review-before-push or
  exact-commit human receipt. Exact-SHA check evidence remains necessary. No
  automatic merge or deployment is introduced by this operational design.

[ai-deploy]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/DOKKU_DEPLOY.md
[ai-image]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/Dockerfile
[ai-proc]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/Procfile
[ai-supervisor]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/docker/supervisor/supervisord.conf
[ai-ignore]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/.dockerignore
[ai-cipher]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/app/Security/CredentialCipher.php
[ai-key]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/backend/config/credentials.php
[ai-workflow]: https://github.com/jellydn/ai-flow/blob/d90c93fc30fa922a1610c5400c11da5abc71c667/.github/workflows/deploy-staging.yml
[hh-license]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/LICENSE
[hh-auth]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/providers/codex-auth/handler.ts
[hh-crypto]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/crypto.ts
[hh-route]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/providers/model-access/backend.ts
[hh-store]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/hermes/auth-json.ts
[hh-models]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/src/lib/user-subscriptions.ts
[hh-session]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/providers/codex-auth/session-store.ts
[hh-compose]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/compose.ts
[hh-ssh]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/ssh/connection.ts
[hh-constants]: https://github.com/jellydn/hermes-hub/blob/a2a310dc5f3fb256ac3fc83fce6220959958a9eb/server/providers/codex-auth/constants.ts
[siwc]: https://developers.openai.com/siwc/token-sharing-open-source
[siwc-vm]: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
[siwc-codex]: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
[codex-auth]: https://developers.openai.com/codex/auth
[codex-ci]: https://developers.openai.com/codex/auth/ci-cd-auth
