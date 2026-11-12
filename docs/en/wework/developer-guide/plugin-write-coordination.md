---
sidebar_position: 42
---

# Plugin authentication and installation write coordination

Installation, update, removal, authentication and device acknowledgements share
plugin Redis leases and database CAS. Different plugins have independent write
scopes; devices changing one account installation share its scope.

## Identity and storage

`kinds/InstalledPlugin/default` remains authoritative intent and
`plugin_device_installations` stores device outcomes. The new `plugin_states`
table has a unique `(user_id, plugin_key)` identity and retains creation counters,
synchronization generations, device watermarks, acceptance slots and intent order.
The derived installation name is available before first installation.
`installed_kind_id` preserves state identity through catalog-driven renames.

No columns or indexes are added to shared `kinds`. There is no separate operation
ledger, `FOR UPDATE`, or `GET_LOCK`.

## Redis leases

The key is `wegent:plugin-write:{user_id}:{InstalledPlugin.name}`. Device identity
cannot partition account-owned writes. Catalog repair also leases historical names.
TTL is 30 seconds, single-target acquisition waits at most three seconds, and the
transaction budget is 20 seconds. Python renews every ten seconds; Rust reuses
bounded leases. Checks, renewal and release compare ownership tokens.

Root commit, rollback and close release leases; savepoints do not. Batch scopes
are sorted and do not wait separately for every busy target. Failures roll back
before releasing acquired leases. Downloads, authentication adapters and device
RPCs execute outside write transactions. Local package preparation runs per
plugin; shared manifest publication uses a short lock.

## First creation and CAS

Atomic insertion claims the plugin's unique state identity. MySQL protects that
identity until COMMIT or rollback even when Redis expires first. Other plugin
keys can commit independently. Python uses the existing bounded bootstrap pool
and short database timeouts instead of holding business connections indefinitely.

Installation changes, creation-counter CAS and installation-ID binding commit
together. An expired first creator must still match its creation counter and
unoccupied installation binding. Soft removal retains installation and state;
reinstallation reuses their versions and watermarks.

`spec.revision` represents installation intent. `spec.writeRevision` fences
installation, authentication and device-row commits. Content replacement compares
both; a successful write already performed in the transaction avoids a redundant
second fence update. State uses revision CAS or atomic merging of independent
device paths; watermarks never decrease. Savepoint rollback restores expected
versions and cannot retain a false written marker.

## Synchronization

V3 captures plugin metadata revisions before reading intent, then CAS-publishes
each included plugin. `plugin_sync.revisions[installedId]` orders that plugin;
`intentRevisions[installedId]` identifies its intent revision. `complete=false`
and `removed_plugins` explicitly identifies removals. Absence cannot remove an
unrelated plugin.

New state starts above its historical V2 generation baseline and then advances
independently. Full Skills/MCP snapshots use a separate `@capabilities` stream;
ordinary plugin operations never touch it. V2 snapshots retain `@legacy-v2` for aggregate generations and CAS the captured
plugin revisions before publishing. Ordinary desired-state writes
do not create or advance account aggregate synchronization state.

Acknowledgements validate per-plugin generation, device watermarks, current intent
revision and desired state. Conflicts replay only database transactions, never
already-executed device operations. Deferred acknowledgement persistence does not
turn a committed installation into a failed account mutation.

## Account authentication preference

`ConnectorAuthPolicy/plugin-auth/account` remains the real account preference.
Only explicit preference edits acquire its dedicated lease and advance its
revision. Installation/update/removal do not depend on it. Authentication uses a
conditional no-op update to validate the preference through commit.

First policy creation claims `@account-policy` in the same new table and commits
that identity with the policy in one short transaction. Ordinary authentication
does not write this bootstrap identity. Duplicate policies and malformed versions
fail explicitly without selecting an arbitrary preference or resetting it.

## Migration, deployment and evidence

`a5b6c7d8e9f0` projects the active legacy synchronization Kind into plugin state,
preserving ordering and receipts. Ambiguous identities and invalid counters stop
before DDL. Downgrade merges maximum watermarks and latest receipts, restores the
old Kind and drops the new table.

Drain old plugin writers before switching Python and Rust together. Old backend
binaries cannot continue writing the removed Kind after migration. New backends
continue serving old desktops through V2. Production migration and deployment are
separate from local validation.

Real MySQL regressions cover COMMIT crossing Redis expiry, same-plugin uniqueness,
independent plugin progress, stale transactions, lifecycle operations,
authentication and late acknowledgements. Existing Backend MySQL CI and desktop
`plugin-write-coordination` / `plugin-registration-coordination` scenarios provide
coverage; use evidence tied to the reviewed commit.

Correlate lease logs by `user_id`, `plugin_scope`, `session_id`, `operation` and
`held_ms`. Acquisition contention, Redis failure, lost ownership and CAS conflicts
are distinct conditions and do not all indicate a leaked lock.
