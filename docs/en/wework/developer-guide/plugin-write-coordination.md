---
sidebar_position: 42
---

# Coordinating plugin authentication and installation writes

Plugins use Redis installation leases and CAS on existing business records. No table, column, or index is added, and MySQL named locks are not used. Before updating account sync state, receipt transactions use `FOR UPDATE` on the device-installation rows they will modify. Different plugins can install, update, uninstall, and authenticate concurrently; writes to the same installation coordinate with each other.

## Lease identity and duration

Ordinary operations use `wegent:plugin-write:{user_id}:{InstalledPlugin.name}`. Device IDs are excluded because devices modify the same account installation. First installation uses the existing stable name derivation. Reinstalls and historical names resolve the existing record, acquire its actual name, and revalidate the identity afterward.

Python reuses `DistributedLock.owned_lock`; Rust shares the key, random owner token, and Redis NX protocol:

```python
distributed_lock.owned_lock(
    f"wegent:plugin-write:{user_id}:{installation_name}",
    expire_seconds=180,
    blocking_timeout=3,
    redis_client=plugin_redis_client,
)
```

- TTL is 180 seconds. Completed transactions release immediately by token.
- A single lease waits at most 3 seconds; the operation budget stays 20 seconds. Python retains bounded renewal every 10 seconds; Rust starts no renewal task.
- Savepoints retain the root lease. Business mutations acquire sorted batch identities; failure rolls back the complete transaction and releases acquired leases rather than preserving partial revocation or removal. Device receipts commit each installation separately.
- Ownership checks, renewal, and release compare tokens. Stale requests cannot release successor leases, and unavailable Redis causes an explicit failure.
- No Redis user mutex encloses ordinary account plugin operations. Policy edits use `@account-policy`; initial creation of missing account sync metadata uses `@sync-init`. Neither encloses routine installation, update, or removal.

An application or network timeout does not prove database transaction termination. The 180-second lease provides additional margin for short transactions. A process that exits without releasing may leave the same plugin unavailable for the remaining TTL; other plugins use independent keys.

## Existing persistence

Account desired state remains in `InstalledPlugin/default` Kind records; device materialization remains in `plugin_device_installations`.

The existing `PluginSyncState/plugin-sync/account` Kind, scoped by `user_id`, retains generation, device watermarks, per-instance per-plugin intent order and latest acceptance markers, and `creationRevisions[installation name]`. There is no `plugin_states` table and no batch or lazy state transfer.

`InstalledPlugin.spec.writeRevision` fences authentication, installation, and device writes. Installation intent `spec.revision` advances on desired-state changes. Missing historical revisions read as zero and advance through normal writes without bulk backfill.

Before an installation row exists, its Redis lease protects reading its creation counter; commit compares that plugin's slot. Independent metadata paths merge into the account document. Final SQL writes can briefly contend on that shared row, without holding it across downloads, adapters, or IPC.

Snapshots read the sync revision before desired state and CAS their generation. Acknowledgements verify generation, watermarks, installation intent, and current desired state before persistence. Ordinary authentication validates the real account policy without advancing its shared preference version; only edits to automatic authorization advance that version.

## Accepted initialization boundary

First creation of `PluginSyncState` and `ConnectorAuthPolicy` is coordinated by 180-second Redis metadata leases. Existing records use CAS.

The explicitly accepted residual risk is an unresolved database COMMIT or suspended process outliving its lease: a successor can still see no committed record and insert again. Without database uniqueness, TTL and renewal cannot prove unique first creation. Duplicate records require explicit rejection and manual investigation. Human review must acknowledge this boundary; ordinary concurrency tests do not demonstrate safety for that fault.

## Native and background synchronization

V2 synchronization and account HTTP local operations remain in use. The desktop prepares plugins independently and shares only short manifest publication work. Equivalent HTTP/Socket deliveries share preparation and validate their own generations; target changes, updates, and removal end the old equivalence range.

The durable desktop cache separates encoded directory metadata from per-plugin installation state. Unchanged directories reuse their encoding; installation, removal, and acceptance receipts are still saved together in one synchronous storage write. The directory uses chunks of 256 entries, so only chunks with changed metadata need re-encoding; cold reads reuse the saved encoding. Initial loading or an actual large directory update still incurs encoding work.

Package digests and activation content scans use the existing `ring` dependency for SHA256, reducing publication-lock waits caused by software hashing in Debug builds. Digest formats, complete file reads, file identity and timestamp checks, and tamper detection remain unchanged.

Foreground plugin operations do not join the full reconciliation queue. Full checks serialize scan evidence without holding the short journal lease while waiting, and revalidate plans after foreground activity. Refresh retains bounded deferral for `plugin_local_sync_busy` while foreground installation, update, and removal continue.

Idempotent local intents and background device preparation retry `plugin_write_busy` and CAS conflicts within a 20-second retry window. Each retry rolls back and closes its session before reading the current intent again, without replaying an executed device RPC. Background reads do not acquire installation leases, and an empty peer-device list creates no pending rows. Source-device receipts still reconcile legacy device aliases.

Native and registration receipts share a 20-second deadline across reads, lease acquisition, and transactions. Installations in the same acknowledgement progress independently, so a busy plugin cannot prevent an unblocked peer from committing. Batch acquisition does not poll a busy later plugin; each Redis request observes the absolute deadline, and failure releases earlier claims. Writers finish asynchronous cleanup before returning a timeout.

The shared receipt flush first locks updated or deleted device rows in primary-key order, then existing insert targets in resource-identity order, before the account-state CAS and deferred device writes. Row-lock waits therefore precede the shared account write lock. A failed CAS still emits no deferred device writes. Alias reconciliation and pending preparation also process device rows first; metadata publication touches only account state. Python plugin writers acquire the same plugin leases before modifying data to prevent a reversed cross-entry lock order.

When MySQL aborts a plugin synchronization transaction with error 1213, the transaction runner rolls back and closes the session, then rebuilds the snapshot in a fresh session within the existing account-state CAS retry budget.

The executor journals actual local application before requesting server confirmation. A transient confirmation failure retains the actual result, accepted operation, and `reconcilePending`, establishes no current confirmation proof, and displays a pending-confirmation message. Existing automatic checks and manual refresh revalidate and confirm that state. When a registered source device exists, only completed confirmation returns `localCompleted`; local operations without device registration remain independent of device receipts. Stale or unowned receipts cannot overwrite newer installation intents.

Automatic authentication retains startup, reconnect, inventory-change, and local login/logout events plus a 300-second audit with per-process jitter of ±30 seconds. Preparation and read-only status queries do not acquire batch installation leases; credential writes acquire their target installation.

## Deployment and existing development databases

The former user lock and plugin leases are different protocols. Drain old plugin transactions and switch Python/Rust writers together instead of mixing protocols.

Deploying this design from main needs no additional coordination table or state migration. Normal startup still applies main's existing migrations.

If a development database ran this PR's table-based version, preserve a backup and use the native migration tool from `e677c1a84`: `wegent-backend-rs db downgrade b1c2d3e4f5a6`. It merges watermarks and latest receipts into the retained Kind before dropping the extra table, while preserving main's share-token migration. Verify the revision before starting this table-free version. Do not truncate the table or stamp past the state merge. This code change does not automatically alter development or production databases.

## Verification

Reuse existing plugin unit, real MySQL/Redis, and desktop checkpoint suites without new CI jobs. Cover independent 180-second leases, same-plugin contention and CAS, ordinary first-creation concurrency, account isolation, duplicate delivery, late acknowledgements, and foreground isolation from authentication and full reconciliation.

The Redis test checks PTTL; HTTP identity cases remain imported by `test_plugin_write_races_mysql.py`. Desktop coverage uses `plugin-write-coordination` and local synchronization checkpoints. Strict uniqueness of initialization across lease expiration is outside this design's guarantees.

The local HTTP real MySQL/Redis fixture covers both Native and registration receipts with a permanently leased A and an independently committed B in the same batch, plus pool waits and cleanup after database row-lock timeouts. Virtual-clock unit tests cover slow Redis acquisition deadlines. Confirmation interruption and recovery extend the existing `plugin-write-coordination` desktop checkpoint.
