---
sidebar_position: 1
---

# Executor Attachment Sync

## Context

Task attachments are currently discovered in backend context processing, passed
through shared request conversion and executor_manager, then downloaded by the
executor during agent preparation. Task 72 showed that attachment metadata can be
lost during format conversion before the executor sees it. The same chain also
lets backend inject a guessed sandbox path that can be wrong for coding Docker
project workspaces.

The new design adds an explicit attachment preparation phase before formal task
execution. Backend still decides which attachments belong to the task, but
executor owns the real download location and returns the prepared local paths.

## Goals

- Download task attachments before formal agent execution.
- Keep executor as the only component that decides attachment local paths.
- Route backend requests through executor_manager, not directly to Docker
  containers.
- Allow partial success: successful attachments remain available and failed
  attachments are surfaced to the agent as unavailable.
- Keep the formal execution path compatible with existing task dispatch.

## Non-Goals

- Do not move binary attachment bytes through executor_manager.
- Do not make executor_manager understand prompt rewriting rules.
- Do not introduce a prepared-task cache or new long-lived task state machine.
- Do not remove the old execution-stage download path in the first iteration.

## Architecture

Backend performs normal request construction and context processing. If the
request has attachments and targets an executor runtime that can consume local
files, backend calls executor_manager to synchronize attachments.

Executor_manager resolves or creates the target executor using existing lifecycle
logic, then forwards the sync request to the executor. The executor downloads
attachments from backend using `auth_token` and `backend_url`, writes files under
its own workspace layout, and returns per-attachment results.

Backend merges the returned results into `ExecutionRequest.attachments` and
sends the formal task through the existing executor_manager task API. During
formal execution, agent preparation consumes `local_path` results instead of
downloading again. Failed attachments are appended to the prompt as unavailable.

## APIs

Backend calls executor_manager:

```http
POST /executor-manager/tasks/{task_id}/attachments/sync
```

Request fields:

- `task_id`
- `subtask_id`
- `user_subtask_id`
- `executor_name`
- `executor_namespace`
- `executor_type`
- `auth_token`
- `backend_url`
- `workspace`
- `project_id`
- `project_workspace_path`
- `git_url`
- `attachments`

Executor_manager forwards to executor:

```http
POST /v1/attachments/sync
```

The executor response is:

```json
{
  "task_id": 72,
  "subtask_id": 204,
  "attachments": [
    {
      "id": 16,
      "status": "success",
      "original_filename": "frontend.zip",
      "local_path": "/workspace/projects/demo/.wegent/attachments/72/203/frontend.zip",
      "mime_type": "application/zip",
      "file_size": 12345,
      "subtask_id": 203
    },
    {
      "id": 17,
      "status": "failed",
      "original_filename": "broken.pdf",
      "error": "HTTP 404",
      "mime_type": "application/pdf",
      "file_size": 456,
      "subtask_id": 203
    }
  ],
  "success_count": 1,
  "failed_count": 1
}
```

Formal `ExecutionRequest.attachments` uses this enriched shape.

## Execution Flow

1. Backend builds `ExecutionRequest`.
2. Backend processes contexts and collects attachment payloads.
3. Backend calls executor_manager attachment sync when attachments exist.
4. Executor_manager ensures a target executor is available.
5. Executor_manager calls executor `/v1/attachments/sync`.
6. Executor downloads each attachment from backend
   `/api/attachments/{id}/executor-download`.
7. Executor writes files to the runtime-specific attachment directory.
8. Executor returns per-attachment sync results.
9. Backend merges results into `request.attachments`.
10. Backend sends the formal task through the existing task dispatch path.
11. Executor formal execution consumes `local_path` or failure status.

## Prompt And Path Handling

Backend should not claim that a guessed path is already in the sandbox for
executor-backed coding flows. The authoritative path is the executor sync
`local_path`.

Formal execution should:

- Replace old attachment path hints with `Local File Path: <local_path>` for
  successful attachments.
- Add an unavailable warning for failed attachments.
- Avoid re-downloading attachments when `status=success` and `local_path` are
  present.
- Preserve the existing execution-stage download behavior only for legacy
  payloads without sync status.

## Error Handling

The sync API is partial-success by design.

- Missing `auth_token` or `backend_url` marks each attachment as failed.
- Per-file HTTP, timeout, or filesystem errors mark only that attachment failed.
- If executor_manager cannot create or reach the executor, backend treats sync as
  failed for all attachments and can still continue formal execution with failure
  annotations.
- Sync responses must not log tokens or attachment file contents.

## Testing

Backend tests should cover:

- Context processing calls attachment sync before formal dispatch.
- Sync results are merged into `ExecutionRequest.attachments`.
- Partial failures continue formal dispatch.
- OpenAI request conversion preserves enriched attachments.

Executor_manager tests should cover:

- Sync endpoint resolves or creates the target executor.
- Sync endpoint forwards payload to `/v1/attachments/sync`.
- Container lookup failures return structured failed attachment results.

Executor tests should cover:

- `/v1/attachments/sync` downloads successful attachments to the expected
  project and non-project layouts.
- Failed downloads return per-attachment errors.
- Formal execution consumes existing `local_path` without downloading again.
- Prompt rewriting uses `Local File Path` for prepared attachments.

## Rollout

First iteration keeps the old execution-stage download path as compatibility for
requests that do not contain enriched attachment sync results. Once logs show the
sync path is stable, the legacy path can be simplified or removed in a separate
cleanup.
