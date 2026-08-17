---
sidebar_position: 10
---

# Board automation and Wegent execution

Scope: manual, API, and automation assignment enter one execution-truth and runtime-activation path, then project trusted terminal state back to the board.

```mermaid
flowchart LR
    ENTRY[Manual / API / automation] --> ASSIGN[shared assignment service]
    ASSIGN --> ITEM[(loop_items assignee truth)]
    ASSIGN --> EXEC[(loop_item_executions truth)]
    EXEC --> ACTIVATE[shared runtime activator]
    ACTIVATE -->|Wework local/cloud| DEVICE[device Runtime]
    ACTIVATE -->|Wegent| TASK[native Task/Subtask]
    TASK --> REQUEST[ExecutionRequest + board MCP]
    REQUEST --> TEAM[Team Runtime]
    DEVICE --> EVENT[runtime event / ACK]
    TEAM --> EVENT
    EVENT --> PROJECT[shared terminal projector]
    PROJECT --> EXEC
    EXEC --> VIEW[queue / card / activity]
```

```mermaid
sequenceDiagram
    participant E as assignment entry
    participant A as assignment service
    participant X as execution truth
    participant R as runtime activator
    participant T as Runtime / Team
    participant P as terminal projector

    E->>A: assign(agent, item)
    A->>X: cancel old attempt and create queued execution
    A-->>E: commit assignee and execution
    E->>R: activate(execution_id)
    R->>X: lock and validate queued/assignee/runtime
    R->>T: claim or create Task/Subtask
    T->>X: accepted/running
    T-->>P: completion, failure, or cancellation ACK
    P->>X: validate linked IDs and write terminal state
    X-->>E: UI reads execution truth only
```

| Edge                           | Code owner                                                            |
| ------------------------------ | --------------------------------------------------------------------- |
| Entry → assignment             | `backend/app/services/loop_items/`, `project_automation_execution.py` |
| Assignment → execution truth   | `backend/app/services/loop_item_executions/service.py`                |
| Execution → runtime activation | `board_team_execution.py`, `robot_queue_tasks.py`, Wework puller      |
| Wegent request → board MCP     | `execution/request_builder.py`, `mcp_server/tools/wework_space.py`    |
| Runtime event → terminal state | `board_team_completion.py`, Executor status updates                   |
| Comment → exact continuation   | `board_team_continuation.py`, `project_automation_tasks.py`           |

Invariants: all entries share assignment and activation; activation occurs only after commit; `loop_item_executions` is the sole board-execution truth; Wegent binding uses exact execution/task/subtask/team IDs; cancellation writes intent first and only a Runtime ACK writes terminal state; messages and UI never overwrite execution state.

See the [cloud-project collaboration guide](../wegent/developer-guide/cloud-project-collaboration.md) for domain, API, and delivery details.
