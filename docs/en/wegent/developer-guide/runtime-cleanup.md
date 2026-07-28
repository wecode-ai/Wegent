---
sidebar_position: 17
---

# Runtime Cleanup

Runtime cleanup manually removes execution environments that have not been updated for a configured period. It only deletes runtime Pods or containers. It does not delete Backend Task records or message history.

## API

```http
POST /api/admin/runtime-cleanup/stale
```

This endpoint is admin-only.

Request body:

```json
{
  "task_id": 123,
  "inactive_hours": 24,
  "dry_run": false,
  "archive_before_delete": true
}
```

This endpoint only cleans up the runtime for one Task ID. It does not provide full cleanup.

When calling with `curl`, set the JSON Content-Type:

```bash
curl "https://<host>/api/admin/runtime-cleanup/stale" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"task_id":123,"inactive_hours":24,"dry_run":false,"archive_before_delete":true}'
```

Fields:

| Field | Description | Default |
|-------|-------------|---------|
| `task_id` | Task ID whose runtime should be cleaned up. Required. | - |
| `inactive_hours` | Minimum inactive hours before deletion is allowed | `24` |
| `dry_run` | Return the planned result without deleting runtimes | `false` |
| `archive_before_delete` | Archive the sandbox workspace before deleting it | `true` |

## Rules

The endpoint only processes the specified task:

- If a sandbox with the same ID exists, the sandbox `last_activity_at` timestamp decides whether it is stale.
- If no sandbox exists, the Task/Subtask update timestamps decide whether the task executor is stale.
- If the runtime is newer than `inactive_hours`, it is not deleted and returns `reason: "not_stale"`.
- Tasks with `preserveExecutor=true` are not deleted.
- Device executors are not deleted by this endpoint.
- Successful executor deletion marks related Subtasks with `executor_deleted_at=true`.
- Sandbox deletion is performed by Executor Manager and archives the workspace first by default.

## Response Example

```json
{
  "task_id": 123,
  "inactive_hours": 24,
  "dry_run": false,
  "archive_before_delete": true,
  "results": {
    "task_executor": {
      "task_id": 123,
      "deleted": false,
      "skipped": true,
      "reason": "not_stale",
      "executors": [],
      "last_updated_at": "2026-05-18T10:30:00",
      "eligible_after": "2026-05-19T10:30:00"
    }
  }
}
