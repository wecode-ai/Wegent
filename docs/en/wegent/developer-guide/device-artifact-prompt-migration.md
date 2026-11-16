---
sidebar_position: 39
---

# Device artifact instructions: withdrawn migration and revision compatibility

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

## No migration revision retained

This feature removes `a9c4e7b2d610`, including its no-op replacement. The migration chain currently ends at `f3a7c9e1b2d4`; the feature adds no Alembic node and does not automatically update version records.

| Existing state                          | Behavior after updating the code                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| At the predecessor revision             | The existing version remains recognizable; legacy Ghosts are unchanged.                                                            |
| Already recorded at `a9c4e7b2d610`      | Alembic explicitly rejects the missing revision; deployment requires a separate compatibility plan first.                          |
| An earlier migration changed the prompt | Business configuration is not automatically restored. Version compatibility and configuration restoration are separate operations. |
| An administrator customized the Ghost   | Configuration remains unchanged.                                                                                                   |

## Deployment boundary for environments at the withdrawn version

The environment owner must first inspect its version and migration implementation using the currently deployed code that still recognizes the revision and an approved connection. Never put connection passwords in commands or logs:

```bash
cd backend
uv run alembic current
uv run alembic heads
```

If the environment records `a9c4e7b2d610`, do not deploy code that deletes the node and then run migrations. Plan and approve its version compatibility steps first. Commit `aaa7da6f973605fbd6913fcddf5f41270ca57725` contains the no-op implementation. **Only after verifying that the code in use contains that no-op implementation** does downgrading to `f3a7c9e1b2d4` change version tracking alone, without modifying Ghosts. The earlier automatic data migration does not have this rollback boundary; do not execute its downgrade directly.

This PR performs none of those environment operations and adds no automatic stamping, revision remapping, or configuration replacement. Do not delete the version table or blindly `stamp head`. This repair does not connect to or modify production databases.

Neither deleting the revision nor resolving version compatibility restores Ghosts changed by the earlier migration. Restoring business configuration requires separate authorization and a controlled, individually verified backup.

Regression tests use connection-local temporary tables to cover the recognizable predecessor, explicit rejection of an already-recorded withdrawn revision without altering its version record, and preservation of legacy, previously migrated, customized, and fresh prompts. Web E2E verifies runtime injection, real declaration, immediate cards, and downloads with legacy Ghost instructions for Claude Code and Codex without rewriting public built-in resources.
