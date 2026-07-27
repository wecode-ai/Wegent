---
sidebar_position: 20
---

# Wework Plugin Marketplace V2

## Architecture

Marketplace V2 uses a Wework cloud control plane with a local Codex runtime. MySQL stores catalog metadata, immutable releases, selected upstreams, submissions, account install intent, and per-device materialization. Private S3-compatible storage holds packages. Codex App Server remains the source of truth for the current device.

The regular user sees only the Wework cloud catalog. Codex plugins are mirrored only after an administrator selects them. Local creations live in the `wegent-personal` marketplace and are uploaded only after an explicit publish action. A Skill is represented as a Codex plugin containing exactly one Skill.

## Storage model

| Data | Location |
| --- | --- |
| Catalog, releases, upstreams, submissions | MySQL |
| ZIP packages and media | Private MinIO/S3 bucket |
| Account desired state | Existing `kinds/InstalledPlugin` |
| Device actual state | `plugin_device_installations` |
| Local creations and registry | Wework Codex Home / Codex App Server |
| Tokens and MCP secrets | Local secure storage |

New tables are `plugins`, `plugin_releases`, `plugin_upstreams`, `plugin_submissions`, and `plugin_device_installations`. `skill_binaries` is retained only for legacy Skills and migration history. Published Release package fields and manifests are immutable.

## Lifecycle

Installation upserts account intent, creates pending device rows, sends a short-lived signed package URL, verifies SHA256 and the Codex manifest, installs atomically, and records each device result. Existing installs update manually. Local creations never call the cloud upload API. Publishing uses a presigned PUT, server-side scanning, and human review before a Release becomes searchable.

Wework sends the local Executor's stable `device_id` to catalog and mutation APIs. A catalog item is installed only when that device reports `state=installed` with `actual_release_id` equal to the desired Release. A mutation returns `502` only when the requesting device fails; failures on other devices remain visible for reconnect reconciliation. WebSocket reconnect sync writes per-plugin results back and clears completed uninstall or stale failure rows.

Publishing a local creation does not require a manually selected ZIP. Tauri locates the plugin in the local marketplace, packages it natively, and validates the Codex manifest, symlinks, path containment, the 50 MB archive limit, and the 200 MB expanded-size limit. A single-Skill plugin is submitted with `listing_type=skill` automatically.

The Executor owns managed package caching, integrity checks, sync events, and device-result reporting. Codex App Server remains the installation and uninstallation authority. Device results are exposed through `InstalledPlugin.status.devices`; an API request must never report the current device as installed when App Server rejected the operation. Server-side scanning rejects path traversal, duplicate paths, symlinks, encrypted members, sensitive files, oversized expansion, checksum mismatches, and missing manifests.

Administrative APIs include `GET/POST /admin/plugins/upstreams`, `POST /admin/plugins/upstreams/{id}/sync`, `GET /admin/plugins/submissions`, and `POST /admin/plugins/submissions/{id}/review`.

`GET /plugins/capabilities` exposes whether the current user may publish. The server grants this only to administrators, the global `PLUGIN_PUBLISH_ENABLED` flag, or IDs in `PLUGIN_PUBLISH_USER_IDS`; submission endpoints repeat the authorization check. Upstream synchronization never replaces `latest_release_id` with an older SemVer and preserves the current Release after scan failures or upstream removal.

Use `uv run python scripts/migrate_plugin_marketplace_v2.py` for a restartable legacy migration. After validating counts, checksums, downloads, and install references, rerun it with `--retire-legacy` to deactivate legacy marketplace Kinds and remove copied marketplace blobs.

The first curated set should prioritize GitLab Engineering, GitHub, Gitee, and Chrome DevTools, followed by high-value Chinese collaboration plugins. Every candidate requires a product-value, license, ownership, authentication, and security review; the Codex marketplace is never mirrored wholesale.

## Publishing Wegent official plugins

Official plugin sources may live in a separate repository or under `official-plugins/<slug>/` in this repository. Each directory must contain `.codex-plugin/plugin.json`, capability files, and tests. It is a development and CI input only; Backend and Wework must never read it as a runtime package source.

The publisher sorts paths and normalizes ZIP timestamps and permissions, runs the shared package scanner, and then creates a `source_type=native`, `source_provider=wegent`, `owner_user_id=NULL` Plugin and immutable Release:

```bash
# Build, scan, and print the SHA256 without MySQL or S3 writes.
uv run python scripts/publish_official_plugin.py \
  ../official-plugins/gitlab-engineering --dry-run

# Run only in an approved CI release environment.
uv run python scripts/publish_official_plugin.py \
  ../official-plugins/gitlab-engineering \
  --visibility public \
  --commit-sha "$CI_COMMIT_SHA" \
  --build-url "$CI_JOB_URL" \
  --publisher release-bot
```

Retries with the same `slug + version + SHA256` return the existing Release. The service rejects different content under an existing version. Audit data is stored in `scan_report_json.provenance`, including commit SHA, build URL, publisher identity, and an optional `created_by_user_id`.

Inject CI credentials only through protected secrets. The publisher needs MySQL write access for Plugin/Release rows and object-create access under `plugins/{plugin_id}/{release_id}/`; runtime installation identities need read-only access to final objects. Enable bucket versioning or Object Lock and deny overwrite on final keys. Configure a lifecycle rule for `plugins/staging/` (typically 1–7 days); the submission flow also makes a best-effort deletion after finalization.

Rollback never mutates an old Release. Fix the source, increment SemVer, and publish a new package. An emergency unlist may change catalog status or the `latest_release_id` pointer while retaining the old package and audit history; restore only to a scanned `ready` Release. S3 upload failure rolls back database state, while database commit failure triggers best-effort deletion of the newly created object.

## Implementation status and verification (2026-07-25)

### Shipped in this pass

- **Backend**: migration FK alignment; shared ZIP scanner and upstream fetch with SSRF guards; submission staging to content-addressed keys; review monotonicity for `latest_release_id`; per-plugin device materialization with failed-update retention; 120s reconnect sync timeout; admin upstream fields and plugin visibility grant API.
- **Executor**: SHA verification, ZIP safety limits aligned with the server scanner, staged install with store rollback when Codex `plugin/install` fails.
- **Wework**: management page merges cloud intent with local App Server state; marketplace update confirmation and error surfaces; presigned PUT via Tauri HTTP; E2E covers the cloud default marketplace tab.

### Automated checks (local)

| Suite | Result |
| --- | --- |
| `backend/tests/services/test_plugin_marketplace_v2.py` | 21 passed |
| `wework` Vitest (including `App.plugins.test.tsx`) | 1972 passed |
| `executor` `cargo check` | OK |
| `executor` `local_capability_sync_contract` (ZIP / rollback cases) | OK |

### Blocked on environment

- Full `wework ai:verify` needs a live Backend, MySQL, object storage, and a real Tauri desktop; not run in the sandbox-only CI loop here.
- Plugin icon/screenshot media remains a follow-up; not on the publish critical path.
- Plugin visibility currently exposes a grant API only; member list/revoke UI is out of scope for this pass.

### Defect-first review

No open **P0/P1** issues on the V2 diff after this pass; remaining **P2** items are the environment and media follow-ups above, not blockers for the core install/publish flow.
