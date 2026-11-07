---
sidebar_position: 22
---

# Local Data Directory

Wework stores its local runtime data under `~/.wework` in the user's home
directory. The legacy `~/.wecode/wegent-executor` and `~/.wegent-executor`
locations are no longer used.

## Directory Layout

The default Executor Home is `~/.wework` and contains:

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

The Electron host derives its `electron-<hash>` device ID from the SHA-256 hash
of the hardware UUID and application identifier (default `io.wecode.wework`).
The same machine and application retain their ID across restarts, reinstalls,
different user Homes or data directories, and deletion of `desktop-device-id`.
Different hardware or application identifiers produce different IDs. The raw
hardware UUID is neither sent as the device ID nor written to identity files or logs.

The managed Executor uses this ID for local IPC and cloud `app_device_id`,
`device-<app_device_id>` for cloud `device_id`, and `runtime-<app_device_id>`
for `runtime_instance_id`, preserving their distinct routing responsibilities.
The host supplies these values over the existing environment interface,
overriding legacy random configuration identities. Changing Executor Home
therefore retains the same cloud device. Account permissions, session tokens
and record-scoped routes remain controlled by the existing authentication and
registration protocol; a hardware hash does not grant authority.

The user-data directory's `desktop-device-id` only records the computed result;
it is not an identity source, and old worktree records are not used to infer one.
Legacy random IDs are replaced when the new rule first runs. Startup fails when
a valid hardware UUID is unavailable instead of generating a random replacement.
Isolated verification can still explicitly set `WEGENT_APP_IPC_DEVICE_ID` without
overwriting the regular identity file. Changing only the data directory no longer
simulates a different machine.

## Directory Scanning During Home Migration

When moving a legacy Codex Home into the workbench directory, relative symlink
scanning uses the entry types supplied by directory enumeration. It recurses
into directories and validates symlinks without separately reading regular-file
metadata. A background Git operation removing a temporary lock file after
enumeration therefore does not block startup. Unresolvable relative symlinks
still block migration.

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
