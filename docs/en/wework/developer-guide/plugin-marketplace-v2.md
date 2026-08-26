---
sidebar_position: 20
---

# Wework Plugin Marketplace V2

For plugin development, open-source migration, and local integration, start with the [Plugin Marketplace Developer Guide](./wework-plugin-marketplace-dev.md). This document focuses on the control-plane architecture, data model, and operational constraints.

## Architecture

Marketplace V2 uses a Wework cloud control plane with a local Codex runtime. MySQL stores catalog metadata, immutable releases, selected upstreams, submissions, account install intent, and per-device materialization. Private S3-compatible storage holds packages. Codex App Server remains the source of truth for the current device.

The regular user sees only the Wework cloud catalog. Codex plugins are mirrored only after an administrator selects them. Local creations live in the `wework-personal` marketplace and are uploaded only after an explicit publish or owner-initiated restricted share. A Skill is represented as a Codex plugin containing exactly one Skill.

## Storage model

| Data                                      | Location                                                          |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Catalog, releases, upstreams, submissions | MySQL                                                             |
| ZIP packages and media                    | Private MinIO/S3 bucket                                           |
| Account desired state                     | Existing `kinds/InstalledPlugin`                                  |
| Device actual state                       | `plugin_device_installations`                                     |
| Local creations and registry              | Wework Codex Home / Codex App Server                              |
| Personal-copy provenance                  | Local `wework-personal/.wegent/plugin-copy-sources.json` registry |
| Tokens and MCP secrets                    | Local secure storage                                              |

New tables are `plugins`, `plugin_releases`, `plugin_upstreams`, `plugin_submissions`, and `plugin_device_installations`. `skill_binaries` is retained only for legacy Skills and migration history. Published Release package fields and manifests are immutable.

## Lifecycle

Installation upserts account intent, creates pending device rows, sends a short-lived signed package URL, verifies SHA256 and the Codex manifest, installs atomically, and records each device result. Marketplace installs update automatically by default, and users can opt out in plugin details. Local creations never call the cloud upload API. Publishing uses a presigned PUT, server-side scanning, and human review before a Release becomes searchable.

Automatic updates can advance only to immutable Releases whose status is `ready` and whose security scan is `passed`. Opening the plugin marketplace advances account desired versions in bounded batches and synchronizes the current device. A failed update does not replace `actual_release_id`, so the device keeps using its last confirmed release.

`kinds/InstalledPlugin.spec.updatePolicy` stores the user preference: `auto` is the default and `manual` disables automatic updates. `plugin_device_installations.attempt_count` tracks consecutive failures per device, plugin, and desired Release. Wework retries on the next marketplace open while the count is below three. After three failures it pauses automatic retries and requires a manual update, which resets the count and bypasses that circuit break. A new desired Release also resets the count. Full device synchronization must continue sending the preserved `actual_release_id` for a paused update so an unrelated plugin sync cannot bypass old-version protection.

Wework sends the local Executor's stable `device_id` to catalog and mutation APIs. A catalog item is installed only when that device reports `state=installed` with `actual_release_id` equal to the desired Release. A mutation returns `502` only when the requesting device fails; failures on other devices remain visible for reconnect reconciliation. WebSocket reconnect sync writes per-plugin results back and clears completed uninstall or stale failure rows.

Normal uninstall removes the confirmed device installation record and materialized runtime entry, but it does not directly clear Codex or Claude `plugins/cache`. Those caches are owned by the runtime for reuse and should only be purged by a separate garbage-collection flow that removes versions no longer referenced by any installation record.

Publishing uses a unified scope picker: people (`visibility=personal`, auto-approved after scan as `purpose=restricted_share`), organization (`workspace`), or everyone (`public`). Organization and public scopes still require human review (`purpose=marketplace_publish`). Personal publish may include `targets` and `allowCopy`; the server validates recipients at submission init and applies `resource_members` after a successful scan.

Creation does not create a cloud Plugin, Release, or package. Local Plugin Creator flows target the managed `wework-personal` marketplace. If a local creation lands in the Codex default `personal` marketplace (`~/plugins` + `~/.agents`), list refresh and publish packaging atomically migrate it into `wework-personal`, keep marketplace manifests in sync, and prefer that marketplace to avoid duplicates.

Cloud Plugin Creator flows instead keep source under `$WEGENT_TASK_WORKSPACE/plugins/<plugin-name>`. A persisted result marker in the existing Task conversation renders View, Share, and Publish actions; no draft table or plugin-center draft row is created. A later action restores the same Task workspace and asks that Task's Executor to revalidate and package the current source. Permanently deleting the Task also removes access to an unpublished source.

Publishing does not require a manually selected ZIP. Electron locates and packages local Marketplace source, while the current Task's Executor packages cloud workspace source. Both paths validate the Codex manifest, symlinks, path containment, and the 50 MB archive limit, then reuse the existing submission, object-storage, scanning, ACL, and review pipeline; the server scan also enforces the 200 MB expanded-size limit. A single-Skill plugin is submitted with `listing_type=skill` automatically.

## Restricted sharing and personal copies

Publishing to people, or later managing personal visibility, uploads the local package with `purpose=restricted_share` through the same object-storage and security-scanning pipeline. A successful scan creates a `visibility=personal` cloud Plugin and Release without public-market review. User and Namespace grants atomically replace existing `resource_members`; selecting owner-only access clears all grants and disables copying.

Only the owner and matching recipients can discover, inspect, and install a personal plugin. Revoking a recipient removes the original account install intent immediately, uninstalls online devices, and leaves offline devices pending reconciliation. When `allowCopy` is enabled, the copy endpoint returns short-lived download metadata. Electron verifies SHA256, ZIP paths, duplicate entries, symlinks, and the manifest, then atomically imports a uniquely named `0.1.0` copy into `wework-personal`. Provenance stays in the local registry and is never embedded in the uploaded package; revoking the original does not remove an independent copy.

The Executor owns managed package caching, integrity checks, sync events, and device-result reporting. Codex App Server remains the installation and uninstallation authority. Device results are exposed through `InstalledPlugin.status.devices`; an API request must never report the current device as installed when App Server rejected the operation. Server-side scanning rejects path traversal, duplicate paths, symlinks, encrypted members, sensitive files, oversized expansion, checksum mismatches, and missing manifests.

Administrative APIs include `GET/POST /admin/plugins/upstreams`, `PATCH /admin/plugins/upstreams/{id}` for synchronization policy changes, `POST /admin/plugins/upstreams/{id}/sync`, `GET /admin/plugins/submissions`, and `POST /admin/plugins/submissions/{id}/review`.

`GET /plugins/capabilities` exposes publishing and personal-sharing capabilities separately. The server grants publishing only to administrators, the global `PLUGIN_PUBLISH_ENABLED` flag, or IDs in `PLUGIN_PUBLISH_USER_IDS`; submission endpoints repeat the authorization check. Restricted sharing is not controlled by the public publishing allowlist but still requires the same security scan. Owners manage grants through `GET/PUT /plugins/marketplace/{id}/access`; authorized recipients use `POST /plugins/marketplace/{id}/copy` only when `allowCopy` is enabled. Upstream synchronization never replaces `latest_release_id` with an older SemVer and preserves the current Release after scan failures or upstream removal.

Submission clients call `POST /plugins/submissions/{id}/cancel` when the presigned upload or completion request fails. Cancelled, rejected, and expired submissions can reuse the same version; active uploads and scans remain protected from replacement.

Use `uv run python scripts/migrate_plugin_marketplace_v2.py` for a restartable legacy migration. After validating counts, checksums, downloads, and install references, rerun it with `--retire-legacy` to deactivate legacy marketplace Kinds and remove copied marketplace blobs.

The first curated set should prioritize GitLab Engineering, GitHub, Gitee, and Chrome DevTools, followed by high-value Chinese collaboration plugins. Every candidate requires a product-value, license, ownership, authentication, and security review; the Codex marketplace is never mirrored wholesale.

Runtime plugin identity uses `plugin://<plugin-name>@<marketplace-name>`. Managed marketplace names are derived from visibility through one shared mapping: `personal -> wework-personal`, `workspace -> wegent`, and `public -> wework`. The frontend must reuse the same mapping when generating trial mentions, Composer app metadata, and application-create plugin matching, and should only apply that fallback to managed install rows whose `providerKey` is `wegent-market` or `wegent-marketplace`. Ordinary `public` plugins remain valid. Only built-in application plugin rows owned by the system `user_id=0` and still stored with legacy `public` visibility are normalized to the current registry identity, `workspace / wegent`, during the built-in installation path.

## Publishing WeWork official plugins

First-party plugins are maintained in
[wecode-ai/wework-plugins](https://github.com/wecode-ai/wework-plugins) and
published to the Wework official tab with `--visibility public`.

Layout matches openai/plugins: each plugin lives under `plugins/<slug>/` and
must contain `.codex-plugin/plugin.json`, capability files, and tests. These are
development and CI inputs only; Backend and Wework must never read them as a
runtime package source. Check the repository out as a sibling of Wegent (for
example `wework-plugins-public`).

Use `--visibility workspace` only when a deployment maintains its own reviewed
source tree for a deployment-wide internal catalog. Do not document private
hostnames or internal repository paths in shared docs.

The publisher sorts paths and normalizes ZIP timestamps and permissions, runs
the shared package scanner, and then creates a `source_type=native`,
`source_provider=wework`, `owner_user_id=NULL` Plugin and immutable Release:

```bash
# Build, scan, and print the SHA256 without MySQL or S3 writes.
uv run python scripts/publish_official_plugin.py \
  ../wework-plugins-public/plugins/<plugin-slug> --dry-run

# Wework official tab (public GitHub repo)
uv run python scripts/publish_official_plugin.py \
  ../wework-plugins-public/plugins/<plugin-slug> \
  --visibility public \
  --commit-sha "$CI_COMMIT_SHA" \
  --build-url "$CI_JOB_URL" \
  --publisher release-bot
```

Retries with the same `slug + version + SHA256` return the existing Release. The service rejects different content under an existing version. Audit data is stored in `scan_report_json.provenance`, including commit SHA, build URL, publisher identity, and an optional `created_by_user_id`.

Inject CI credentials only through protected secrets. The publisher needs MySQL write access for Plugin/Release rows and object-create access under `plugins/{plugin_id}/{release_id}/`; runtime installation identities need read-only access to final objects. Enable bucket versioning or Object Lock and deny overwrite on final keys. Configure a lifecycle rule for `plugins/staging/` (typically 1–7 days); the submission flow also makes a best-effort deletion after finalization.

Rollback never mutates an old Release. Fix the source, increment SemVer, and publish a new package. An emergency unlist may change catalog status or the `latest_release_id` pointer while retaining the old package and audit history; restore only to a scanned `ready` Release. S3 upload failure rolls back database state, while database commit failure triggers best-effort deletion of the newly created object.

Migration `d4e5f6a7b8c9` creates the plugin marketplace control-plane tables in one revision, including `plugins.allow_copy` and `plugin_submissions.purpose`. Deployment must verify upgrade, one-revision downgrade, and re-upgrade, and release Backend before a Wework client that exposes sharing.

## Implementation status and verification (2026-07-29)

### Shipped in this pass

- **Backend**: restricted-share submissions, owner access replacement, recipient visibility, copy authorization, and revocation-driven uninstall synchronization reuse the shared scanner.
- **Electron**: safe personal-copy import with SHA256, duplicate/path/symlink/manifest checks, unique naming, atomic rollback, and local provenance mapping.
- **Wework**: distribution filters, a single installed-plugin management list, unified capability details, real share/copy flows, and plugin-aware slash and rich-mention interactions.

### Automated checks (local)

| Suite                                                  | Result                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `backend/tests/services/test_plugin_marketplace_v2.py` | 40 passed                                                                                  |
| `wework` Vitest                                        | 224 files / 2217 passed                                                                    |
| Electron `plugin_copy`                                 | 5 passed                                                                                   |
| Alembic upgrade → downgrade → upgrade                  | Passed on an isolated database                                                             |
| Isolated Electron `ai:verify`                          | Marketplace, details, management, slash picker, prompt prefill, and branded mention passed |

### Blocked on environment

- The complete two-account desktop E2E for share → install → copy → revoke still requires deployed test accounts and object storage.

### Defect-first review

No open **P0/P1** issues on the V2 diff after this pass; remaining **P2** items are the environment and media follow-ups above, not blockers for the core install/publish flow.
