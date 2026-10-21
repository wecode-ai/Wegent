---
sidebar_position: 42
---

# Plugin authentication and installation write coordination

Authentication, logout, installation, updates, removal, and device installation
state use Redis coordination instead of `SELECT ... FOR UPDATE` on `users.id`.
Publication and device registration retain their existing lock policies.

## Shared protocol

Python and the migrated Rust automatic update endpoint use the same protocol:

- Key: `wegent:plugin-write:{user_id}`; value: a random 32-character hexadecimal token.
- Contention waits up to 3 seconds; the lease lasts 30 seconds. Python renews
  every 10 seconds; both runtimes reject commits after 20 seconds of operation.
- The scope covers a user's plugin domain because automation policy, account
  transfers, and installations have cross-plugin constraints. Transactions
  requiring multiple users acquire leases in ascending user ID order.
- Renewal and release compare the token. Redis failures reject writes without
  falling back to execution without coordination.
- Ownership lasts until the outer transaction commits, rolls back, or closes.
  Ending a savepoint does not release the lease.

A Redis ownership check alone cannot stop a worker suspended immediately after
that check from committing. Before reading business state, each writer snapshots
`$.spec.revision` on the user's existing `ConnectorAuthPolicy` in `kinds`, with
namespace `plugin-auth` and name `account`. First use materializes the existing
default, `enabled=true, revision=0`, in an independent short transaction. Existing
policies need no extra connection and retain the user's automation preference.
Deactivated policy rows are reactivated while preserving that preference.

The final business statement atomically increments that revision, conditional
on the primary key, complete policy identity, and observed revision. Exactly one
row must match; otherwise the entire transaction rolls back. This real business
parent protects cross-record dependencies and absent records. Concurrent first
installs may temporarily insert different installation and ZIP rows, but only
one transaction can commit. A logout also prevents an older automation request
from committing a newly inserted migration intent. Installations and account
connections additionally use their own revision CAS; package `version` is not
a concurrency token. Missing legacy revisions start at zero; invalid values
reject writes.

Once a successor commits, older snapshots cannot commit. Acquiring a successor
lease alone does not decide commit order: either transaction may win CAS before
the other commits. Normal DML row locks remain, using primary-key lookups;
explicit locking reads are unnecessary, but lock waits are still possible.

Python sessions call `configure_plugin_session` before their first SQL statement.
HTTP uses the shared `get_plugin_db` dependency and READ COMMITTED so reads after
lease acquisition observe current committed state. Rust snapshots the parent
before catalog preloading, checks that version again on its pinned business
connection, and performs CAS before commit. External OAuth and device requests
run outside write transactions. Savepoint rollback restores expected policy
versions without releasing the root transaction's lease.

## Failures and deployment

HTTP errors use status 503 and `plugin_write_busy`, `plugin_write_unavailable`,
`plugin_write_lease_lost`, or `plugin_write_conflict`. The authentication broker
returns the same rejection codes. A conflict requires rolling back the entire
transaction and rereading business state; external OAuth effects must not be
blindly replayed. Python's Redis has short timeouts and no network retries.
Only first-use policy materialization uses a separate pool, adding at most four
MySQL connections per process with a one-second checkout limit. Rust reuses
Breeze pools with separate three-second limits for lease acquisition and policy
materialization, and a 500-millisecond release limit.

No new table or business column is required. Run Alembic `upgrade head` before
deployment to add a unique expression index for this exact policy identity
(MySQL 8.0.13 or newer).
It prevents competing first-use parents without constraining other Kinds or
same-name plugins from different sources. Duplicate historical policies stop
the migration for reconciliation rather than silently discarding preferences.
Old workers do not participate in this protocol: drain old plugin writes before
activating the new Python and Rust writers together. Mutual exclusion cannot be
assumed while old and new writers coexist. Drain new writes before rolling back
the code or dropping the index as well.

The `test-plugin-auth-mysql` CI job runs real MySQL and Redis races covering logout
while a user row is locked, concurrent enrollment, uninstall/authentication races,
expired writers, first-install ZIP rollback, missing policies, logout versus
automation, and OAuth refresh.
