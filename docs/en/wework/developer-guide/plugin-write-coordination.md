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
  every 10 seconds; Rust bounds the entire operation to 20 seconds.
- The scope covers a user's plugin domain because automation policy, account
  transfers, and installations have cross-plugin constraints. Transactions
  requiring multiple users acquire leases in ascending user ID order.
- Renewal and release compare the token. Redis failures reject writes without
  falling back to execution without coordination.
- Ownership lasts until the outer transaction commits, rolls back, or closes.
  Ending a savepoint does not release the lease.

A Redis ownership check alone cannot stop a worker suspended immediately after
that check from committing. After acquisition, an independent short transaction
publishes the token in `plugin_write_fences(user_id, token)`. The final business
statement conditionally updates the token to `{token}:committed`, requiring one
affected row. A successor's new token makes the old transaction fail and roll
back. Normal DML transaction locks remain; explicit locking reads are unnecessary.

Python sessions call `configure_plugin_session` before their first SQL statement.
HTTP uses the shared `get_plugin_db` dependency and READ COMMITTED so reads after
lease acquisition observe current committed state. Rust starts a pinned business
transaction after acquiring ownership. External OAuth and device requests run
outside committed write transactions.

## Failures and deployment

HTTP errors use status 503 and `plugin_write_busy`, `plugin_write_unavailable`, or
`plugin_write_lease_lost`. The authentication broker returns the same rejection
codes. Python's Redis has a dedicated client with short timeouts and no network retries.
Fence claims use a separate pool, adding at most four MySQL connections per
process, with a one-second checkout limit to avoid exhausting the business pool.
Rust reuses Breeze pools with separate three-second limits for lease acquisition
and fence claims, and a 500-millisecond release limit. Catalog and permission
reads complete before pinning the business connection.

Run Alembic `upgrade head` before deployment to create `plugin_write_fences`.
Old workers do not participate in this protocol: drain old plugin writes before
activating the new Python and Rust writers together. Mutual exclusion cannot be
assumed while old and new writers coexist. Drain new writes before rolling back
the code and dropping the table as well.

The `test-plugin-auth-mysql` CI job runs real MySQL and Redis races covering logout
while a user row is locked, concurrent enrollment, uninstall/authentication races,
expired writers, and OAuth refresh.
