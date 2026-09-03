---
sidebar_position: 2
---

# Marketplace Architecture

## Responsibilities

The marketplace is split into a cloud control plane and a local execution
plane.

```text
Plugin source
  -> choose personal sharing or enterprise publication
  -> personal: upload/validate/scan package -> selected-recipient ACL
  -> enterprise: author declarations -> final submit and immutable revision
       -> automated checks -> administrator decision -> GitLab MR
       -> risk, Windows, and macOS pipeline gates
       -> protected master publication -> enterprise catalog release
  -> account installation intent
  -> device capability synchronization
  -> local runtime materialization
```

The backend is authoritative for catalog and access state. The local executor is
authoritative for whether a package was successfully materialized on a specific
device. Wework combines both views without treating local state as cloud state.

The architecture below is implemented and covered by local tests. It is not
evidence that a production deployment has enabled the flow: the real GitLab
protection rules, native Runners, HTTPS transport, rotated credential, and
protected release environment remain deployment gates.

## Core records

The publication model separates package upload, publication governance, and catalog
publication. This separation is required because a personal plugin remains owned,
editable, and shareable by its creator while an immutable revision is under
review and after an enterprise-owned copy has been published.

| Record                         | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `Plugin`                       | Catalog identity within a publisher/catalog namespace.                        |
| `PluginRelease`                | Immutable package metadata, checksum, scan report, version, provenance.       |
| `PluginSubmission`             | Legacy transport for personal restricted-share upload and historical cleanup. |
| `PluginPublicationRequest`     | Enterprise-publication workflow, ownership, and current product stage.        |
| `PluginPublicationRevision`    | Immutable source Release, SHA, declarations, and submission copy.             |
| `PluginPublicationCheck`       | Stable check code, severity, evidence, result, and acknowledgement.           |
| `PluginPublicationEvent`       | Append-only status and actor audit timeline.                                  |
| `PluginPublicationIdempotency` | Durable principal/operation/resource/payload binding for workflow mutations.  |
| `PluginReleaseIdempotency`     | Durable trusted-proof and release-key binding for protected publication.      |
| `PluginUpstream`               | Explicit configuration for a mirrored external source.                        |
| `InstalledPlugin` (`Kind`)     | Account-level desired installation state.                                     |
| `PluginDeviceInstallation`     | Per-device desired and actual release state.                                  |
| `ResourceMember`               | User or department access grants for personal plugins.                        |

Published releases cannot change their package, checksum, manifest, interface,
or provenance. A plugin release version is unique within its plugin.

Publication revisions have the same immutability rule. A returned request creates
revision 2, 3, and so on; it never rewrites revision 1. Each accepted revision
records its GitLab project, branch, MR, pipeline, protected-master commit, and
artifact checksum. Events are append-only so both the desktop progress view and
the Web administrator timeline use the same audit facts.

The publication implementation adds a new Alembic revision instead of rewriting
the historical Marketplace V2 migration. It introduces `catalog_namespace`,
makes identity unique by `(catalog_namespace, slug)`, adds `origin_plugin_id`, and
creates Request/Revision/Check/Event plus workflow- and release-idempotency
records. Its upgrade, downgrade, re-upgrade, and namespace-collision blocking are
verified locally. A deployment remains on the legacy schema until that revision
is actually applied there.

## Sources and visibility

`source_type` and `source_provider` describe provenance. `visibility` controls
catalog access.

| Visibility  | Intended audience                                                        |
| ----------- | ------------------------------------------------------------------------ |
| `personal`  | Owner and explicitly granted members or departments.                     |
| `workspace` | Everyone in the enterprise; created only by the governed release path.   |
| `public`    | Official public catalog; reserved for system/official publication paths. |

Access checks must include plugin identity, user identity, and approved grants.
Client labels are presentation only and must never drive authorization.

Personal ACL targets are either a user or a namespace. A namespace is a
department; selecting the organization root grants the whole department tree,
so there is no separate `organization` target type. ACL replacement and package
publication remain separate transactions: a directed share can change without
altering an enterprise publication request.

## Release lifecycle

### Personal share

1. The client initializes a submission with filename, size, version, and SHA-256.
2. The backend returns a short-lived object-storage upload URL.
3. The client uploads the ZIP and completes the submission.
4. The backend verifies the object, scans the archive, and parses the manifest.
5. A selected-member/department share atomically updates personal ACL after a
   successful scan; it does not enter administrator or GitLab review.

### Enterprise publication request

The Wework application drawer has three steps:

1. **Version** shows the current packageable personal version and collects release
   notes. It does not upload source, run checks, or freeze a server snapshot.
2. **Permissions and risk** collects author declarations for external domains,
   commands, local-file access, credentials, application authorization, and test
   evidence. It does not prefill package-derived findings before submission.
3. **Confirm** reviews the declarations. Final submission uploads the package,
   creates the immutable revision, and records server-computed package and source
   tree SHA-256 values.

Submitting does not change the source plugin's visibility. The creator may keep
using, editing, or sharing the personal plugin; subsequent edits do not mutate
the submitted revision. Deleting it before merge first withdraws the request and
closes or cancels any MR, and deletion is blocked if that cleanup fails.
After merge, deleting the personal source cannot remove the enterprise edition.

The canonical five product stages are:

```text
Submit request -> Automated checks -> Administrator review -> Code review -> Release
```

Automated checks run after final submission and before administrator review,
producing stable `pass`, `confirm`, or `block` findings. An administrator may
return the current revision with required changes, or accept it only when blockers
are absent and required warnings are acknowledged. Acceptance creates a GitLab
MR; it does not create a catalog release. An administrator return or
deterministic content-check failure is corrected as a new immutable revision in
the same Request. Upload, transport, and infrastructure failures retry the same
revision idempotently. A personal source has only one active Request; after a
Published Request reaches its terminal state, a higher version creates a new
Request starting at revision 1. Withdrawal is supported before merge and may
require asynchronous branch/MR cleanup.

Non-technical authors enter through Wework. Developers may author directly in the
internal plugin repository. Both paths converge before code review: the accepted
snapshot is materialized as repository source, then the same MR policies,
pipeline checks, protected branch, and release service apply. After
`code_changes_requested`, a developer fixes and reruns the same controlled MR;
a non-technical author does not create a new publication revision for that
GitLab review state.

### Protected publication

The sole automatic publication trigger is the protected `master` pipeline. MR
pipelines perform risk and real Windows/macOS compatibility checks but cannot
read the release credential. After merge, the protected pipeline packages the
exact master commit and calls the backend release API with a dedicated
`plugin_release` machine key. GitLab webhooks only synchronize and reconcile MR,
pipeline, and merge status; they never independently publish a package.

For controlled Wework submissions, MR creation and auto-merge registration are
one materialization operation. The Backend supplies the exact MR head SHA to
GitLab's merge endpoint, and rejects the operation unless the project requires a
successful Pipeline before merge. GitLab, rather than the webhook handler,
performs the merge after all configured checks and approvals pass.

Administrators create that key with `POST /api/admin/plugin-release-keys`, list
keys with `GET /api/admin/plugin-release-keys`, and disable or re-enable one with
`POST /api/admin/plugin-release-keys/{id}/toggle-status`. The raw value appears
once. Rotation creates and verifies a replacement before disabling the old key.
Each protected Release request also carries
`Idempotency-Key: wework-plugin-v1:<64hex>`; the server recomputes the digest from
the GitLab project ID, final commit SHA, and artifact SHA-256.

The release API revalidates the artifact even when CI passed, stores it with an
immutable key, and writes the enterprise catalog transaction. Retrying the same
catalog namespace, slug, version, and checksum is idempotent. Reusing a version
with different content is rejected. A failed new release leaves the previously
published enterprise release unchanged.

The `publish_official_plugin.py` command is a break-glass/operator entry point,
not the normal enterprise path. `OfficialPluginPublisher` performs deterministic
local-directory packaging, while the HTTP endpoint validates the CI artifact;
both reuse the package parser/scanner primitives and the marketplace publication
transaction instead of invoking one another or maintaining duplicate persistence
logic.

### Upstream mirror

Only administrator-configured HTTPS sources are synchronized. Each download is
size-bounded, redirect-bounded, scanned, adapted when required, and compared
against the existing version. The default `auto_after_scan` policy publishes a
newer scanned release. `review_required` stages it for review.

## Installation lifecycle

An installation creates or updates an `InstalledPlugin` Kind for the account.
The backend then synchronizes desired capabilities to registered devices. Each
device reports its actual release and state independently.

The package download is the only network step in device materialization and
uses the Wegent Backend-provided object path. Once downloaded, the Executor
updates its managed package store, Claude/Codex caches, registries, and config
locally without Codex app-server, GitHub, or OpenAI calls. These local changes
commit atomically and roll back together on failure. Connector authorization is
a separate post-materialization flow and keeps its existing policy checks.

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

A personal source and an enterprise publication are intentionally different
catalog identities even if their manifest name and version are initially equal.
Publishing v1.2.0 to the enterprise does not prevent the personal source from
advancing to v1.3.0, and a failed enterprise update must not affect either the
personal source or the last good enterprise release.

## Authentication and trust boundaries

The release API uses a dedicated `plugin_release` machine-key type in the
existing API-key lifecycle. It is not a new authentication system: the raw
`wg-...` value is returned once, only its hash is stored, and it
supports expiry, disablement, rotation, prefix display, and last-used audit. It
must not impersonate a user and must be rejected by ordinary API-key endpoints.

Store the value as a protected and masked GitLab variable available only to the
protected `master` release job. Do not reuse personal keys, generic service keys,
or the deployment-wide internal service token. The release endpoint fixes the
target to the enterprise catalog. The allowed GitLab project and target branch
are server-side configuration; the endpoint validates project, commit, artifact SHA,
manifest identity, and semantic version rather than trusting caller-supplied
visibility.

## API contracts

The following seven workflow mutations require a caller-generated
`Idempotency-Key` of `8–200` characters using only `[A-Za-z0-9._:-]`:

- `POST /api/plugins/publication-requests`;
- `POST /api/plugins/publication-requests/{requestId}/revisions`;
- `POST /api/plugins/publication-requests/{requestId}/revisions/{revision}/complete`;
- `POST /api/plugins/publication-requests/{requestId}/withdraw`;
- `POST /api/admin/plugins/publication-requests/{requestId}/return`;
- `POST /api/admin/plugins/publication-requests/{requestId}/accept`;
- `POST /api/admin/plugins/publication-requests/{requestId}/reconcile`.

The durable binding includes principal, operation, resource, and the canonical
payload fingerprint. The same key, resource, and payload returns the original
response; the same key with a different resource or payload returns `409`; a duplicate still
processing also returns `409`. A transport retry reuses its logical attempt, while
a new explicit operation uses a new key.

Request/Revision input trims and requires `releaseNotes` (`1–2000` characters)
and `testNotes` (`1–1000` characters). The member/department picker opts in to the
organization root with `GET /api/groups/search?include_organization=true`; the
parameter defaults to `false` and access control still applies. Public
`PluginPublicationEvent` responses expose only dedicated safe fields. In
particular, `requiredChanges: string[]` is visible to both the requester and
administrators, while arbitrary event payload storage is never serialized to a
client.

## Deferred public-catalog work

The GitHub-based Wework official public-plugin flow is P1 and remains undecided.
Keep existing official/upstream support during migration, but do not route an
ordinary enterprise request to `public` or delete upstream records until that P1
design is approved.
