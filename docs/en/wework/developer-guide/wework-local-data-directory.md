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

Managed desktop and standalone Executors both prefer persisted identities and
generate new ones only when missing.

The Electron host first reads `desktop-device-id`, preserving IDs saved by older
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
and does not infer identity from old worktree records. Empty or unreadable identity
files fail startup rather than silently replacing an identity. A valid hardware
UUID is required only when generating a new desktop identity. Isolated verification
can explicitly set `WEGENT_APP_IPC_DEVICE_ID` without overwriting the normal file.

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
