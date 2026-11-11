---
sidebar_position: 59
---

# Local plugin execution without device registration

Local install, uninstall, update and reconciliation use authenticated account HTTP and local IPC. Device registration, a device ID, Socket connectivity and other-device acknowledgements are not prerequisites. Ordinary local plugin commands keep their local authentication flow; managed account commands use the Native authorization below. Cloud and legacy clients retain Device/Socket permission checks.

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

Before application, persist only the existing `reconcilePending` marker, never a copy of the execution plan. Recovery fetches the account's current plan. Reading an older journal converts its `snapshot` object into this marker and removes the copy while preserving original pending requests and ordering. Foreground submission and background recovery share attempt, acceptance and rejection handling.

Pending submission starts before full content scanning. Fingerprints run on a blocking thread without the foreground execution or journal file lease. Before writing back, the coordinator revalidates the account, journal execution state and manifest revision, preserving acceptance results merged during scanning. New foreground operations or publications invalidate old scan results. A separate scan lease remains with the worker through cancellation, preventing duplicate scans from accumulating.

Deploy all Backend, gateway and Runtime replicas before enabling `PLUGIN_LOCAL_SYNC_ENABLED` (default false). Legacy requests without the mode preserve their original behavior. Contract 3 does not mix with contract 2 from earlier PR revisions. Disabling new acceptance retains replay and reconciliation for existing instances. Old local pending requests are preserved; obsolete receipt entries are no longer sent.

Focused tests cover no-device lifecycle, bounded acceptance slots, request hashing, rollback, compacted and legacy-write supersession, isolation and independent recovery. Existing CI invokes real HTTP/MySQL/Redis coverage and the desktop `plugin-write-coordination` checkpoint. Actual release-package compatibility for 1.0.0, 1.1.0 and 1.1.1 remains unverified.

## Managed account commands in local conversations

The Rust `POST /api/plugins/native-auth/exchange` endpoint issues a restricted
`plugin_native` session after the main process proves possession of the private
key bound to its existing desktop refresh token. Proofs bind the exact request
path, method, token and time; short Redis TTL markers reject replays. Sessions
expire within one hour and cannot authorize shared user, Device, Task or
Workspace APIs. Neither the private key nor the Native session enters renderer.
Older Backends returning 404 retain the existing Socket transport. HTTP failures
do not silently fall back to Socket.

Executor reuses the existing Broker and adapter pipeline. Account/Backend
switches cancel the Broker; same-account access-token rotation preserves its
endpoint. Sessions bind the current profile and late previous-profile responses
are discarded. Device registration status remains accurate, and cloud Device
grants and Runtime checks are unchanged. Ordinary local SDK commands retain their
existing local authentication flow.

No new tables, columns or execution ledger are added. Existing connection,
migration, transfer and policy records share the account write lease. Optional
JSON fields hold Native key grants (`localGrants`), keyed source observations
(`nativeAuthSources`), pending login generations and Native lease ownership.
Legacy credential writes preserve applicable Native grants; definition changes
and logout revoke them. Exclusive transfers keep escrow until durable adapter
detach, including lost acceptance replies. Uncertain OAuth refreshes require
reconnection rather than reusing a potentially consumed refresh token.

No new timers are introduced. Existing 15-second auth/revocation workers use
small HTTP exchanges instead of Socket, preserving cooldown/backoff. Empty
installed-plugin discovery returns immediately. Business reads, status and
prepare calls do not advance database revisions. Session renewal and transient
failures reuse the existing desktop refresh and 30-second retry scheduling.
Installation pending requests, ordering fences and reconciliation remain intact.

Real HTTP/MySQL/Redis tests cover no-Device sessions, user/key isolation, Python
ciphertext compatibility, refresh/revocation and escrow replay. The existing
CI-covered `plugin-account-auth-password` checkpoint also exercises local chat
and install/update/uninstall after a real Backend registration rejection,
without weakening its legacy assertions.
