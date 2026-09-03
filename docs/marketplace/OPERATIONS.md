---
sidebar_position: 4
---

# Marketplace Operations

## Activation status

The implementation contains the application workflow, Web review, GitLab CI
definitions, and restricted release endpoint, with local automated verification.
Production rollout is not approved or deployed yet. There is no application-level
publication switch, so complete every external P0 in
[Production activation](#production-activation) in the real environment before
deploying the Request API and its clients.

The GitHub-based Wework official `public` catalog remains a P1 product decision.
Do not treat enterprise activation, migration cleanup, or upstream operations as
approval of that still-undecided path.

## Prerequisites

- Apply the latest backend Alembic migrations.
- Configure MySQL and Redis.
- Configure the S3-compatible attachment storage settings used by plugin package
  storage.
- Run the backend, Celery workers, and exactly one Celery Beat scheduler.
- Ensure registered desktop devices can reach the backend and object storage.
- Configure the approved internal GitLab project, protected `master` branch,
  native Windows/macOS runners, MR rules, webhook secret, and reconciliation job
  before deploying enterprise publication requests.
- Enable **Settings → Merge requests → Merge checks → Pipelines must succeed**.
  The Backend verifies this setting before materialization and registers GitLab
  native auto-merge for each controlled MR using its exact source commit SHA.
- Create a dedicated `plugin_release` machine key and store its raw value only as a
  protected, masked variable available to the protected `master` release job.

Relevant storage settings include:

```text
ATTACHMENT_S3_ENDPOINT
ATTACHMENT_S3_ACCESS_KEY
ATTACHMENT_S3_SECRET_KEY
ATTACHMENT_S3_BUCKET
ATTACHMENT_S3_REGION
ATTACHMENT_S3_USE_SSL
PLUGIN_STORAGE_BUCKET
PLUGIN_PACKAGE_URL_EXPIRES_SECONDS
PLUGIN_SUBMISSION_SCAN_TIMEOUT_SECONDS
WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS
WEWORK_PLUGIN_PUBLICATION_GITLAB_API_URL
WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID
WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_URL
WEWORK_PLUGIN_PUBLICATION_GITLAB_TOKEN
WEWORK_PLUGIN_PUBLICATION_GITLAB_MATERIALIZER_USER_ID
WEWORK_PLUGIN_PUBLICATION_GITLAB_TARGET_BRANCH
WEWORK_PLUGIN_PUBLICATION_GITLAB_MAX_FILES
WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET
WEWORK_PLUGIN_RELEASE_KEY_MAX_DAYS
```

Keep credentials in environment configuration. Never place them in plugin
manifests, documentation examples, logs, or source control.

`WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS` limits all non-terminal publication
Requests owned by one user; it is separate from the invariant that one personal
source may have only one active Request. `WEWORK_PLUGIN_PUBLICATION_GITLAB_MAX_FILES`
bounds controlled MR materialization. `WEWORK_PLUGIN_RELEASE_KEY_MAX_DAYS` bounds the
expiry accepted when creating a Release key.

`WEWORK_PLUGIN_PUBLICATION_GITLAB_TOKEN` must belong to a dedicated materializer
bot/service account. Set `WEWORK_PLUGIN_PUBLICATION_GITLAB_MATERIALIZER_USER_ID` to the
positive numeric `id` returned by GitLab `GET /user` when authenticated with
that token. The backend refuses materialization if the identities differ and
refuses to reuse an existing branch or MR that lacks the request/revision HMAC
binding. Do not use a developer account or a general operations token. Token
rotation can intentionally invalidate an unfinished bound branch; close or
remove that failed partial materialization before retrying with the new token.

There is no publication enable/disable setting and no people allowlist. Once the
Backend is deployed, every authenticated personal-plugin owner can create an
enterprise Request. `WEWORK_PLUGIN_PUBLICATION_MAX_ACTIVE_REQUESTS` must be at least
`1`; it is an abuse/capacity bound and cannot be used as an implicit shutdown.
Legacy `/plugins/submissions` accepts `restricted_share + personal` only.

## GitLab webhook configuration

Set `WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET` in the Backend runtime
environment to a dedicated random secret. In the controlled GitLab project,
open **Settings → Webhooks** and configure:

- URL: `https://<backend-host>/api/internal/plugins/gitlab/events`
- Secret token: the exact same value as
  `WEWORK_PLUGIN_PUBLICATION_GITLAB_WEBHOOK_SECRET`
- Triggers: **Merge request events** and **Pipeline events**
- SSL verification: enabled

The webhook secret belongs in the Backend environment and the GitLab Webhook
configuration. It is not a CI/CD variable and is distinct from both the
materializer token and `WEWORK_PLUGIN_RELEASE_TOKEN`. Webhooks only synchronize
MR and Pipeline state; they never publish an artifact.

Auto-merge is not driven by the webhook. After creating or reusing a controlled
MR, the Backend calls GitLab's merge endpoint with
`merge_when_pipeline_succeeds=true`, the exact MR head `sha`, and source-branch
removal enabled. GitLab then waits for required approvals and the successful MR
Pipeline before merging into protected `master`. The Backend first waits for a
same-SHA MR Pipeline because GitLab can expose a newly created MR before creating
its Pipeline record. Only a transient `405` from this registration is retried,
using bounded backoff; other HTTP failures are returned immediately, and a
permanent `405` fails when the retry deadline is exhausted.

## Release credential operations

The dedicated `plugin_release` type extends the existing API-key lifecycle. It
must use the same one-time raw-key display, hashed storage, expiry,
disablement, prefix display, last-used timestamp, and audit behavior as other API
keys, with a separate dependency that accepts only this type.

- Create: `POST /api/admin/plugin-release-keys` with `name`, optional
  `description`, and `expiresAt`.
- List without raw values: `GET /api/admin/plugin-release-keys`.
- Disable or re-enable: `POST /api/admin/plugin-release-keys/{id}/toggle-status`.
- The raw `wg-...` key is returned only by the successful create response. Store
  it immediately in the protected GitLab variable; it cannot be retrieved later.
- Configure the one allowed GitLab project and target branch on the Backend. The
  release endpoint rejects calls when the project is not configured and verifies
  the submitted provenance against GitLab independently of the credential.

- Do not give the key a `wegent-username`; it cannot impersonate a user.
- Do not reuse a personal key, general service key, or
  `INTERNAL_SERVICE_TOKEN`.
- Protect and mask the GitLab variable. MR and unprotected branch jobs must not
  receive it.
- Rotate by creating a replacement, updating the protected variable, validating
  one release, and disabling the old key. Never log either raw value.
- The release endpoint must fix the target catalog/visibility and validate the
  allowed project, protected commit, artifact SHA, manifest, and version.
- Release calls require
  `Idempotency-Key: wework-plugin-v1:<64hex>`. The server recomputes the digest
  from the project ID, final commit SHA, and artifact SHA-256 and persistently
  binds it to the authenticated release-key record.

An older release credential was present in repository history. Revoke it in the
external issuer and rotate it before any production rehearsal. Do not inject the
replacement while the Release API is reachable only over plain HTTP; use HTTPS
or an explicitly approved equivalent encrypted transport first.

## Database verification

Inspect catalog identities and their current releases:

```sql
SELECT id, slug, source_type, source_provider, visibility,
       status, latest_release_id
FROM plugins
ORDER BY slug;

SELECT plugin_id, version, status, scan_status, sha256, storage_key
FROM plugin_releases
ORDER BY id DESC;
```

Once the publication-request migration is applied, also inspect the request,
immutable revision, check, append-only event, workflow-idempotency, and
release-idempotency tables introduced by that migration. Upgrade, downgrade, and
re-upgrade have local MySQL verification, but each deployment must still confirm
its own migration state before using these tables. Operationally verify:

- the current revision points to the expected source Release and SHA-256;
- `changes_requested` never rewrites an earlier revision;
- administrator acceptance records a MR but no enterprise Release;
- MR/pipeline/master commit facts correspond to the same accepted revision;
- `published` links to the enterprise Plugin/Release and exact artifact SHA.
- workflow idempotency rows bind principal, operation, resource, request
  fingerprint, and the cached response state without storing credentials;
- release idempotency rows bind trusted GitLab proof and the authenticated
  release-key database ID.

Inspect upstream health:

```sql
SELECT plugin_id, provider, marketplace_name, remote_plugin_id,
       sync_enabled, sync_policy, last_seen_version,
       last_checked_at, last_synced_at, last_error
FROM plugin_upstreams
ORDER BY plugin_id;
```

Inspect device convergence:

```sql
SELECT user_id, device_id, installed_kind_id, desired_release_id,
       actual_release_id, state, error_code, attempt_count, last_sync_at
FROM plugin_device_installations
ORDER BY updated_at DESC;
```

Use SQL for diagnosis only. Publish, review, install, and revoke through service
commands or APIs so storage and database transactions remain consistent.

## Workflow idempotency operations

The following mutations require an `Idempotency-Key` of `8–200` characters using
only `[A-Za-z0-9._:-]`:

- create Request;
- create Revision;
- complete Revision;
- withdraw;
- administrator return;
- administrator accept;
- administrator reconcile.

For the same principal and operation, exact replay of the same resource and
payload returns the original response. Reusing a key with another resource or
payload, or repeating it while the first request is still processing, returns
`409`. A failed logical operation may reuse its original key. Generate a new key
for a new logical operation, including every later explicit reconciliation.

## Common failures

### Plugin is missing from the catalog

Confirm that the plugin is `published`, its latest release is `ready`, and the
release scan status is `passed`. Then verify that the current user is allowed by
the plugin visibility and grants.

### Installation remains pending

Check that the target device is registered and online, then inspect
`plugin_device_installations`. Compare `desired_release_id` with
`actual_release_id` and review the device error fields and executor logs.

### Package download fails

Verify the object exists at `storage_key`, the backend can create a presigned
URL, the device can reach the object-store endpoint, and the stored bytes match
the release SHA-256.

### Upstream synchronization fails

Inspect `last_error`, validate DNS and HTTPS reachability from the backend, and
confirm the response is within the package size limit. Redirect targets must
also use HTTPS and resolve to public addresses. A changed package under an
existing version is rejected; the upstream must publish a new version.

### Legacy submission cannot be approved

The submission must be `pending`, and its release must have passed scanning.
Review operations are terminal: an approved or rejected submission cannot be
reviewed again.

This is legacy behavior. Do not use the old approval operation for a new
enterprise request because it publishes immediately.

### Enterprise request is blocked in administrator review

Inspect stable automatic-check findings and the author's declarations. An
administrator may accept only the current immutable revision, with zero blocking
findings and every required warning explicitly acknowledged. Otherwise return it
with actionable `requiredChanges`; a corrected deterministic content failure
creates a new revision in the same Request. An upload, transport, or check-service
infrastructure failure retries the original revision with the same logical
attempt instead.

### GitLab code review requests changes

A developer fixes the existing controlled branch and MR, creates a new
commit, and reruns its Pipeline. Do not ask a non-technical author to create a new
publication revision for `code_changes_requested`. If the accepted immutable
snapshot itself must change, end the current code-review flow and submit through a
new Request/Revision flow.

### MR was not created

Check the publication event log and materialization idempotency key before
retrying. A retry must reuse the existing branch/MR when the accepted revision is
unchanged. Verify GitLab project permissions without exposing access tokens in
logs. MR creation is not publication and must not change catalog visibility.

### Pipeline passed but the plugin was not published

Confirm that the exact commit was merged into protected `master` and that the
protected release job ran. MR pipeline success alone is insufficient. Verify the
release job could read the `plugin_release` variable, the key is active and not
expired, and the artifact SHA matches both the request revision and master build.

GitLab webhooks only update or reconcile request status. Replaying a webhook must
not call the release service or create a duplicate Release. If a webhook was
missed, run/status-check the reconciler rather than manually publishing the MR
artifact.

### Protected release failed

Record `publish_failed` with a redacted error and retain the previous enterprise
`latest_release_id`. Retry only the same immutable master artifact, or fix the
source and publish a higher semantic version. Never overwrite an existing
Release or repair it with direct SQL/S3 edits.

### Access revocation does not finish on a device

Cloud access and desired installation state are revoked immediately. Device
cleanup may remain `uninstalling` while a device is offline. Reconnect the device
and inspect its next capability synchronization result.

## Scheduled synchronization

Celery Beat schedules enabled upstream synchronization. Run only one Beat
instance for a deployment. The task uses a distributed lock, but a single
scheduler remains the supported operational topology.

Monitor task failures and upstream `last_error` values. Do not add automatic
fallback sources when an upstream fails; fix or disable the configured source.

Publication-request reconciliation is separate from upstream synchronization.
It compares stored request/MR/pipeline state with GitLab and repairs missed or
out-of-order status events. It does not build or publish packages.

## Deployment rollout

The feature implementation already adds the namespace/origin migration,
publication Request/Revision/Check/Event records, the two-intent Wework client,
Web review, MR materialization, status-only Webhooks, and the dedicated release
endpoint. Deploy it in this order:

1. Complete the production-activation gates below: protected GitLab resources,
   native Runners, HTTPS, materializer identity, Webhook, reconciliation, and the
   dedicated Release key. Prove MR jobs cannot read the Release credential.
2. Back up and apply the new Alembic revision, then verify namespace backfill,
   origin links, indexes, and historical Release/install references.
3. Coordinate the Backend, two-intent Wework client, and Web review rollout. The
   Request API is available to authenticated personal-plugin owners immediately
   after Backend deployment; there is no later switch-on step.
4. Keep personal `restricted_share` upload and ACL APIs operational; verify that
   legacy submissions reject `workspace/public`.
5. Run the full real-environment rehearsal for submission, return, MR,
   native checks, merge, release, replay, failure, and rollback before accepting
   the rollout as production-ready.
6. Drain or migrate historical pending submissions, observe old-client traffic,
   and then remove the legacy direct-review endpoint/script and obsolete
   compatibility paths. Do not remove the restricted-share upload path.

The companion `wework-plugins` repository implementation contains
`.gitlab-ci.yml`, package policy, risk checks, deterministic packaging, and
Windows/macOS job definitions, with local tests. That is not proof that protected
project settings or native Runners exist on the real GitLab project.

## Production activation

All of the following are external P0 gates:

- revoke and rotate the old credential found in repository history;
- expose the Release API through HTTPS or an approved encrypted equivalent;
- configure and verify protected `master`, a protected release environment,
  Code Owner approvals, and protected/masked variables;
- attach project-locked native Windows and macOS Runners and prove that missing
  or skipped jobs block merge;
- create a fresh `plugin_release` key and prove it is available only to the
  protected-master release job, never to MR pipelines;
- rehearse personal sharing, initial and replacement revisions, administrator
  return/accept, MR creation, both native jobs, merge, release, duplicate
  Webhook/API delivery, exact idempotency replay and conflict, release failure,
  withdrawal before merge, and rollback;
- verify the client and API reject blank/overlong release and test notes, the root
  department appears only with `include_organization=true`, and requester/admin
  event responses expose `requiredChanges` without arbitrary payload data;
- prove that every failure leaves the personal source and the last good
  enterprise release unchanged.

Only after this checklist passes may operators describe the flow as production
enabled.

## Security practices

- Restrict administrator endpoints to trusted operators.
- Allow only reviewed HTTPS upstreams.
- Rotate object-storage and OAuth credentials regularly.
- Rotate release keys and make them unavailable to MR pipelines.
- Keep presigned URL lifetimes short.
- Audit changes to visibility, grants, upstream configuration, and review state.
- Audit immutable revision SHA, risk acknowledgements, GitLab commit/artifact,
  webhook delivery, and final Release linkage.
- Treat plugin code as executable software and review it accordingly.
