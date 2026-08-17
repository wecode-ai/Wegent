---
sidebar_position: 4
---

# Marketplace Operations

## Prerequisites

- Apply the latest backend Alembic migrations.
- Configure MySQL and Redis.
- Configure the S3-compatible attachment storage settings used by plugin package
  storage.
- Run the backend, Celery workers, and exactly one Celery Beat scheduler.
- Ensure registered desktop devices can reach the backend and object storage.

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
PLUGIN_PUBLISH_ENABLED
PLUGIN_PUBLISH_USER_IDS
```

Keep credentials in environment configuration. Never place them in plugin
manifests, documentation examples, logs, or source control.

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

### Submission cannot be approved

The submission must be `pending`, and its release must have passed scanning.
Review operations are terminal: an approved or rejected submission cannot be
reviewed again.

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

## Security practices

- Restrict administrator endpoints to trusted operators.
- Allow only reviewed HTTPS upstreams.
- Rotate object-storage and OAuth credentials regularly.
- Keep presigned URL lifetimes short.
- Audit changes to visibility, grants, upstream configuration, and review state.
- Treat plugin code as executable software and review it accordingly.
