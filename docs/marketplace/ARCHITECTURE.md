---
sidebar_position: 2
---

# Marketplace Architecture

## Responsibilities

The marketplace is split into a cloud control plane and a local execution
plane.

```text
Plugin source
  -> package validation and security scan
  -> immutable object storage
  -> catalog release
  -> account installation intent
  -> device capability synchronization
  -> local Codex materialization
```

The backend is authoritative for catalog and access state. The local executor is
authoritative for whether a package was successfully materialized on a specific
device. Wework combines both views without treating local state as cloud state.

## Core records

| Record                     | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `Plugin`                   | Stable catalog identity, ownership, visibility, and latest release. |
| `PluginRelease`            | Immutable package metadata, checksum, scan report, and version.     |
| `PluginSubmission`         | Upload and review state for one release.                            |
| `PluginUpstream`           | Explicit configuration for a mirrored external source.              |
| `InstalledPlugin` (`Kind`) | Account-level desired installation state.                           |
| `PluginDeviceInstallation` | Per-device desired and actual release state.                        |
| `ResourceMember`           | User or department access grants for personal plugins.              |

Published releases cannot change their package, checksum, manifest, interface,
or provenance. A plugin release version is unique within its plugin.

## Sources and visibility

`source_type` and `source_provider` describe provenance. `visibility` controls
catalog access.

| Visibility  | Intended audience                                            |
| ----------- | ------------------------------------------------------------ |
| `personal`  | Owner and explicitly granted recipients.                     |
| `workspace` | Authenticated workspace users, subject to configured grants. |
| `public`    | All users who can access the deployment.                     |

Access checks must include plugin identity, user identity, and approved grants.
Client labels are presentation only and must never drive authorization.

## Release lifecycle

### User submission

1. The client initializes a submission with filename, size, version, and SHA-256.
2. The backend returns a short-lived object-storage upload URL.
3. The client uploads the ZIP and completes the submission.
4. The backend verifies the object, scans the archive, and parses the manifest.
5. Personal restricted shares may publish after a successful scan; broader
   visibility enters review.
6. Approval promotes the release and updates `latest_release_id` when the version
   is newer.

### First-party publication

The publication script builds a deterministic package, scans it, stores it with
an immutable key, and writes the catalog transaction. Retrying the same version
and checksum is idempotent. Reusing a version with different content is rejected.

### Upstream mirror

Only administrator-configured HTTPS sources are synchronized. Each download is
size-bounded, redirect-bounded, scanned, adapted when required, and compared
against the existing version. The default `auto_after_scan` policy publishes a
newer scanned release. `review_required` stages it for review.

## Installation lifecycle

An installation creates or updates an `InstalledPlugin` Kind for the account.
The backend then synchronizes desired capabilities to registered devices. Each
device reports its actual release and state independently.

Typical device states are `pending`, `downloading`, `installing`, `installed`,
`failed`, and `uninstalling`. A catalog item is considered installed on a device
only when that device confirms materialization.

Revoking access immediately deactivates the account installation intent. Device
cleanup can finish asynchronously and must not restore access.

## Identity

Cloud and local entries may use the same plugin name. Canonical identity must
include both plugin and marketplace, for example `github@wegent` and
`github@openai-bundled`. Deduplicate only a cloud installation and its local
materialization from the same marketplace.
