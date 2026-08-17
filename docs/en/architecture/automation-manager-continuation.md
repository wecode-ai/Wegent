---
sidebar_position: 4
---

# Custom AI manager comment continuation

```mermaid
flowchart LR
    ROOT[Manager activity comment] --> EXEC[(automation_manager execution)]
    EXEC --> SESSION[Bound Runtime session]
    USER[User reply] --> ROUTE[Resolve execution from replied comment]
    ROOT --> ROUTE
    ROUTE --> REPLY[Create new manager-authored reply]
    ROUTE --> SESSION
    SESSION --> STREAM[Reply stream]
    STREAM --> REPLY
    REPLY -. conversation_only .-> TASK[Task execution state remains unchanged]
```

```mermaid
sequenceDiagram
    participant U as User
    participant W as Wework comments
    participant C as ProjectChatService
    participant X as Execution truth
    participant R as Runtime session

    U->>W: Reply to a custom AI manager comment
    W->>C: manager:continue(user comment, manager comment)
    C->>X: Validate execution ID, task, project, and Runtime binding
    C->>C: Create a new streaming reply with manager identity
    C-->>W: Return the new reply
    W->>R: Send user content to the manager comment's bound session
    R-->>C: Stream and complete the new reply
    C->>C: Update only comment state, not task AI execution state
```

| Boundary | Code ownership |
| --- | --- |
| Comment detection and routing | `wework/src/features/todo/TaskActivityView.tsx` |
| Socket contract | `wework/src/api/backend/projectChatSocket.ts`, `backend/app/api/ws/wework_runtime_namespace.py` |
| Execution and comment validation | `backend/app/services/project_chat/service.py` |
| Runtime-session continuation | `wework/src/features/workbench/` |

Invariants: continuation is selected from the replied comment's bound execution and Runtime session, never from the task's current assignee; only custom `automation_manager` executions may enter this path; the user reply and manager answer are separate new comments, and an existing comment's author identity is immutable; continuation reuses the original manager session; conversation replies must not overwrite the task's current robot execution state, assignee, or board status.
