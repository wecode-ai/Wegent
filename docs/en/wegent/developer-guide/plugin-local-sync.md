---
sidebar_position: 59
---

# Local plugin execution and independent cloud synchronization

Local installation, removal, updates, component changes and reconciliation use account HTTP and the local Runtime. Device registration, Socket connectivity and remote acknowledgements do not gate local completion. Account login and Backend connectivity remain necessary. Existing third-party authentication and logout are reused; managed account authentication still has its existing Device-routing requirements.

## Execution contract

1. Negotiate Backend and Runtime support before mutation.
2. Atomically persist a local journal entry, scoped by Backend and authenticated account ID, without storing credentials.
3. Call the existing mutation API with `delivery_mode=local_pull_v1`, `local_instance_id`, `operation_id` and a positive `local_intent_order`.
4. Commit account intent and the idempotent operation in one short transaction. No device enumeration or Socket call runs here.
5. Fetch current account state over HTTP with the shared account generation, then apply it through the same installer instance used by Socket synchronization.
6. Validate the published package and runtime files before completing locally. Persist receipts and send them independently, without holding the foreground coordinator lock.
7. Reuse the existing background Socket dispatch for cloud devices and their existing desired-state synchronization on registration. Remote failures do not change local acceptance or completion.

The unified installer retains checksum verification, generation fences, tombstones, prepare/publish recovery and account-switch cancellation. A fresh local file fingerprint and account revision must both match before reconciliation can be skipped. The existing automatic-update coordinator performs account HTTP reconciliation at startup, on connectivity/visibility recovery and every 120 seconds while visible and online. Old-client writes are included in the revision.

## APIs and storage

- Existing install, update, delete and builtin ensure-installed APIs retain their default behavior. New-mode acknowledgement uses `X-Plugin-Delivery-Mode` and `X-Plugin-Operation-Id`. DELETE remains 204.
- New Rust `POST /api/plugins/local-sync` combines capability negotiation, revision, current snapshot and operation lookup. Probe requests create no dispatch state. Unchanged requests return HTTP 200.
- Single mutations and per-plugin updates apply only a targeted delta. Manual refresh, repair and background account reconciliation directly use complete snapshots without replaying pending requests first. New actions and per-plugin updates select their own targets. A completed delta does not establish account-wide unchanged state.
- New Rust `POST /api/plugins/local-sync/receipts` validates the account, local instance, issued snapshot, generation and package acknowledgements. Obsolete receipts are superseded and cannot change account intent or another device. Each snapshot binds its acknowledged operation IDs; completing one plugin cannot retire unrelated pending operations.
- Existing package downloads accept optional `expected_release_id`; a mismatch returns 409 `RELEASE_CHANGED`, without falling back to an unrelated historical/uploaded package.
- The only new local IPC is `executor.plugins.local_sync`. Renderer inputs cannot supply executable scripts, package URLs or installation paths.
- Only `plugin_local_sync_operations` is added, recording operations, snapshots and receipts. No cloud dispatch queue, Redis Stream or polling worker is introduced. Existing Redis account leases remain the concurrency mechanism. Optional `source_device_id` excludes a resolvable origin only in background work; missing or unregistered origins block neither local execution nor other cloud devices. Automatic updates retain the existing account-version advancement and device reconciliation mechanisms.

Plugins requiring installation-time authorization may finish package installation first. The UI directs users to connect accounts in plugin details; the new transport does not roll back a verified installation because authorization is pending. Existing transport authorization behavior is preserved.

### Pending recovery and complete reconciliation

Before fetching a complete snapshot, Native prepares one original pending intent under the journal lease, rotating by attempt time, then submits it in an independent task. Snapshot HTTP errors, invalid contracts and package application failures do not cancel recovery. A separate recovery file lease prevents duplicate sidecar recovery. Retry HTTP acquires neither the foreground coordinator mutex nor the ordinary journal file lease, so it can progress while snapshot HTTP or the installer remains unresolved. Recovery briefly reacquires ordinary locks to reload the latest journal and merge by operation ID, preserving concurrent additions. Its failure does not determine full reconciliation success. Package publication retains the existing installer serialization.

The account coordinator independently coalesces automatic updates and full reconciliation, with separate in-flight state, failure handling and UI publication. HTTP-mode idle callbacks launch work without awaiting long requests, so either job can progress while the other fails or remains unresolved. Account replacement, disconnect and coordinator unmount prevent queued work and stale UI publication. Legacy mode retains its device locks and awaited idle scheduling.

Read-only capability negotiation does not acquire Native's foreground execution lease or replay pending requests. The local instance ID uses only a separate short file lease. Execution rechecks the account profile after waiting for the foreground lease, preventing queued work from being accepted after an account replacement. Installer publication retains its existing ordering protection.

Backend adds `X-Plugin-Operation-State: rejected` only for a definitive business rejection (400, 403, 404, 422, or 409 `INTENT_SUPERSEDED`) after acquiring the account write lease and checking that the account, instance and operation ID have no accepted operation. Failure to acquire the lease remains uncertain, protecting timed-out predecessors still committing. Native checks the delivery mode, operation ID, intent order, status and response body before archiving an unaccepted request in `rejectedOperations` and removing it from pending. Previously accepted requests remain protected. Default legacy requests do not receive these markers.

Timeouts, lost responses, 5xx, 401, 408, 429, other 409 responses, and missing or mismatched acknowledgement markers cannot prove nonacceptance. Native preserves the original operation ID, intent order, action, target and payload for idempotent retry across restarts, without creating a replacement request or switching to legacy transport.

## Rollout and compatibility

1. Apply migration `a9c1e3f5b702`. Its Alembic reference, native Rust asset and bootstrap schema are maintained together.
2. Deploy every Python, Rust and gateway replica, then release the compatible Runtime/Wework. New APIs are Rust-owned; existing Python API ownership remains unchanged.
3. Enable `PLUGIN_LOCAL_SYNC_ENABLED=true` on API replicas after deploying every replica. The flag defaults to false. Complete replica deployment is mandatory: old servers may ignore unknown query parameters.
4. Clients omitting the new mode retain legacy behavior. Explicitly unsupported servers/runtimes can select legacy before mutation. An uncertain new-mode mutation is never automatically replayed through legacy.
5. On rollback, stop acceptance while retaining the HTTP endpoints and Runtime recovery until accepted journals/receipts drain. Do not roll back to binaries unaware of the protocol while work remains.
6. Operation records remain available for idempotency and pending recovery; this change adds no cleanup worker. Issued snapshots expire after 24 hours. A nonempty new table blocks destructive downgrade until drained and archived.

## Validation boundaries

Focused Python tests cover default contracts, unregistered local writes, idempotency, atomic rollback and reuse of existing cloud-device dispatch. Disposable MySQL tests cover upgrade, downgrade guards and original-operation persistence. Rust HTTP/MySQL/Redis tests cover snapshots without Device rows, read-only probes, account/instance isolation and superseded receipts. Runtime tests cover damaged published files; Wework unit/component tests cover negotiation and transport boundaries.

Focused Python/Native regressions cover definitive rejection markers, protection of accepted requests, an actual HTTP timeout, released foreground locks during recovery, concurrent journal merge, and recovery despite snapshot HTTP errors, invalid contracts or failed application. Wework tests cover failed and unresolved update/reconciliation requests independently, coalesced triggers, and manual/background reconciliation bypassing pending replay.

The existing CI-covered `plugin-write-coordination` desktop checkpoint covers unregistered install/update/remove, held receipts, a 404 pending request not blocking full reconciliation, and original-request recovery after a committed response is lost despite an unrelated package download failing. It reuses existing services and builds. Adding this coverage does not claim a local Electron run. Compatibility with actual 1.0.0, 1.1.0 and 1.1.1 release artifacts requires separate evidence; default-contract regression tests do not establish it.

HTTP-mode UI installation, refresh and automatic updates do not require a device ID. Automatic updates do not require legacy device inventory or Socket configuration. Failed negotiation is probed again on online/visibility changes and the periodic account check, without waiting for Device registration. Disconnecting or replacing the account profile invalidates the old installer binding before in-flight work can publish. Legacy write regressions assert that neither acceptance-flag setting causes default requests or their background work to access the new tables.

The negotiated contract revision is 2. Native persists a monotonic intent order before sending HTTP and requires the matching `X-Plugin-Intent-Order` acknowledgement. Existing `PluginSyncState.spec.localIntentOrders` preserves per-instance, per-plugin ordering beyond operation retention. A first-arrival obsolete request receives 409 `INTENT_SUPERSEDED`; its entire transaction rolls back. Native retires it only with the matching rejection proof described above. Default legacy requests never enter this ordering path.

A changed HTTP-only reconciliation invalidates inventory caches and emits existing UI events; unchanged snapshots do not cause repeated refreshes. Marketplace presence validates the local proof against the current owned installation version and checksum. Failure to read that inventory leaves the healthy catalog readable without claiming a confirmed local installation. The existing desktop checkpoint also covers an older, unsubmitted uninstall being superseded by a successful update.
