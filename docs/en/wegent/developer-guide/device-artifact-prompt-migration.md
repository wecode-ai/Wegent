---
sidebar_position: 39
---

# Device artifact rules: withdrawn data migration and retained revision history

The automatic prompt update for the public `Ghost/default/wegent-wework` is withdrawn. Artifact delivery does not require rewriting production Ghost configuration or restoring administrator settings through a migration.

## Retained delivery instructions

- Default YAML keeps the updated declaration instructions and only creates missing resources.
- Claude Code (with tools enabled) and Codex inject declaration instructions at execution time. Existing Ghost prompts may remain unchanged.
- Files remain on the execution device. Declarations persist metadata; completed messages display artifact cards that download from the original source.
- Do not run the former prompt preflight or replacement scripts. The obsolete preflight script is removed.

Web completion events and recovery snapshots both update artifact contexts on the corresponding assistant message. Omitted contexts preserve known values; an explicit empty list clears them. Files completed while the browser is offline also appear after recovery in the same document without reloading.

## Execution workspace authorization

Before starting Claude Code or Codex, the executor captures the prepared native cwd in an immutable Task/turn workspace binding in its own state directory. A SHA-256 fingerprint of the Task Token distinguishes execution contexts; the raw token is never persisted.

Declaration resolves the canonical workspace through the original executor's authenticated channel, rejects a different requested `workspace_root`, and persists only that verified source. Device RPC and HTTP downloads revalidate the original binding, Task/turn, and captured root before applying the existing symlink and size checks. Reassigning a Task never redirects its artifact reads to another executor.

A resumed execution may refresh its credentials through a new verified native binding, but the executor, namespace, and canonical root must match the original declaration. Credential refresh cannot change the artifact's physical source.

Upgrade Backend and executors together. Older declarations without a binding fail explicitly and must be regenerated and declared in a new upgraded execution turn. Their stored root is never accepted as authorization, and no data migration backfills bindings.

## Why retain a no-op revision

An earlier PR version published `a9c4e7b2d610`. Local or test databases may already have executed it or been stamped to it during fresh initialization. Deleting that revision would cause `Can't locate revision identified by 'a9c4e7b2d610'` in those environments.

Keep the revision ID and predecessor `f3a7c9e1b2d4`, but make both `upgrade()` and `downgrade()` no-ops. Neither obtains a connection, reads or writes application tables, nor executes DDL. Crossing the node only updates Alembic's version tracking. The original automatic data migration is not retained.

| Existing state | Behavior after this update |
| --- | --- |
| Still on the predecessor | Crossing the no-op node advances version tracking without changing the legacy Ghost. |
| Already recorded at `a9c4e7b2d610` | History remains resolvable; no stamp, reset, or version-record deletion is required. |
| Prompt changed by an earlier migration | The current prompt is preserved, not automatically reversed or restored. |
| Administrator-customized Ghost | Configuration remains unchanged. |

## Inspection and rollback boundaries

The environment owner can inspect revisions using an approved connection. Never put credentials in commands or logs:

```bash
cd backend
uv run alembic current
uv run alembic heads
uv run alembic history -r f3a7c9e1b2d4:a9c4e7b2d610
```

These commands inspect revision state; they do not replace prompts. This code fix does not connect to or modify production and does not require a production upgrade, downgrade, or stamp.

Before reverting to older code that lacks this revision, plan version compatibility separately. Do not delete `alembic_version` or blindly stamp head. The retained no-op downgrade only changes version tracking; **it does not undo prompts changed by earlier PR code**. Restoring business configuration requires separate approval and comparison with a controlled backup.

Isolated database regressions cover upgrades and downgrades from the predecessor and already-recorded revision, preserving legacy, migrated, customized, and fresh configuration. Web E2E uses a legacy Ghost prompt with Claude Code and Codex to verify runtime instructions, real declarations, immediate cards, and downloads without modifying public built-in resources.
