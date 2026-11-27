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

Native authorization writes with `X-Wegent-Plugin-Auth-Contention: 1` share a 200 ms deadline for preflight queries, plugin leases, first-time account policy lease acquisition, and pre-write ownership checks. Each key is tried once. When Redis confirms that the lease is occupied, requests with `X-Wegent-Plugin-Auth-Result: 1` or `2` receive HTTP 200 and the retryable business code `plugin_write_busy`. Clients that negotiate only the short deadline receive the marked 503. When the Redis acquisition reply misses the deadline and the server can confirm that no write transaction has begun, requests with `X-Wegent-Plugin-Auth-Result: 2` receive HTTP 200 and the retryable business code `plugin_write_lease_timeout`. Both HTTP 200 business responses carry `success:false`, `retryable:true`, and the response header `X-Wegent-Plugin-Auth-Contention: busy-before-write`. Clients that use the short deadline without negotiating version 2 still receive an unmarked 503 for this timeout. Acquisition timeouts log `outcome=redis_set_reply_unknown` for unknown replies and `outcome=redis_set_reply_late` for a lease confirmed after the deadline. Dependency failures and uncertain transaction outcomes retain their existing error responses.

The server reserves cleanup capacity before sending one `SET NX PX 200` with a 200 ms TTL. After a timely reply, one Lua script atomically compares the token and uses `PEXPIRE` to extend a still-valid lease to 180 seconds before starting a write transaction. Both commands share the 200 ms admission deadline. The provisional key expiration bounds promotion age; the script neither reads `PTTL` nor requires `redis.replicate_commands()`. Expired keys and successor tokens cannot be promoted. A late initial reply only triggers token-checked cleanup. If the initial reply remains unknown, the lease can last at most 200 ms from the time Redis executes the `SET`. Full cleanup capacity and unconfirmed promotion return `plugin_write_lease_timeout` to clients that negotiate version 2 and log `redis_cleanup_capacity_exhausted` and `redis_lease_promotion_not_confirmed`, respectively. If promotion takes effect and cannot be confirmed or released, Redis expiry clears the lease. Existing commit safeguards apply once a write transaction starts.

Executor sends at most three HTTP requests per foreground operation. Contention retries and result confirmation share that limit and the original call deadline.

- **Contention before a write.** Retries for ordinary contention start within one second of the first send. After a lease acquisition reply timeout is reported, the contention retry window extends to three seconds after the first send, and the third contention attempt starts no earlier than 2.7 seconds after the first send. The UI stays pending through these retries. If every request was confirmed to have stopped before writing, exhausting the budget prompts the user to try again later. For a completion that supports renewal, Executor can use the renewed token to resubmit the original result within the original budget if the previous response included the before-write retry marker and the account, backend, and device key match.
- **Lost write response.** For idempotent completion requests such as `oauth.finish`, Executor can resubmit the same operation ID and request body in the original session if the request is still pending near the deadline and an attempt remains. This confirmation can start after the three-second contention window. Both requests share the original call deadline. A successful response from either request establishes the result. After checking the account and target, the server can return an already recorded success. Each result advances the installation revision and publishes a credential change at most once. When both requests have been sent, Executor waits for the remaining response or the original deadline before reporting a failure. If both responses explicitly reject the operation before writing, Executor reports contention. An outcome that is still unknown at the deadline keeps the transport failure.

Login-triggered registration has dedicated scheduling capacity. A restored session or Socket connection wakes foreground scheduling immediately. Targets that failed discovery keep their existing retry deadlines. Ordinary reconciliation can register up to four installations concurrently. Runtime preparation takes place before taking a registration slot. Newly queued connectors on the same installation can prepare independently, and writes remain serial. Transient discovery errors retain the foreground reservation for that target. After a session owner changes, earlier work cannot update the new owner's reservations or backoff. Ordinary reconciliation retains its backoff and rechecks current state. Socket requests retain their existing protocol.

To investigate Native authorization contention, a 503, or a slow request, correlate the request ID in `api.log` with `Native plugin authorization finished` in Rust `info.log`. Expected contention is logged as `outcome=lock_busy_before_write` and can be counted separately after enabling business responses. Use `operation`, `failure_stage`, and `outcome` to inspect preflight MySQL reads, Redis acquisition, the authorization transaction, Redis ownership checks during the transaction, lease release, and notification timings. Fields marked `mixed` include both MySQL and Redis work. Redis ownership checks within the transaction are a subset of the transaction duration. `failure_dependency` identifies dependency failures. `mysql_error_kind` and the numeric `mysql_errno` describe known MySQL errors. Promotion failures also record `redis_error_kind`; a recognized nondeterministic-write restriction records `redis_error_reason=write_after_nondeterministic`. Raw Redis errors are not logged because they can contain tokens or credential-bearing arguments.

## Deployment and existing development databases

The former user lock and plugin leases are different protocols. Drain old plugin transactions and switch Python/Rust writers together instead of mixing protocols.

Deploying this design from main needs no additional coordination table or state migration. Normal startup still applies main's existing migrations.

If a development database ran this PR's table-based version, preserve a backup and use the native migration tool from `e677c1a84`: `wegent-backend-rs db downgrade b1c2d3e4f5a6`. It merges watermarks and latest receipts into the retained Kind before dropping the extra table, while preserving main's share-token migration. Verify the revision before starting this table-free version. Do not truncate the table or stamp past the state merge. This code change does not automatically alter development or production databases.

## Verification

Reuse existing plugin unit, real MySQL/Redis, and desktop checkpoint suites without new CI jobs. Cover independent 180-second leases, same-plugin contention and CAS, ordinary first-creation concurrency, account isolation, duplicate delivery, late acknowledgements, and foreground isolation from authentication and full reconciliation.

The Redis test checks PTTL; HTTP identity cases remain imported by `test_plugin_write_races_mysql.py`. Desktop coverage uses `plugin-write-coordination` and local synchronization checkpoints. Strict uniqueness of initialization across lease expiration is outside this design's guarantees.

The local HTTP real MySQL/Redis fixture covers both Native and registration receipts with a permanently leased A and an independently committed B in the same batch, plus pool waits and cleanup after database row-lock timeouts. Virtual-clock unit tests cover slow Redis acquisition deadlines. Confirmation interruption and recovery extend the existing `plugin-write-coordination` desktop checkpoint.
