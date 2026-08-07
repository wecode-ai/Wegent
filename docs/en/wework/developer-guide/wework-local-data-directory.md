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
Home. When it is set explicitly, Wework does not run the default-directory
migration, which keeps isolated sessions, tests, and custom deployments intact.

## Legacy Directory Migration

On the first start with the default directory, Wework automatically migrates
legacy data into `~/.wework`:

1. `~/.wegent-executor` is migrated first.
2. The older `~/.wecode/wegent-executor` is merged afterwards.

Migration rules:

- When `~/.wework` does not exist, the legacy directory is renamed as a whole,
  preserving file attributes, directory structure, and symbolic links.
- When both directories exist, non-conflicting content is merged recursively;
  files already in `~/.wework` always win.
- Conflicting legacy entries are archived under
  `~/.wework/.legacy-migration-conflicts/<source>/` instead of being overwritten.
- After migration, the legacy directory is removed and old paths are never read
  at runtime.
