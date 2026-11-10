---
sidebar_position: 59
---

# Local plugin execution without device registration

Local install, uninstall, update and reconciliation use authenticated account HTTP and local IPC. Device registration, a device ID, Socket connectivity and other-device acknowledgements are not prerequisites. Managed account authentication keeps its existing secure routing.

## State ownership

`InstalledPlugin/default` remains authoritative account intent. No new tables, migrations, independent operation records, snapshot history or receipt ledger are created. There are no records in a `plugin-local-sync` namespace.

The existing `PluginSyncState/plugin-sync/account` retains generation and device watermarks. `spec.localIntentOrders` fences old requests per instance/plugin. `spec.localIntents` retains only one latest acceptance marker per instance/plugin: operation ID, request hash, order, installed ID, action and installed revision. It stores no complete plugin copy or operation history. Markers, watermarks and account changes commit atomically under the existing account write lease and revision CAS.

Native persists original requests before HTTP in an account/Backend-scoped journal without tokens. The shared Socket/HTTP installer owns real files, manifests, generation ordering, tombstones, validation and publication.

## Execution

1. Probe `POST /api/plugins/local-sync` with `probeOnly=true`; require protocol 1 and contract revision 3. Backend probing performs no writes.
2. Submit original account mutations through the existing Python endpoints with `delivery_mode=local_pull_v1`, operation ID and intent order.
3. Replay matching latest markers without executing the mutation again. Persist the desired state and marker together for new accepted writes.
4. Read the current plan through the same Rust endpoint and apply it through local IPC. Plans are returned directly and never persisted. There are no snapshot IDs or receipt endpoint.
5. Complete locally after real application, without cloud acknowledgements. Targeted mutations use deltas; full reconciliation discovers legacy changes and implicit removals.
6. Reuse existing background Socket dispatch and registration-time synchronization for cloud devices. Optional source routing never gates local operations. Automatic updates retain the existing account batch mutation.

## Recovery and rollout

Timeouts, missing/mismatched acceptance headers, 5xx, authentication failures and unknown conflicts retain the original ID, order, action, target and payload. They do not trigger a legacy fallback.

A compacted request cannot override later intent: persistent watermarks fence late arrivals. Only a matching explicit `409 INTENT_SUPERSEDED` with `X-Plugin-Operation-State: superseded` archives the original request as superseded. Installation revision changes from legacy APIs, another instance or automatic updates also fence accepted replays. Ordinary acknowledged business rejections retire only unaccepted requests. Absence of a compacted marker is not proof of nonacceptance: rejection acknowledgement also requires an order newer than the retained instance watermarks.

Pending recovery runs independently from full snapshot HTTP/application and merges its result into the freshly loaded journal. Automatic update and reconciliation scheduling remain independent; real file publication remains serialized. Profile changes fence queued requests and publication.

Deploy all Backend, gateway and Runtime replicas before enabling `PLUGIN_LOCAL_SYNC_ENABLED` (default false). Legacy requests without the mode preserve their original behavior. Contract 3 does not mix with contract 2 from earlier PR revisions. Disabling new acceptance retains replay and reconciliation for existing instances. Old local pending requests are preserved; obsolete receipt entries are no longer sent.

Focused tests cover no-device lifecycle, bounded acceptance slots, request hashing, rollback, compacted and legacy-write supersession, isolation and independent recovery. Existing CI invokes real HTTP/MySQL/Redis coverage and the desktop `plugin-write-coordination` checkpoint. Actual release-package compatibility for 1.0.0, 1.1.0 and 1.1.1 remains unverified.
