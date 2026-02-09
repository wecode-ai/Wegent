# Task Restoration Feature

## Overview

The Task Restoration feature allows users to continue conversations on expired tasks or tasks whose executor containers have been cleaned up, while preserving full conversation context.

## Problem Background

In Wegent, tasks use Docker containers (executors) to process AI conversations. These containers have lifecycle limits:

| Task Type | Expiration | Scenario |
|-----------|-----------|----------|
| Chat | 2 hours | Daily conversations |
| Code | 24 hours | Code development |

When containers expire and get cleaned up, users attempting to continue conversation face two problems:

1. **Container doesn't exist** - The original executor container has been deleted
2. **Session context lost** - Claude SDK's session ID was stored in container and lost with it

## Solution Overview

```mermaid
flowchart TB
    subgraph Problem["❌ Original Problem"]
        A[Container expires] --> B[Container cleaned up]
        B --> C[Session ID lost]
        C --> D[AI loses conversation memory]
    end

    subgraph Solution["✅ Solution"]
        E[Detect expired/deleted] --> F[Prompt user to restore]
        F --> G[Reset container state]
        G --> H[Restore Session ID from Workspace archive]
        H --> I[SessionManager loads session]
        I --> J[Restore Workspace files]
    end

    Problem -.->|Task Restoration Feature| Solution
```

## User Flow

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant Backend
    participant S3
    participant NewContainer as New Container

    User->>Frontend: Send message to expired task
    Frontend->>Backend: POST /tasks/{id}/append
    Backend-->>Frontend: HTTP 409 TASK_EXPIRED_RESTORABLE
    Frontend->>User: Show restore dialog

    alt Choose to continue
        User->>Frontend: Click "Continue Chat"
        Frontend->>Backend: POST /tasks/{id}/restore
        Backend->>Backend: Reset task state
        Backend->>Backend: Mark Workspace pending restore
        Backend-->>Frontend: Restore successful
        Frontend->>Backend: Resend message
        rect rgb(212, 237, 218)
            Note over Backend,S3: Workspace Archive Restoration
            Backend->>Backend: Mark Workspace pending restore
            NewContainer->>S3: Download Workspace archive
            S3-->>NewContainer: Return .claude_session_id
        end
        NewContainer->>NewContainer: SessionManager loads session
        NewContainer->>NewContainer: Extract Workspace files
        NewContainer-->>User: AI continues conversation (context preserved)
    else Choose new chat
        User->>Frontend: Click "New Chat"
        Frontend->>Backend: Create new task
    end
```

## Core Mechanisms

### 1. Expiration Detection

When processing message append requests, backend checks the following conditions:

| Check | Condition | Result |
|-------|-----------|--------|
| executor_deleted_at | Last ASSISTANT subtask marked as true | Return 409 |
| Expiration time | Exceeds configured expiration hours | Return 409 |

**Error Response Format**:

```json
{
  "code": "TASK_EXPIRED_RESTORABLE",
  "task_id": 123,
  "task_type": "chat",
  "expire_hours": 2,
  "last_updated_at": "2024-01-01T12:00:00Z",
  "message": "chat task has expired but can be restored",
  "reason": "expired"
}
```

### 2. Task Restore API

**Endpoint**: `POST /api/v1/tasks/{task_id}/restore`

**Request/Response Types**:

```typescript
// Request
interface RestoreTaskRequest {
  message?: string  // Message to send after restore (optional)
}

// Response
interface RestoreTaskResponse {
  success: boolean
  task_id: number
  task_type: string
  executor_rebuilt: boolean
  message: string
}
```

The restore operation performs these steps:

```mermaid
flowchart LR
    A[Validate task] --> B[Clear executor_deleted_at]
    B --> C[Clear all executor_name]
    C --> D{Is Code task?}
    D -->|Yes| E[Mark Workspace pending restore]
    D -->|No| F[Reset updated_at]
    E --> F
    F --> G[Return success]
```

| Step | Purpose |
|------|---------|
| Validate task | Check task exists, user permission, task is restorable |
| Clear executor_deleted_at | Allow task to receive new messages |
| Clear executor_name | Clear **all** ASSISTANT subtask's executor_name, force new container creation |
| Mark Workspace pending restore | Code task: mark S3 archive URL in metadata |

**Restorable task states**: `COMPLETED`, `FAILED`, `CANCELLED`, `PENDING_CONFIRMATION`

### 3. Session Manager Module

Executor uses `SessionManager` for unified session management:

```mermaid
flowchart TB
    subgraph SessionManager["SessionManager Responsibilities"]
        A[Client connection cache] --> B["_clients: session_id → Client"]
        C[Session ID mapping] --> D["_session_id_map: internal_key → actual_id"]
        E[Local file persistence] --> F[".claude_session_id"]
    end

    subgraph ResolveLogic["resolve_session_id()"]
        G[Input: task_id, bot_id, new_session] --> H{Has cached session_id?}
        H -->|Yes| I{new_session?}
        H -->|No| J[Use internal_key]
        I -->|Yes| K[Create new session]
        I -->|No| L[Use cached value]
        J --> M[Return session_id]
        K --> M
        L --> M
    end
```

**Session ID Resolution Priority**:

| Priority | Source | Description |
|----------|---------|-------------|
| 1 | Local file `.claude_session_id` | From Workspace archive, for cross-container restore |
| 2 | internal_key | Format: `task_id:bot_id`, identifier within same container |
| 3 | Create new session | No history available, create fresh session |

### 4. Workspace Archive Restoration

For Code tasks, restoration requires recovering workspace files:

```mermaid
flowchart LR
    A[Task restore] --> B{executor_rebuilt?}
    B -->|Yes| C{Is Code task?}
    B -->|No| D[Skip]
    C -->|Yes| E[Find S3 archive]
    C -->|No| D
    E --> F{Archive exists?}
    F -->|Yes| G[Mark pending restore]
    F -->|No| H[Log warning]
    G --> I[New container downloads on startup]
```

**Implementation**: `mark_for_restore()` method in `backend/app/services/adapters/workspace_archive.py`

**Workspace Archive Contains**:
- Git-tracked code files
- `.claude_session_id` session ID file

## Data Flow Details

### Task Restoration (Workspace Archive → Executor)

```mermaid
flowchart LR
    A[Task restore API] --> B[Mark Workspace pending restore]
    B --> C[Generate S3 presigned URL]
    C --> D[Update Task metadata]
    D --> E[New container starts]
    E --> F[Download Workspace archive]
    F --> G[Extract to workspace]
    G --> H[Restore .claude_session_id]
    H --> I[SessionManager loads session]
```

### Task Completion (Session ID Saving)

```mermaid
flowchart LR
    A[Claude SDK returns session_id] --> B[SessionManager saves]
    B --> C[Write to local file]
    C --> D[.claude_session_id]
```

**Code Example** (SessionManager):

```python
# Save session ID to local file
SessionManager.save_session_id(self.task_id, session_id)

# Load session ID from local file
saved_session_id = SessionManager.load_saved_session_id(self.task_id)
if saved_session_id:
    self.options["resume"] = saved_session_id
```

## Session Expiry Handling

When attempting to restore a session fails, automatic fallback occurs:

```mermaid
flowchart TB
    A[Attempt to restore session] --> B{Retryable error?}
    B -->|Yes| C[Get actual session_id]
    C --> D[Return RETRY_WITH_RESUME]
    D --> E[Retry with session resume]
    E --> F{Retry success?}
    F -->|Yes| G[Continue with restored session]
    F -->|No| H[Create new session]
    B -->|No| I[Throw exception]
```

**Retryable error types**: Determined by `is_retryable_error_subtype()` function

**Retry limit**: `MAX_ERROR_SUBTYPE_RETRIES` times

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `APPEND_CHAT_TASK_EXPIRE_HOURS` | Hours before chat task expires | 2 |
| `APPEND_CODE_TASK_EXPIRE_HOURS` | Hours before code task expires | 24 |

## Related Files

### Backend

| File | Responsibility |
|------|----------------|
| `backend/app/api/endpoints/adapter/task_restore.py` | Restore API endpoint |
| `backend/app/services/adapters/task_restore.py` | Restore service logic, validation, state reset |
| `backend/app/services/adapters/workspace_archive.py` | Workspace archive restore marking |

### Executor

| File | Responsibility |
|------|----------------|
| `executor/agents/claude_code/session_manager.py` | Session management, caching, local file persistence |
| `executor/agents/claude_code/claude_code_agent.py` | Session ID initialization, load from local file |
| `executor/services/workspace_service.py` | Workspace archive creation, restoration |

### Frontend

| File | Responsibility |
|------|----------------|
| `frontend/src/features/tasks/components/chat/TaskRestoreDialog.tsx` | Restore dialog UI |
| `frontend/src/features/tasks/components/chat/useChatStreamHandlers.tsx` | Restore flow handling |
| `frontend/src/utils/errorParser.ts` | Parse TASK_EXPIRED_RESTORABLE error |
| `frontend/src/apis/tasks.ts` | restoreTask API client |

### Shared

| File | Responsibility |
|------|----------------|
| (None) | No shared model modifications |
