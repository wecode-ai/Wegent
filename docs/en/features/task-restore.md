# Task Restoration Feature

## Overview

The Task Restoration feature allows users to continue conversations on expired tasks or tasks whose executor containers have been cleaned up, while preserving the full conversation context.

## Problem Background

In Wegent, tasks use Docker containers (executors) to process AI conversations. These containers have lifecycle limits:

| Task Type | Expiration | Scenario |
|-----------|-----------|----------|
| Chat | 2 hours | Daily conversations |
| Code | 24 hours | Code development |

When containers expire and get cleaned up, users attempting to continue the conversation face two problems:

1. **Container doesn't exist** - The original executor container has been deleted
2. **Session context lost** - Claude SDK's session ID was stored in the container and lost with it

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
        G --> H[Read Session ID from database]:::new
        H --> I[New container resumes session]:::new
    end

    Problem -.->|Task Restoration Feature| Solution

    classDef new fill:#d4edda,stroke:#28a745,stroke-width:2px
```

> 💡 **Legend**: Green nodes are new functionality (Session ID Persistence)

## User Flow

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant Backend
    participant Database
    participant NewContainer as New Container

    User->>Frontend: Send message to expired task
    Frontend->>Backend: POST /tasks/{id}/append
    Backend-->>Frontend: HTTP 409 TASK_EXPIRED_RESTORABLE
    Frontend->>User: Show restore dialog

    alt Choose to continue
        User->>Frontend: Click "Continue Chat"
        Frontend->>Backend: POST /tasks/{id}/restore
        Backend->>Backend: Reset task state
        Backend-->>Frontend: Restore successful
        Frontend->>Backend: Resend message
        rect rgb(212, 237, 218)
            Note over Backend,Database: 🆕 New: Session ID Persistence
            Backend->>Database: Read claude_session_id
            Database-->>Backend: Return session_id
        end
        Backend->>NewContainer: Create container + pass Session ID
        NewContainer->>NewContainer: Resume session using Session ID
        NewContainer-->>User: AI continues conversation (context preserved)
    else Choose new chat
        User->>Frontend: Click "New Chat"
        Frontend->>Backend: Create new task
    end
```

## Core Mechanisms

### 1. Expiration Detection

When processing message append requests, the backend checks the following conditions:

| Check | Condition | Result |
|-------|-----------|--------|
| executor_deleted_at | Last ASSISTANT subtask marked as true | Return 409 |
| Expiration time | Exceeds configured expiration hours | Return 409 |

### 2. Task Restore API

**Endpoint**: `POST /api/v1/tasks/{task_id}/restore`

The restore operation performs these steps:

```mermaid
flowchart LR
    A[Validate task] --> B[Reset updated_at]
    B --> C[Clear executor_deleted_at]
    C --> D[Clear executor_name]
    D --> E[Return success]
```

| Step | Purpose |
|------|---------|
| Clear executor_deleted_at | Allow task to receive new messages |
| Clear executor_name | Force new container creation (don't reuse old container name) |

### 3. Claude Session ID Persistence 🆕

> ⚠️ **New Feature**: This section describes the newly added Session ID persistence mechanism

To enable new containers to restore previous conversation context, Session IDs are persisted to the database:

```mermaid
flowchart TB
    subgraph SaveFlow["🆕 Save Session ID"]
        direction LR
        A1[Claude SDK returns session_id]:::new --> A2[Write to result dict]:::new
        A2 --> A3[Backend extracts and saves to DB]:::new
        A2 --> A4[Local file backup]
    end

    subgraph ReadFlow["🆕 Read Session ID"]
        direction LR
        B1[Task dispatch]:::new --> B2{Database has value?}:::new
        B2 -->|Yes| B3[Use database value]:::new
        B2 -->|No| B4{Local file has value?}
        B4 -->|Yes| B5[Use local file value]
        B4 -->|No| B6[Create new session]
    end

    SaveFlow --> ReadFlow

    classDef new fill:#d4edda,stroke:#28a745,stroke-width:2px
```

> 💡 **Legend**: Green nodes are new logic, white nodes are existing logic (local file backup)

**Storage Strategy**:

| Storage Location | Purpose | Priority | Status |
|-----------------|---------|----------|--------|
| Database `subtasks.claude_session_id` | Primary storage, supports cross-container restore | High | 🆕 New |
| Local file `.claude_session_id` | Backup, fast read within same container | Low | Existing |

## Data Flow Details

### Task Dispatch (Backend → Executor)

```mermaid
flowchart LR
    A[dispatch_tasks] --> B[Query related_subtasks]
    B --> C{Found ASSISTANT<br/>with session_id?}:::new
    C -->|Yes| D[Get latest session_id]:::new
    C -->|No| E[session_id = null]
    D --> F{new_session?}:::new
    E --> G[Return task data]
    F -->|Yes| H[Clear session_id]:::new
    F -->|No| G
    H --> G

    classDef new fill:#d4edda,stroke:#28a745,stroke-width:2px
```

> 💡 **Legend**: Green nodes are the new Session ID lookup and processing logic

### Task Completion (Executor → Backend)

```mermaid
flowchart LR
    A[Claude SDK<br/>returns ResultMessage] --> B[Extract session_id]:::new
    B --> C[Add to result dict]:::new
    C --> D[report_progress]
    D --> E[Backend update_subtask]
    E --> F[Save to database]:::new

    classDef new fill:#d4edda,stroke:#28a745,stroke-width:2px
```

> 💡 **Legend**: Green nodes are the new Session ID passing and saving logic

## Pipeline Mode Handling 🆕

> ⚠️ **New Feature**: Session ID isolation handling in Pipeline mode

In Pipeline mode, when user confirms to proceed to the next stage:

```mermaid
flowchart LR
    A[Stage 1 complete] --> B[User confirms]
    B --> C[new_session = true]
    C --> D[Don't pass old session_id]:::new
    D --> E[Stage 2 creates new session]:::new

    classDef new fill:#d4edda,stroke:#28a745,stroke-width:2px
```

**Reason**: Each Pipeline stage may use different Bots, requiring independent session contexts.

## Session Expiry Handling 🆕

> ⚠️ **New Feature**: Automatic fallback handling when session expires

When Claude SDK returns session-related errors, automatic fallback occurs:

```mermaid
flowchart TB
    A[Attempt to resume session]:::new --> B{Connection successful?}:::new
    B -->|Yes| C[Continue with resumed session]:::new
    B -->|No| D{Is session error?}:::new
    D -->|Yes| E[Remove resume parameter]:::new
    E --> F[Create new session]:::new
    D -->|No| G[Throw exception]

    classDef new fill:#d4edda,stroke:#28a745,stroke-width:2px
```

**Detection Keywords**: `session`, `expired`, `invalid`, `resume`

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `APPEND_CHAT_TASK_EXPIRE_HOURS` | Hours before chat task expires | 2 |
| `APPEND_CODE_TASK_EXPIRE_HOURS` | Hours before code task expires | 24 |

## Related Files

### Backend

| File | Responsibility | Status |
|------|----------------|--------|
| `backend/app/api/endpoints/adapter/task_restore.py` | Restore API endpoint | Existing |
| `backend/app/services/adapters/task_restore.py` | Restore service logic | Existing |
| `backend/app/services/adapters/executor_kinds.py` | Session ID read/save, executor_deleted_at marking | 🆕 Modified |
| `backend/app/services/adapters/task_kinds/operations.py` | Pre-append expiration check | Existing |
| `backend/alembic/versions/x4y5z6a7b8c9_*.py` | Database migration (add claude_session_id) | 🆕 New |

### Executor

| File | Responsibility | Status |
|------|----------------|--------|
| `executor/agents/claude_code/claude_code_agent.py` | Session ID reading, expiry handling | 🆕 Modified |
| `executor/agents/claude_code/response_processor.py` | Add Session ID to result | 🆕 Modified |

### Frontend

| File | Responsibility | Status |
|------|----------------|--------|
| `frontend/src/features/tasks/components/chat/TaskRestoreDialog.tsx` | Restore dialog | Existing |
| `frontend/src/features/tasks/components/chat/useChatStreamHandlers.tsx` | Restore flow handling | Existing |
| `frontend/src/utils/errorParser.ts` | Parse TASK_EXPIRED_RESTORABLE error | Existing |

### Shared

| File | Responsibility | Status |
|------|----------------|--------|
| `shared/models/db/subtask.py` | Subtask model (includes claude_session_id field) | 🆕 Modified |
