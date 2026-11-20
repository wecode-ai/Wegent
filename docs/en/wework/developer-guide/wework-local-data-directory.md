---
sidebar_position: 22
---

# Local Data Directory

## Directory Layout

The desktop app defaults to `~/.wegent/workbench/wework/<namespace>`. The installed
package selects the namespace, which defaults to `default`. Electron app data uses
the `user-data/` subdirectory. Set `WEWORK_USER_DATA_DIR` to override it. Startup
opens the current directory directly. Tasks and local settings that exist only in
older directories stay on disk and are absent from the default workbench.

The managed desktop Executor uses the same namespace directory. The standalone
Executor defaults to `~/.wework`. The Executor Home contains the data below.
The desktop workspace defaults to `~/.wegent/workspace`.

- `codex/`: Wework's isolated Codex home (overridable with `WEGENT_CODEX_HOME`).
- `workspace/projects/` and `workspace/worktrees/`: local projects and managed worktrees.
- `workspace/chats/`: local task conversations.
- `workspace/attachments/draft/`: local attachment drafts.
- `capabilities/bundled-marketplaces/`: bundled plugin marketplace cache.
- `logs/`: Executor logs such as `logs/executor.log`.
- `runtime/`: per-process state such as the bridge identity.
- `device-config.json` and `device_id`: local device identity.

The `WEGENT_EXECUTOR_HOME` environment variable overrides the default Executor
Home. This is useful for isolated sessions, tests, and custom deployments.

## Desktop Executor Identity

Managed desktop and standalone Executors both prefer persisted identities and
generate new ones only when missing.

Without an explicit verification override, the Electron host first reads `desktop-device-id`, preserving IDs saved by older
versions. Only when the file is absent does it hash the machine hardware UUID and
application identifier (default `io.wecode.wework`) with SHA-256 and save
`electron-<hash>`. Without an existing identity, the same machine and application
produce the same ID. The raw hardware UUID is never sent as a device ID or written
to identity files or logs.

The managed Executor uses the host ID for local IPC and cloud `app_device_id`.
Both managed and standalone Executors first use the `device_id` and
`runtime_instance_id` persisted in `device-config.json`. Environment values seed
only missing fields: the host supplies `device-<app_device_id>` and
`runtime-<app_device_id>`; standalone Executors generate IDs when no seeds exist.
New identities are saved and retained on restart. These three identities preserve
their distinct routing responsibilities. Account permissions, session tokens and
record-scoped routing remain controlled by authentication and registration;
hardware hashes do not grant authority.

Identity resolution neither moves conversation data nor rewrites saved references,
and does not infer identity from old worktree records. Without an override, empty or unreadable identity
files fail startup rather than silently replacing an identity. A valid hardware
UUID is required only when generating a new desktop identity. Isolated verification
can set a nonempty `WEGENT_APP_IPC_DEVICE_ID` as the effective ID before file reads
or hardware lookup, without overwriting the normal file.

## Automatic Cleanup and Retention

Wework runs storage maintenance in the background immediately after launch and
then every 30 minutes. Maintenance only processes temporary data that Wework
explicitly owns. It does not age-delete user projects or managed worktrees that
may still need recovery:

- `app-runtime/wework-<pid>-<timestamp>/`: an isolated Executor instance is
  deleted after 14 days only when it is inactive. An instance holding
  `.instance.lock` is always preserved. For legacy lockless directories, Wework
  also checks the PID embedded in the directory name before deletion. Legacy
  `wework-dev-*` directories follow the same rules.
- Files older than 14 days under `logs/`, and files older than 24 hours in
  feedback staging or the built-in browser temporary directory, are removed in
  batches. Current-process logs and symbolic links are preserved.
- Stale `marketplace-add-*` and `marketplace-upgrade-*` directories older than
  7 days are removed from `codex/.tmp/marketplaces/.staging/`. This covers both
  `~/.wework/codex` and `~/.wework/apps/<namespace>/codex` without deleting
  installed marketplaces.

`workspace/worktrees/` contains task data rather than disposable cache. Its
lifecycle is driven by archived tasks and the Worktree retention settings, with
a Git snapshot saved before deletion. The storage maintenance thread does not
delete these directories directly.

## Isolating startup reads from writes

Opening an initialized `data/tasks.sqlite` checks the current schema, history tables/indexes and default task project
without waiting for the task-store initialization mutex or resetting WAL mode. First creation,
schema migration, history-structure repair and default-project repair remain serialized when they modify data.

UI assistant settings use one read-only WAL snapshot, normalizing legacy values and binding
the current device in memory. Execution-owned reconciliation reserves a writer only for actual
legacy migrations or device rebinding and re-reads transactionally. Explicit saves retain version,
permission and device validation. Legacy roles have stable identities across views and migration.
Refreshing an existing code project reads its existence and archive state without filling in
execution metadata; importing a new project remains a write. Reading the model picker does not
write custom catalogs, synchronize creation profiles or wait for a Codex restart. Execution
preparation still reconciles catalogs before using a model. Enabled custom models remain
selectable while catalog reconciliation is pending.

Electron singleton protection, coherent file snapshots, connection mutexes and actual write
transactions continue to guard their owning operations. They must not be bypassed to claim
readiness. The desktop `startup-fault-isolation` checkpoint additionally reloads the workbench
while a real database write transaction remains open, checks project, task and assistant reads,
and verifies saving after release. It never modifies a personal database.

Task updates publish their index state before recording telemetry outside the index lock, using timestamps captured when transitions are queued. SQLite waits cannot hold the task-list index mutex. Telemetry reads filter retention and queue limits in SQL; append and configuration writes own cleanup.

Native quota account checks run outside the task send gate; state publication reacquires it and checks execution ownership, so cancellation does not wait for account reads.

After the workbench mounts, its local runtime initializer prepares execution recovery and default plugins in the background. UI reads do not wait for this phase; failures use the existing runtime notice and retry action.

Telemetry policy persists each user’s collection cutoff and rejects older queued observations within the write transaction. Additional policy storage initializes only on writes; reads create no tables. Terminal task state is published before releasing its execution claim, and telemetry persistence holds no execution-control mutex.

Asynchronous capacity release checks native execution ownership, so question or Goal metadata updates cannot retain a completed turn's worker slot.
