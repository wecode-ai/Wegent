---
sidebar_position: 42
---

# Coordinating plugin authentication and installation writes

Plugins use Redis installation leases and CAS on existing business records. No table, column, or index is added, and neither `FOR UPDATE` nor MySQL named locks is used. Different plugins can install, update, uninstall, and authenticate concurrently; writes to the same installation coordinate with each other.

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
- Savepoints retain the root lease. Batches acquire sorted identities; failure rolls back the complete transaction and releases acquired leases rather than preserving partial revocation or removal.
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

Foreground plugin operations do not join the full reconciliation queue. Full checks serialize scan evidence without holding the short journal lease while waiting, and revalidate plans after foreground activity. Refresh retains bounded deferral for `plugin_local_sync_busy` while foreground installation, update, and removal continue.

Automatic authentication retains startup, reconnect, inventory-change, and local login/logout events plus a 300-second audit with per-process jitter of ±30 seconds. Preparation and read-only status queries do not acquire batch installation leases; credential writes acquire their target installation.

## Deployment and existing development databases

The former user lock and plugin leases are different protocols. Drain old plugin transactions and switch Python/Rust writers together instead of mixing protocols.

Deploying this design from main needs no additional coordination table or state migration. Normal startup still applies main's existing migrations.

If a development database ran this PR's table-based version, preserve a backup and use the native migration tool from `e677c1a84`: `wegent-backend-rs db downgrade b1c2d3e4f5a6`. It merges watermarks and latest receipts into the retained Kind before dropping the extra table, while preserving main's share-token migration. Verify the revision before starting this table-free version. Do not truncate the table or stamp past the state merge. This code change does not automatically alter development or production databases.

## Verification

Reuse existing plugin unit, real MySQL/Redis, and desktop checkpoint suites without new CI jobs. Cover independent 180-second leases, same-plugin contention and CAS, ordinary first-creation concurrency, account isolation, duplicate delivery, late acknowledgements, and foreground isolation from authentication and full reconciliation.

The Redis test checks PTTL; HTTP identity cases remain imported by `test_plugin_write_races_mysql.py`. Desktop coverage uses `plugin-write-coordination` and local synchronization checkpoints. Strict uniqueness of initialization across lease expiration is outside this design's guarantees.
