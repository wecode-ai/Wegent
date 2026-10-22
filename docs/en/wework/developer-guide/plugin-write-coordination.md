---
sidebar_position: 42
---

# Plugin authentication and installation write coordination

Status: the simplified shared Redis lock and business revision CAS implementation
is complete. Local regressions passed; it is not deployed.

Authentication, logout, installation, reinstallation, updates, removal, and device
installation state use Redis coordination instead of `SELECT ... FOR UPDATE` on
`users.id`. Publication and device registration retain their existing lock policies.
This protocol adds no table, column, or index, does not change user creation,
registration, or OIDC, and requires no precreated coordination records.

## Shared Redis lock

Python reuses the strict ownership interface in `app/core/distributed_lock.py`:

```python
distributed_lock.owned_lock(
    f"wegent:plugin-write:{user_id}",
    expire_seconds=30,
    blocking_timeout=3,
    redis_client=plugin_redis_client,
)
```

`DistributedLock.owned_lock` accepts the complete key and returns a redis-py `Lock`
with `thread_local=False`. Callers can inject the plugin Redis client with short
timeouts. An unavailable client raises `DistributedLockUnavailableError`; plugin
writes fail explicitly on Redis errors instead of proceeding without a lock.
Existing callers of `acquire`, `release`, and the watchdog retain their behavior.

Python and the migrated Rust plugin writers use the same protocol:

- Key: `wegent:plugin-write:{user_id}`, with a unique token per holder. Python's
  shared lock manages the ownership state.
- Contention waits up to 3 seconds; TTL is 30 seconds. Python renews every
  10 seconds. Both runtimes reject commits when a checkpoint detects more than
  20 seconds of operation. Rust reuses its existing Redis client and uses a bounded
  lease without a renewal task.
- The scope is a user's plugin domain because automation preferences, account
  transfers, and installations have cross-plugin constraints. Transactions
  requiring multiple users acquire locks in ascending user ID order. Bulk access
  revocation and personal plugin deletion acquire all affected users' locks before
  changing business state. They share one 3-second coordination budget, also
  bounded by any existing lease's remaining operation time. Acquisition failure
  rolls back the whole transaction and releases acquired locks without partial
  revocation. Policy reads count toward this budget, but synchronous I/O cannot
  be interrupted; business changes do not start after the budget is exhausted.
  Revocation and deletion have no business limit on installation count. The
  coordination and operation budgets still apply. A timeout or conflict rolls
  back the whole transaction, preserving grants and installation state so the
  caller can explicitly retry.
- Renewal, ownership checks, and release compare tokens. An old worker must not
  release its successor's lock.
- After acquiring the lock, reread policies, installations, connections, and other
  business state instead of reusing state read before waiting for Redis.
- Hold the lock until the outer database transaction commits, rolls back, or
  closes. Ending a savepoint does not release it.

Rust checks the acquisition deadline before every lock `SET`. Once the final
wait consumes the budget, it returns `plugin_write_busy` without another write,
preventing an expired request from leaving a new lease that blocks later login.

## Coordination diagnostics

For `plugin_write_busy` diagnostics, correlate Backend lease acquisition, release,
and contention logs by `user_id`, process-local `session_id`, and native
`operation`. Release logs include `held_ms` to distinguish a long transaction
from contention caused by an injected lease. Redis ownership tokens and plugin
credentials are never logged. Contention retains the existing timeout budget
without automatic retries.
Both desktop E2E runner and CI cleanup preserve `backend-rs-logs`, so requests
to Rust writers sharing the lease remain available in uploaded diagnostics.

## Business revisions and first-use policies

Redis provides normal mutual exclusion; revision CAS on existing business records
detects concurrent changes. Before reading dependent installation, connection, or
migration state, each plugin writer reads the user's real account-wide automation
preference:

```text
kinds
  user_id   = current user
  kind      = ConnectorAuthPolicy
  namespace = plugin-auth
  name      = account
  json.spec = { enabled: user preference, revision: concurrency version }
```

Queries include the complete identity and inactive records. After acquiring Redis,
query again. If no policy exists, create the real default policy with
`enabled=true, revision=0` in an independent short transaction. After that commits,
the main business transaction rereads the policy revision before dependent state.
User registration does not precreate the policy. A default policy may remain if
initialization succeeds but business work fails, preserving the existing
default-enabled semantics. Existing policies retain their preferences and
revisions, including during reactivation. Duplicate policies and invalid revisions
reject writes rather than selecting an arbitrary record, overwriting an opt-out,
or automatically merging data.

At the end of the business transaction, atomically increment the policy revision
conditional on its primary key, complete identity, and observed revision. Exactly
one row must match; otherwise roll back the entire business transaction.
Installation, connection, and migration changes commit or roll back with the
parent CAS. Installations and account connections retain their own revision CAS;
package `version` is not a concurrency token. Read missing legacy revisions as
zero and advance them during normal writes, without a bulk revision backfill.
Policies retain preferences with no installations and must not be deleted on
uninstall.

First-use policy creation has no shared database row to CAS. Preventing duplicate
creation therefore depends entirely on normal Redis mutual exclusion. There is no
business unique index, extra shard record, or initialization script. Extreme
overlap after a long process pause or lease expiration can produce duplicate
policies; strict first-use uniqueness is not guaranteed. Later requests reject
duplicates so operators can inspect and reconcile them. CAS protection for an
existing record must not be described as a database uniqueness guarantee for
every first-use operation.

## Transactions and failure boundaries

Python sessions call `configure_plugin_session` before their first SQL statement.
HTTP uses the shared `get_plugin_db` dependency with READ COMMITTED and refreshes
ORM state so reads after acquisition observe current committed state. Rust saves
the policy revision before catalog preloading, checks it again on the pinned
business connection, and performs CAS before commit. External OAuth and device
requests run outside write transactions; result writes validate current business
state. Savepoint rollback restores expected versions without releasing the root
lock.

For transactions referring to the same policy row, CAS protects commit order:
once a successor commits, an older revision cannot overwrite it. A worker paused
after checking Redis ownership can still resume and win CAS before its successor
commits. Expiration alone does not guarantee that every old request rolls back.
Conflicts require a full business transaction rollback, fresh reads, and another
evaluation of business state. Do not blindly replay external OAuth effects.

On device registration, coordination failures during plugin preparation defer
only that round of plugin synchronization. After rollback, the existing `merge`
mode sends Skills/MCP without reading or sending plugins, and the result is not
recorded as a plugin installation acknowledgement. This preserves local plugins.
The partial round also defers removal of absent Skills/MCP until a later
successful full sync. The normal path still replaces the full desired state and
records plugin results.
Plugin preparation and acknowledgement persistence run in the existing thread
pool, creating and closing each Session in its worker so synchronous Redis and
database waits do not block the WebSocket event loop.

Normal INSERT, UPDATE, and DELETE retain InnoDB transaction locks; primary-key CAS
can also wait for another transaction. This change removes explicit coordination
on the shared `users` row that coupled plugin writes to unrelated transactions.
It does not eliminate all database write waits.

HTTP errors use status 503 and `plugin_write_busy`, `plugin_write_unavailable`,
`plugin_write_lease_lost`, or `plugin_write_conflict`; the authentication broker
returns the same rejection codes. Python's plugin Redis client uses short timeouts
and no network retries. Rust continues using its existing Redis client and the
same lock protocol. A release failure after a successful commit is logged without
reporting the committed write as failed; token checks and TTL protect the
successor's lock.

## Deployment and rollback

1. Stop and drain all old plugin writers, including automation, device sync, and
   OAuth callbacks, to avoid mixing protocols.
2. Check historical policies using their complete identity. Reconcile duplicate
   preferences, references, and revisions without silently selecting or deleting
   records.
3. This change includes no Alembic migration. The migration chain matches main,
   so the plugin refactor requires no database upgrade. Only test databases that
   ran an earlier version of this PR need manual cleanup before switching code:
   remove the retired index and restore the branch revision to its main parent.
   Maintainers perform this one-time test database cleanup outside the production
   migration chain.
4. Check Redis availability and confirm that Python and active Rust writers use
   the same key, TTL, and business revision protocol before enabling plugin writes.

No coordination-record initialization or bulk revision update is required.
Direct SQL and maintenance scripts must not bypass plugin locks to change the
same business state during live traffic. The production `wecode/cache/kinds.py`
extension is outside this repository; verify that its handling of existing
authentication Kinds does not block commits before deployment.

Rollback also stops and drains plugin writes and checks that the target version
works without a policy unique index. After index removal, do not directly deploy
a version that relies on that index to prevent duplicates. Client interfaces
retain their existing protocol; no client release is required.

## Regression verification

Two independent desktop checkpoints prepare their own plugin and device fixtures
and run in the existing Cloud CI shard 20:

| Checkpoint                         | Preconditions and steps                                                                                                                                                                                  | Expected results and recovery                                                                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-account-auth-coordination` | Real Electron, Executor, MySQL and Redis; log in and out while holding the user row; repeat with a plugin lease and denied Redis SET; pause credential export after reading the credential, then log out | Login, enrollment and logout complete within 15 seconds; failures preserve account state and return explicit codes; explicit retries succeed after recovery; delayed enrollment leaves credentials and device grants cleared |
| `plugin-registration-coordination` | Install a real plugin and old Skills/MCP; disable old capabilities and add new ones; reconnect the real Executor under a held plugin lease, then reconnect after release                                 | The partial round merges new Skills/MCP, retains the plugin and old capabilities, and writes no plugin ACK; recovery replaces obsolete capabilities and converges plugin installation state                                  |

Fault helpers roll back the user row lock, restore the isolated Redis SET
permission, and release leases in `finally`; the export fence is also removed
in `finally`. Evidence contains only status, digests and revisions, never
credentials. This revision passed 152 focused backend regressions; the new desktop
checkpoints have not been executed locally.

Plugin, shared-lock, API, and model compatibility tests, plus real MySQL/Redis
concurrency regressions, have local validation. Rust passed 2789 unit tests,
one doctest, formatting checks, and Clippy. No desktop E2E was run in this round;
the PR Checks show the latest CI results. The `test-plugin-auth-mysql` CI job
runs real MySQL and Redis concurrency regressions. Desktop scenarios retain
their isolated databases and Alembic migrations without extra coordination data
initialization.

Cover installation, removal, authentication, logout, and version updates; same-user
contention and different-user isolation; installation and policy rereads after
acquisition; commit, rollback, and savepoint lock lifetimes; token-checked release;
Redis failures rejecting writes; stale revisions on existing records; missing
revisions defaulting to zero; opt-out with no installations; duplicate policies
rejecting writes; and post-uninstall OAuth cleanup. When another transaction locks
only the target `users` row and plugin resources and dependencies remain healthy,
the plugin lifecycle should complete. Locks on plugin business rows still follow
normal transaction rules. Evaluate extreme lease-expiration overlap during first
policy creation within the limits described above.
