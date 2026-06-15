---
sidebar_position: 19
---

# Sandbox Workspace Archive

Sandbox workspace archive preserves file state before a Sandbox runtime is deleted by the 24-hour idle cleanup, then restores those files when the same Task creates a new Sandbox runtime during a later conversation. The feature reuses the existing executor Pod workspace archive pipeline. Executor and sandbox archives both use `home/` and `workspace/` roots, with `runtime_type` selecting the runtime-specific home path.

## Scope

This feature covers Sandbox runtime lifecycle recovery:

- When a Sandbox is idle past the cleanup threshold, Executor Manager asks Backend to archive it before deletion.
- When the user continues the same Task later, Executor Manager creates a new Sandbox and asks Backend to restore the archive.
- Archive or restore failures do not block Sandbox deletion or creation; they are logged as warnings.

Regular executor Pods continue to use the code task recovery flow. Calls that omit `runtime_type` use the default executor behavior.

## Architecture

Archive flow:

1. `SandboxManager.cleanup_stale_sandboxes()` finds an expired Sandbox.
2. Executor Manager calls Backend internal API `POST /api/internal/workspace-archives/{task_id}/archive-sandbox`.
3. Backend `ArchiveService` generates a presigned object-storage upload URL and calls Executor Manager `/executor/archive`.
4. Executor Manager forwards `runtime_type=sandbox` to the target executor envd `/api/archive`.
5. envd packages Sandbox files and uploads the archive to object storage.
6. Backend stores archive metadata in `Task.status.archive`.
7. Executor Manager deletes the Sandbox.

Restore flow:

1. A later conversation needs a Sandbox, so Executor Manager creates one.
2. After the new Sandbox starts, Executor Manager calls Backend internal API `POST /api/internal/workspace-archives/{task_id}/restore-sandbox`.
3. Backend checks that `Task.status.archive` exists, has not expired, and the object still exists.
4. Backend generates a presigned download URL and calls Executor Manager `/executor/restore`.
5. Executor Manager forwards `runtime_type=sandbox` to the new Sandbox envd `/api/restore`.
6. envd downloads the archive and restores it into the Sandbox filesystem.

## Path Strategy

executor Pods and Sandbox runtimes use the same executor/envd code. The archive format is unified as `home/` and `workspace/` roots, while envd selects the runtime home path by `runtime_type`:

| runtime_type | Archived paths | Archive roots | Notes |
| --- | --- | --- | --- |
| `executor` | Claude config under `$HOME` and `/workspace/{task_id}` | `home/`, `workspace/` | Default value; only keeps `.claude/` and `.claude.json` to avoid archiving credentials and runtime mounts |
| `sandbox` | `/home/user` and `/workspace/{task_id}` | `home/`, `workspace/` | Covers the Sandbox working directory and compatibility workspace path |

Archives exclude common large directories and caches, including:

- `node_modules`
- `.venv`, `venv`
- `__pycache__`
- `.cache`
- `.npm`
- `.pnpm-store`
- `.yarn`
- `build`, `dist`, `target`
- `*.log`

During restore, `workspace/*` is written back to `/workspace/{task_id}`. `home/*` is written back to `$HOME` for executor runtimes and `/home/user` for sandbox runtimes.

Executor home restore uses the same allowlist. If an old archive contains `.ssh/`, `.npmrc`, `.config/`, `.local/`, `.gvm/`, or code-server runtime directories, envd skips those members to avoid restoring credentials or writing into Kubernetes read-only mounts.

## Failure Handling

Sandbox archive and restore are best effort:

- Archive fails before deletion: log a warning and continue deleting the Sandbox to avoid idle resource buildup.
- Restore fails after creation: log a warning and keep the new Sandbox available for the conversation.
- Sandbox has no `task_id`: skip archive and restore.
- Archive is expired or missing from storage: Backend reports restore failure, and Executor Manager does not block Sandbox creation.

## Admin Cleanup API

In addition to full stale cleanup, administrators can clean up one Sandbox runtime by Task without scanning every Sandbox:

```bash
curl -X POST http://localhost:8000/api/admin/runtime-cleanup/sandbox \
  -H 'Content-Type: application/json' \
  -d '{"task_id": 1973, "dry_run": false, "archive_before_delete": true}'
```

Backend forwards the request to Executor Manager:

```bash
curl -X POST http://localhost:8001/executor-manager/sandboxes/cleanup-by-task \
  -H 'Content-Type: application/json' \
  -d '{"task_id": 1973, "dry_run": false, "archive_before_delete": true}'
```

The cleanup first deletes by the container name stored in Redis. If that name is stale or no longer matches a live container, it falls back to deleting Sandbox containers by their `task_id` label, then clears the Sandbox metadata from Redis.

## Stale Cache Handling

The Chat Shell Sandbox client revalidates a cached `sandbox_id` with Executor Manager before reuse. If the cached Sandbox was deleted, returns 404, or is not `running`, the client clears the cache and creates a new Sandbox.

If the Sandbox is deleted between validation and execution start, `execute` clears the cache, creates a new Sandbox, and retries once when it sees 404 or not found. The retry is limited to one attempt to avoid loops during infrastructure failures.

## Concurrent Recreation Handling

Executor Manager serializes Sandbox recreation per `task_id`. The first request starts the container and completes archive restore before releasing the lock. Concurrent requests then re-check state inside the lock and reuse the already `running` Sandbox. This prevents two containers from being created for one Task and avoids routing execution to a failed or not-yet-restored instance.

## Local Verification

Run unit tests:

```bash
cd executor
uv run pytest tests/test_envd_workspace_archive.py

cd ../executor_manager
uv run pytest tests/services/test_sandbox_manager.py tests/routers/test_sandbox_cleanup_routes.py tests/routers/test_workspace_archive_routes.py -q

cd ../backend
uv run pytest tests/api/endpoints/internal/test_workspace_archives_api.py tests/api/endpoints/test_admin_runtime_cleanup_api.py -q

cd ../chat_shell
uv run pytest tests/test_sandbox_client.py
```

For a manual check, write files under both `/home/user` and `/workspace/{task_id}` inside a Sandbox, trigger stale cleanup, then continue the same Task conversation and confirm both paths are restored in the new Sandbox.
