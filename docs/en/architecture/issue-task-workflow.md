---
sidebar_position: 20
---

# Issue, task, and workflow orchestration

Scope: project workflow definitions, Issue workflow instances, references to existing tasks and executions, dependency readiness, workspace inheritance, and aggregated Issue status.

```mermaid
flowchart LR
    TEMPLATE[(Project Workflow Definition)] --> SNAPSHOT[(Issue Workflow Instance)]
    ISSUE[(LoopItem / Issue)] --> SNAPSHOT
    SNAPSHOT --> NODE[Workflow Node]
    NODE -->|manual creation| BINDING[(LoopItemTaskBinding)]
    BINDING --> TASK[(Wework Runtime Task)]
    NODE -->|automatic execution| EXEC[(LoopItemExecution)]
    EXEC --> RUNTIME[Existing Runtime / Team / API activator]
    TASK --> WORKSPACE[Existing workspace / worktree / branch truth]
    WORKSPACE -->|inherit| NEXT[Successor Wework node]
    TASK --> AGGREGATE[Issue status aggregator]
    EXEC --> AGGREGATE
    NODE --> AGGREGATE
    AGGREGATE --> ISSUE
```

```mermaid
sequenceDiagram
    participant U as User / AI / automation
    participant W as Workflow service
    participant B as Task binding
    participant E as Execution service
    participant R as Runtime scheduler
    participant I as Issue projection

    U->>W: Create or edit an Issue instance from a project definition
    W->>W: Snapshot the version and validate the DAG
    W->>W: Calculate dependency-ready nodes
    alt My-task node
        W-->>U: Open the standard task Composer inside the Issue
        U->>B: Send, create a Runtime Task, and bind the node
    else Automatic node
        W->>E: Create a queued execution through the existing assignment service
        E->>R: Enter the existing capacity queue
    end
    B-->>W: Runtime Task state changes
    E-->>W: Execution state changes
    W->>W: Unlock successor nodes
    W->>I: Aggregate all required-node states
```

| Edge                              | Code ownership                                                         |
| --------------------------------- | ---------------------------------------------------------------------- |
| Project definition and Issue copy | Backend workflow schemas/services; Wework project-space workflow UI     |
| Node to my task                   | Standard Wework Composer, Runtime Task creation, `LoopItemTaskBinding`  |
| Node to automatic execution       | `project_automation_execution.py`, `loop_item_executions/service.py`    |
| Workspace and successor inherit   | Runtime Task summary and Wework project work controls                   |
| DAG readiness and Issue aggregate | Backend workflow service; local ProjectSpace service; live Wework projection |

Invariants:

- `LoopItem` is the Issue and business aggregate, not one execution.
- Wework Runtime Tasks, Wegent Tasks, and `LoopItemExecution` remain the task and execution truths. Workflow nodes only reference them and never duplicate state, directories, worktrees, branches, or queue fields.
- One Issue may bind multiple heterogeneous tasks. A my-task node only creates a task owned by the current user and visible in Wework's task list.
- Manual nodes and automation/AI-generated nodes use the same DAG, executor, dependency, and workspace-policy structure.
- `inherit` reads a confirmed workspace/worktree/branch only from an explicit predecessor Runtime Task. Without an inheritable source, the standard Composer must request a selection instead of guessing.
- Queued, approval-pending, and dependency-blocked work projects to Pending. Only Runtime-confirmed running work projects to In Progress.
- Issue completion is aggregated from every required node's trusted terminal state. Completing one task must not complete an Issue that has other required nodes.
- The DAG must be acyclic, dependencies must be satisfied before execution, and the UI must never write running directly.
