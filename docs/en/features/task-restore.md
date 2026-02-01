# Task Restoration Feature

## Overview

This document describes the Task Restoration feature that allows users to continue conversations on expired tasks or tasks whose executor containers have been cleaned up.

## Problem Statement

In Wegent, tasks use Docker containers (executors) to process AI conversations. These containers have a lifecycle:

1. **Expiration**: Chat tasks expire after 2 hours, Code tasks after 24 hours of inactivity
2. **Container Cleanup**: Expired task containers are automatically removed to free resources
3. **Issue**: When users try to send a message to an expired/cleaned-up task, they would encounter a "Container not found" error

## Solution

The Task Restoration feature provides a graceful recovery mechanism:

1. When a user sends a message to an expired or container-deleted task, the backend returns HTTP 409 with `TASK_EXPIRED_RESTORABLE` code
2. Frontend displays a restore dialog giving the user options to:
   - **Continue Chat**: Restore the task and resend the message
   - **New Chat**: Create a new task instead
3. If user chooses to continue, the restore API resets the task state and allows a new container to be created

## Technical Implementation

### Backend Changes

#### 1. Executor Deletion Detection (`executor_kinds.py`)

When executor_manager reports a "container not found" error, the subtask is marked with `executor_deleted_at=True`:

```python
# Mark executor as deleted when container not found error is reported
if subtask_update.status == SubtaskStatus.FAILED and subtask_update.error_message:
    error_msg = subtask_update.error_message.lower()
    if "container" in error_msg and "not found" in error_msg:
        subtask.executor_deleted_at = True
```

#### 2. Pre-append Check (`operations.py`)

Before allowing a message to be appended to an existing task, check for:
- `executor_deleted_at` flag on the last assistant subtask
- Task expiration time

If either condition is met, return HTTP 409:

```python
if last_assistant_subtask and last_assistant_subtask.executor_deleted_at:
    raise HTTPException(
        status_code=409,
        detail={
            "code": "TASK_EXPIRED_RESTORABLE",
            "task_id": existing_task.id,
            "task_type": task_type,
            ...
        },
    )
```

#### 3. Restore API (`task_restore.py`)

New endpoint `POST /tasks/{task_id}/restore` that:
1. Validates task exists and user has access
2. Resets `updated_at` timestamp
3. Clears `executor_deleted_at` flags
4. Clears `executor_name` from all assistant subtasks (forces new container creation)

```python
# Reset executor_deleted_at for flagged subtasks
db.query(Subtask).filter(
    Subtask.task_id == task_id,
    Subtask.executor_deleted_at.is_(True),
).update({Subtask.executor_deleted_at: False})

# Clear executor_name for ALL assistant subtasks
# This prevents inheritance of old container names
db.query(Subtask).filter(
    Subtask.task_id == task_id,
    Subtask.role == SubtaskRole.ASSISTANT,
    Subtask.executor_name.isnot(None),
    Subtask.executor_name != "",
).update({Subtask.executor_name: ""})
```

#### 4. Executor Name Inheritance Fix (`helpers.py`)

Fixed a bug in `_create_standard_subtask` where `executor_name` was blindly inherited from the first existing subtask without checking:
- If the subtask is an ASSISTANT role (USER subtasks have empty executor_name)
- If the executor_name is non-empty

Before (buggy):
```python
if existing_subtasks:
    executor_name = existing_subtasks[0].executor_name
```

After (fixed):
```python
for s in existing_subtasks:
    if s.role == SubtaskRole.ASSISTANT and s.executor_name:
        executor_name = s.executor_name
        break
```

### Frontend Changes

#### 1. Error Parser (`errorParser.ts`)

Added parsing for `TASK_EXPIRED_RESTORABLE` error code from HTTP 409 responses.

#### 2. Restore Dialog (`TaskRestoreDialog.tsx`)

New dialog component that displays:
- Expiration information (task type, hours expired)
- Option to continue chat (calls restore API then resends message)
- Option to start new chat

#### 3. Stream Handlers (`useChatStreamHandlers.tsx`)

- Added state for restore dialog visibility
- Added `handleConfirmRestore` handler that:
  1. Calls restore API
  2. Refreshes task detail
  3. Resends the pending message

### API Changes

#### New Endpoint

```
POST /api/v1/tasks/{task_id}/restore
```

**Request Body:**
```json
{
  "message": "optional message to send after restoration"
}
```

**Response:**
```json
{
  "success": true,
  "task_id": 123,
  "task_type": "chat",
  "executor_rebuilt": true,
  "message": "Task restored successfully"
}
```

## Flow Diagram

```
User sends message to expired task
         │
         ▼
Backend checks expiration/executor_deleted_at
         │
         ▼
    ┌────┴────┐
    │ Expired │ ──Yes──► Return HTTP 409
    │   or    │          with TASK_EXPIRED_RESTORABLE
    │ Deleted │
    └────┬────┘
         │No
         ▼
   Continue normally

Frontend receives HTTP 409
         │
         ▼
   Show Restore Dialog
         │
    ┌────┴────┐
    │Continue │ ──Yes──► Call POST /tasks/{id}/restore
    │  Chat?  │                    │
    └────┬────┘                    ▼
         │No              Clear executor data
         ▼                Reset timestamps
   Create new task               │
                                 ▼
                          Resend message
                                 │
                                 ▼
                          New container created
```

## Files Changed

| File | Changes |
|------|---------|
| `backend/app/api/api.py` | Register task_restore router |
| `backend/app/api/endpoints/adapter/task_restore.py` | New restore API endpoint |
| `backend/app/services/adapters/task_restore.py` | New restore service |
| `backend/app/services/adapters/executor_kinds.py` | Mark executor_deleted_at on error, inherit executor_name |
| `backend/app/services/adapters/task_kinds/operations.py` | Check executor_deleted_at before append |
| `backend/app/services/adapters/task_kinds/helpers.py` | Fix executor_name inheritance bug |
| `frontend/src/apis/tasks.ts` | Add restoreTask API |
| `frontend/src/utils/errorParser.ts` | Parse TASK_EXPIRED_RESTORABLE error |
| `frontend/src/features/tasks/components/chat/TaskRestoreDialog.tsx` | New restore dialog |
| `frontend/src/features/tasks/components/chat/useChatStreamHandlers.tsx` | Handle restore flow |
| `frontend/src/i18n/locales/*/chat.json` | Add i18n translations |

## Configuration

The expiration times are controlled by environment variables:

- `APPEND_CHAT_TASK_EXPIRE_HOURS`: Hours before chat task expires (default: 2)
- `APPEND_CODE_TASK_EXPIRE_HOURS`: Hours before code task expires (default: 24)
