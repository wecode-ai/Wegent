---
sidebar_position: 39
---

# Device artifact prompt migration: human approval and rollback

`a9c4e7b2d610` is a data-only migration. It replaces recognized legacy delivery instructions in the public built-in Ghost with artifact declaration instructions. It does not upload file contents or execute DDL. **A merged PR, passing CI, or a successful local migration is not production approval.**

## Production approval gate

Do not run a production `alembic upgrade head` containing this revision, or execute it indirectly through startup migrations, before human review. The deployment owner must disable `DB_AUTO_MIGRATE` for that deployment until preflight, backup and approval are complete. An authorized writer then executes the approved migration. A test report or a general request to fix review feedback cannot replace production approval.

The migration selects only rows matching every condition:

| Field | Condition |
| --- | --- |
| `user_id` | `0` |
| `kind` | `Ghost` |
| `namespace` | `default` |
| `name` | `wegent-wework` |
| `is_active` | True |
| `json.spec.systemPrompt` | Both known legacy blocks occur exactly once |

It never overwrites a fixed database ID. Customized, incomplete or repeated blocks remain unchanged. IDs, skills, MCP servers, labels and other configuration are preserved. Never replace the entire Ghost to increase the match count.

## Read-only preflight and approval evidence

Supply the target read-only `DATABASE_URL` through environment configuration, not command-line passwords, logs or Git files. From the repository root:

```bash
cd backend
uv run scripts/preflight_wework_file_delivery.py
```

The script only issues `SELECT`. It does not start the app, run migrations, or print prompts or connection strings. It reports candidate IDs, active states, classifications, SHA-256 fingerprints and an inventory fingerprint:

- `legacy_exact`: an active row is an upgrade candidate.
- `migrated_exact`: marked blocks recognized by this revision's downgrade.
- `current_seed`: fresh-install rules without a migration marker; downgrade leaves them intact.
- `custom_or_unrecognized`: requires human inspection and is not automatically updated.

Approval evidence must identify the environment, current Alembic revision, all candidate IDs/fingerprints, expected update count, operator, change window, backup location and rollback criteria. Zero matches do not prove legacy settings are corrected. Investigate duplicate active identities before proceeding. **The operator and reviewer must confirm actual production results, not unit-test fixtures.**

## Upgrade and concurrent configuration changes

1. Pause edits to this public Ghost during the change window. Back up the target rows and current revision to approved storage. Backups can contain business prompts and must never enter Git.
2. Repeat the read-only inventory and compare it with approved IDs, fingerprints and counts. Stop and obtain renewed review for any difference.
3. Use an authorized writer to execute this exact revision without unrelated unapproved migrations:

   ```bash
   uv run alembic upgrade a9c4e7b2d610
   ```

4. The update rechecks identity, active state and the **entire original JSON**. Any concurrent edit, rename, ownership change, deactivation or JSON update makes the conditional update affect zero rows. The migration raises an error and rolls back its transaction. Do not remove that comparison or repeatedly retry to overwrite an edit.
5. Verify the revision and inventory, confirm only expected legacy rules became `migrated_exact`, and compare non-target settings against the backup. Use an independent task to verify generation, declaration, completion event, card rendering and download.

Customized rules require a separately approved configuration change.

## Rollback

The predecessor is `f3a7c9e1b2d4`. Only after rollback approval, while the environment is still on `a9c4e7b2d610` and no later revision must be retained:

```bash
uv run scripts/preflight_wework_file_delivery.py
uv run alembic downgrade f3a7c9e1b2d4
uv run scripts/preflight_wework_file_delivery.py
```

Downgrade restores only marked blocks whose two replacement sections remain unchanged. Fresh-install instructions and subsequently customized sections remain untouched; concurrent changes fail the same comparison. Customized sections may remain after downgrade, so an Alembic revision alone does not prove prompt restoration. Compare the controlled backup and obtain separate approval for manual recovery instead of force-overwriting configuration.

This procedure deletes no task files, artifact contexts, tasks or devices. It performs no DDL and changes no collaboration permission invariants.
