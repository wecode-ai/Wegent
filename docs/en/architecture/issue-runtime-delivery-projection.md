---
sidebar_position: 23
---

# Issue Runtime status, delivery, and UI projection

Scope: Runtime Task terminal-state projection into an Issue workflow, Delivery fulfillment projection into the stage gate, and a consistent Issue-detail view of tasks, stage state, and delivery coverage.

```mermaid
flowchart LR
    RUNTIME[Runtime Task lifecycle] --> STATUS_API[Atomic task-status command]
    STATUS_API --> TASK_TRUTH[(workflow.task_statuses)]
    BINDING[(LoopItemTaskBinding)] --> TASK_TRUTH
    TASK_TRUTH --> PROJECTOR[Stage-state projector]

    AGENT[User / Agent] --> DELIVERY_API[Delivery finalize]
    DELIVERY_API --> DELIVERY[(Immutable Delivery + fulfillments)]
    DELIVERY_API --> NODE_DELIVERIES[(workflow.delivery_ids)]
    DELIVERY --> COVERAGE[Delivery coverage]
    NODE_DELIVERIES --> COVERAGE

    PROJECTOR --> GATE[Stage gate]
    COVERAGE --> GATE
    GATE --> ISSUE[(Issue workflow snapshot)]

    STATUS_API --> EVENT[Issue changed event]
    DELIVERY_API --> EVENT
    EVENT --> DETAIL[Issue-detail reload]
    ISSUE --> DETAIL
    BINDING --> DETAIL
    DELIVERY --> DETAIL
    DETAIL --> VIEW[Task terminal state / stage state / delivery N/M]

    DELIVERY --> FILE_INDEX[Project delivery-file index + Issue/task ancestry]
    FILE_INDEX --> FILE_VIEW[File manager Issue / child-task folders]
```

```mermaid
sequenceDiagram
    participant R as Runtime
    participant W as Wework lifecycle bridge
    participant O as Orchestration service
    participant D as Delivery service
    participant DB as Issue / Delivery store
    participant E as Issue changed event
    participant U as Issue detail

    par Runtime terminal-state synchronization
        R-->>W: task succeeded / failed / cancelled
        W->>O: write terminal state by device_id:task_id
        O->>DB: atomically update the matching task_statuses entry
        O->>O: recompute the stage from the latest bound trusted terminal state
        O-->>E: publish Issue changed
    and Delivery fulfillment
        D->>D: validate requirement_id, type, and asset ownership
        D->>DB: atomically freeze Delivery, fulfillments, and delivery_id
        D-->>E: publish Issue changed
    end
    E-->>U: invalidate the current Issue projection
    U->>O: reload Issue, TaskBinding, and Delivery data
    O-->>U: return a consistent stage state and delivery coverage

    alt Status persistence fails
        O-->>W: explicit observable failure with bounded retry
        Note over O,U: Unknown status must not project as queued
    else Delivery succeeds but UI invalidation fails
        U-->>U: mark data as possibly stale and allow reload
        Note over D,U: A persisted Delivery must not authoritatively appear as unsubmitted
    end

    U->>DB: Read project Delivery assets and LoopItem parent chains
    DB-->>U: Return asset_id plus the complete Issue-to-task path
    U-->>U: Project read-only folders without copying or moving assets
```

| Edge                                              | Code ownership                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Runtime lifecycle → Issue status synchronization  | Wework `deliveries` API and the Backend `project_workflow_projection` atomic task-status command |
| TaskBinding + task status → stage state           | Wework `issueWorkflow`, Backend workflow projection                                              |
| Delivery finalize → fulfillment and node binding  | Backend Delivery service, `wework-space` MCP                                                     |
| fulfillment → N/M coverage and approval gate      | Backend deliverable projection, workflow decision service                                        |
| Issue changed → detail refresh                    | Backend `loop_item_events`, Wework `projectChatSocket`, and `CloudTodoWorkspace`                 |
| Issue, TaskBinding, Delivery → UI                 | Wework `TodoEditor`, `IssueWorkflowDag`                                                          |
| Delivery asset + LoopItem ancestry → file manager | Backend `cloud_files` service and cloud-project API, Wework `CloudFilesView`                     |

Essential invariants:

- Runtime Task state is keyed by stable `device_id:task_id` and updated atomically by the backend. A client must not read and rewrite the entire workflow JSON to change one task state.
- A human task may display queued only when Runtime explicitly reports queued. An unknown newly bound task state must preserve the backend stage state or display synchronizing; it must not infer queued.
- Stage state is derived from TaskBinding order and persisted terminal truth: any running task wins, otherwise the latest bound trusted terminal state wins; a successful human stage enters `awaiting_approval`.
- Delivery finalize atomically freezes the Delivery, typed fulfillments, and node `delivery_id`. Only persisted `fulfillments[].requirement_id` values count toward N/M.
- Runtime-state updates and Delivery finalize both invalidate the Issue-detail projection. A refresh must read Issue, TaskBinding, and Delivery together instead of mixing cache versions.
- Status-persistence failures return structured errors and use bounded retry. They must not create an unbounded PATCH loop or change UI semantics.
- Human approval uses a server-side live recomputation of stage state and delivery coverage, never a client cache or a possibly stale node snapshot.
- The project delivery-file index returns the complete persisted parent chain from the root Issue to the task owning the Delivery. The frontend must not infer task hierarchy from titles, identifiers, or file paths.
- The `parent_id` boundary for a root LoopItem includes both `NULL` and the historical empty string; either value terminates ancestry traversal.
- File-manager folders are a read-only projection of Delivery assets. Navigation, preview, and download never copy, move, or mutate the stored asset; file identity remains the original `asset_id`.
