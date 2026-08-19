---
sidebar_position: 4
---

# Custom AI manager comment continuation

```mermaid
flowchart LR
    EXEC[(automation_manager execution)] --> BIND[Persist execution_id + executor_type + manager_type]
    BIND --> ROOT[Manager activity comment]
    EXEC --> SESSION[Bound Runtime session]
    USER[User reply] --> QUEUE[Queue by manager-comment session]
    QUEUE --> ROUTE[Resolve execution from replied comment]
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

    X->>C: Create automation_manager execution
    C->>C: Persist execution_id, executor_type, and manager_type on activity
    C-->>W: Publish manager comment with complete identity
    U->>W: Reply to a custom AI manager comment
    W->>W: retain it in that comment-session queue while pending or streaming
    W->>W: take the next reply in creation order after the prior turn settles
    W->>C: manager:continue(user comment, manager comment)
    C->>X: Validate execution ID, task, project, and Runtime binding
    C->>C: Create a new streaming reply with manager identity
    C-->>W: Return the new reply
    W->>R: Send user content to the manager comment's bound session
    R-->>C: Stream and complete the new reply
    C->>C: Update only comment state, not task AI execution state
```

| Boundary                              | Code ownership                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Execution-to-comment identity binding | `backend/app/services/project_automation_execution.py`                                          |
| Comment detection and routing         | `wework/src/features/todo/TaskActivityView.tsx`                                                 |
| Socket contract                       | `wework/src/api/backend/projectChatSocket.ts`, `backend/app/api/ws/wework_runtime_namespace.py` |
| Execution and comment validation      | `backend/app/services/project_chat/service.py`                                                  |
| Runtime-session continuation          | `wework/src/features/workbench/`                                                                |

Invariants: before a manager activity comment is published it must persist `execution_id`, `executor_type=automation_manager`, and the corresponding `manager_type`; neither the UI nor the continuation service may infer comment identity from the task's current assignee; continuation is selected from the replied comment's bound execution and Runtime session; only custom `automation_manager` executions may enter this path; follow-ups appended while the same manager-comment session is `pending` or `streaming` must be retained in its queue and sent in creation order; the user reply and manager answer are separate new comments, and an existing comment's author identity is immutable; continuation reuses the original manager session; conversation replies must not overwrite the task's current robot execution state, assignee, or board status.
