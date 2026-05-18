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
  "inactive_hours": 24,
  "targets": ["task_executors", "sandboxes"],
  "dry_run": false
}
```

Fields:

| Field | Description | Default |
|-------|-------------|---------|
| `inactive_hours` | Minimum inactive hours before deletion is allowed | `24` |
| `targets` | Cleanup targets: `task_executors`, `sandboxes` | both |
| `dry_run` | Return the planned result without deleting runtimes | `false` |

## Rules

`task_executors` cleans up Wegent task executor Pods:

- Uses the latest Task and Subtask update time to decide whether the executor is stale.
- If the executor is newer than `inactive_hours`, it is not deleted and returns `reason: "not_stale"`.
- Tasks with `preserveExecutor=true` are not deleted.
- Device executors are not deleted by this endpoint.
- Successful deletion marks related Subtasks with `executor_deleted_at=true`.

`sandboxes` cleans up sandbox Pods:

- Uses the sandbox `last_activity_at` timestamp to decide whether it is stale.
- If the sandbox is newer than `inactive_hours`, it is not deleted and returns `reason: "not_stale"`.
- Deletion is performed by Executor Manager.

## Response Example

```json
{
  "inactive_hours": 24,
  "dry_run": false,
  "results": {
    "task_executors": {
      "target": "task_executors",
      "deleted": [],
      "skipped": [
        {
          "task_id": 123,
          "executor_name": "executor-recent",
          "executor_namespace": "default",
          "reason": "not_stale",
          "last_updated_at": "2026-05-18T10:30:00",
          "eligible_after": "2026-05-19T10:30:00"
        }
      ],
      "failed": []
    }
  }
}
