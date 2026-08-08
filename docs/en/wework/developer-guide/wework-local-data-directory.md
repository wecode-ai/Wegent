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
- `capabilities/store/plugins/`: the single authoritative package store for marketplace-managed Plugins.
- `capabilities/bundled-marketplaces/`: bundled plugin marketplace cache.
- `capabilities/plugin-state/`: persistent identity links between local Plugins and their published cloud records.
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
  existing files in `~/.wework` win for ordinary data.
- Conflicting legacy entries are archived under
  `~/.wework/.legacy-migration-conflicts/<source>/` instead of being overwritten.
- A legacy `capabilities/store/plugins` package still referenced by the manifest is not
  archived prematurely. The Executor copies the referenced package into
  `~/.wework/capabilities/store/plugins`, atomically rewrites the Plugin
  `store_path`, and removes the old package only after the manifest update succeeds.
- If the legacy home was already moved, the Executor rewrites the manifest after
  confirming that the package exists in the new Plugin Store.
- Plugin migration is idempotent. A failed upgrade does not first delete a Plugin
  package that the manifest still uses. Skills and MCP servers do not participate
  in this migration.

New Wework versions write managed Plugin packages only to
`~/.wework/capabilities/store/plugins`. Temporarily downgrading to an older
version that still uses `~/.wegent-executor` can recreate the legacy directory.
Starting the new version again converges it with the rules above; both directories
are never treated as authoritative Plugin Stores at the same time.
