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
