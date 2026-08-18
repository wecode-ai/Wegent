---
sidebar_position: 20
---

# Issue, task, and workflow orchestration

Scope: Issue task organization, advancement policy, project stage DAGs, Issue stage snapshots, references to concrete tasks and executions, dependency readiness, workspace inheritance, activity projection, and aggregated Issue status.

```mermaid
flowchart LR
    EDITOR[Stage DAG editor] -->|add / insert stage| TEMPLATE[(Project Orchestration Definition)]
    TEMPLATE --> SNAPSHOT[(Issue Orchestration Snapshot)]
    ISSUE[(LoopItem / Issue)] --> SNAPSHOT
    SNAPSHOT --> MODE{Advancement policy}
    MODE -->|user managed| HUMAN[User plans and assigns]
    MODE -->|AI coordinated| AI[AI reads the Issue, prompt, and stage definition]
    SNAPSHOT --> GRAPH{Stage DAG configured?}
    GRAPH -->|no stages| FREE[Free task set]
    GRAPH -->|stages| STAGE[Stage / Node / Milestone]
    STAGE --> EDGE[Dependency edge / Context contract]
    EDGE --> STAGE
    HUMAN --> BINDING[(LoopItemTaskBinding)]
    AI --> BINDING
    FREE --> BINDING
    STAGE --> BINDING
    BINDING --> TASK[(Wework Runtime Task)]
    STAGE -->|stage automation rule| EXEC[(LoopItemExecution)]
    EXEC --> RUNTIME[Existing Runtime / Team / API activator]
    TASK --> WORKSPACE[Existing workspace / worktree / branch truth]
    WORKSPACE -->|inherit| NEXT[Successor concrete task]
    TASK --> AGGREGATE[Issue status aggregator]
    EXEC --> AGGREGATE
    STAGE --> AGGREGATE
    AGGREGATE --> ISSUE
    TASK --> ACTIVITY[Issue activity]
    EXEC --> ACTIVITY
    ACTIVITY --> STREAM[Streaming run card / final summary / attachment event]
```

```mermaid
sequenceDiagram
    participant U as User
    participant G as Stage DAG editor
    participant O as Orchestration service
    participant A as AI coordinator
    participant B as Task binding
    participant E as Execution service
    participant R as Runtime scheduler
    participant D as Issue activity
    participant I as Issue projection

    U->>O: Create an Issue
    opt Edit the project stage DAG
        U->>G: Select a stage and insert before or after
        G->>G: Rewire direct dependencies and migrate edge context
    end
    O->>O: Snapshot policy, prompt, and optional stage DAG
    O->>O: Validate the DAG, edge context contracts, and ready stages
    alt User managed
        U->>B: Create a concrete task, optionally in a ready stage
    else AI coordinated
        O->>A: Provide Issue, prompt, stage definition, edge context contracts, and execution truth
        A->>B: Decompose and assign concrete tasks
        Note over A,B: Every task belongs to a stage when stages exist
    end
    opt Stage has an automation action
        O->>E: Create a queued execution
        E->>R: Enter the existing capacity queue
    end
    B->>R: Concrete task enters the existing capacity queue
    R-->>D: Stream progress, terminal result, and delivered assets
    B-->>O: Runtime Task status changes
    E-->>O: Execution status changes
    O->>O: Aggregate stage tasks and unlock successors
    O->>I: Aggregate all required stages and free tasks
```

| Edge                                                  | Code ownership                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Project orchestration definition and Issue snapshot   | Backend workflow schemas/services; Wework Automation DAG UI              |
| Stage DAG editing and adjacent insertion              | Wework `ProjectWorkflowEditor`; workflow node dependency context          |
| Dependency edge to successor context                  | Workflow node dependency context; Composer / automation instruction      |
| User/AI coordination to concrete tasks                | Standard Wework Composer, AI manager, `LoopItemTaskBinding`               |
| Stage to automated execution                          | `project_automation_execution.py`, `loop_item_executions/service.py`      |
| Workspace and successor-task inheritance              | Runtime Task summary and Wework project work controls                    |
| DAG readiness, stage, and Issue aggregation           | Backend workflow service; local ProjectSpace service; live Wework projection |
| Execution truth to Issue activity                     | Project chat stream, task activity cards, delivery/attachment projection |

Invariants:

- `LoopItem` is the Issue and business aggregate, not one execution.
- A Stage / Node / Milestone is a logical task category and dependency node, not an execution and not an executor type.
- Wework Runtime Tasks, Wegent Tasks, and `LoopItemExecution` remain the concrete task and execution truths. Stages only reference them and never duplicate state, directories, worktrees, branches, or queue fields.
- The stage DAG and advancement policy are orthogonal. User management and AI coordination both work with or without stages.
- A dependency edge is both a readiness constraint and a context contract from the predecessor stage to the successor. Core Issue context is always included; the edge controls whether predecessor final results, delivered assets, and execution activity are added.
- Edge context policy is stored as the successor node's input declaration for a direct predecessor. Removing a dependency must remove its policy as well.
- Inserting before a stage transfers its incoming dependencies and edge-context declarations to the new stage, then makes the selected stage depend on it. Inserting after a stage places the new stage between it and every direct successor, preserving each successor's edge-context declaration.
- AI advances an Issue only by creating, assigning, and starting concrete tasks. With stages, every AI-created task belongs to a stage and follows its dependencies. Without stages, AI may decompose work from the Issue and prompt.
- One Issue may bind multiple heterogeneous tasks, and one stage may aggregate multiple concrete tasks. Tasks remain discoverable in Wework's task list.
- Stage automation controls when and how a concrete execution is created or started; it is not an entity type parallel to Task.
- `inherit` reads a confirmed workspace/worktree/branch only from an explicit predecessor Runtime Task. Without an inheritable source, the standard Composer must request a selection instead of guessing.
- Queued, approval-pending, and dependency-blocked work projects to Pending. Only Runtime-confirmed running work projects to In Progress.
- A stage completes from the trusted terminal state of all required tasks/executions in that stage. An Issue completes from all required stages and free tasks. Completing one task cannot complete a stage or Issue with remaining work.
- The DAG must be acyclic. A referenced stage must exist, dependencies must be satisfied before a stage starts, edge context may reference direct predecessors only, and the UI must never write running directly.
- Issue Activity is the unified execution projection. Streaming cards show compact Runtime truth, completed cards show a final-content summary, and attachment events reference real delivery assets.
