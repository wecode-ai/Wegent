---
sidebar_position: 8
---

# Runtime task lifecycle reconciliation

## Scope

Governs how Wework consumes Runtime task events, detects a potentially stale local projection, and recovers authoritative task state without polling transcripts.

## Connection graph

```mermaid
flowchart LR
    EXEC[Executor task state] --> STREAM[Runtime event stream]
    STREAM --> STORE[Lifecycle Store]
    STORE --> UI[Running-state UI projection]
    STREAM --> TERMINAL[Terminal event]
    TERMINAL --> STORE
    STREAM --> SIGNAL[Lag or transport replacement]
    SIGNAL --> LIST[runtime.tasks.list]
    LIST --> STORE
    TRANSCRIPT[runtime.tasks.transcript] -. User opens chat or requests message sync .-> UI
```

## Sequence

```mermaid
sequenceDiagram
    participant E as Executor
    participant S as Runtime event stream
    participant C as Lifecycle Coordinator
    participant L as Lifecycle Store

    E-->>S: task/turn events
    S-->>L: Incremental projection
    alt No terminal or anomaly signal
        Note over C: No state polling
    else terminal event
        S-->>C: response.completed / failed / incomplete
        C->>L: turnSettled
    else executor.event_lagged or runtime transport replacement
        S-->>C: Projection may be stale
        C->>E: runtime.tasks.list
        E-->>C: Persisted task snapshot
        C->>L: syncRuntimeWork
    end
```

## Code ownership

| Responsibility                     | Code                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Local Executor event parsing       | `wework/src/api/runtime/runtimeChatStream.ts`                                                  |
| Hybrid stream handler routing      | `wework/src/api/hybrid/hybridServices.ts`                                                      |
| Event-driven reconciliation coordinator | `wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStreamCoordinator.tsx` |
| Lifecycle truth projection         | `wework/src/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore.ts`              |
| Executor task list and transcript  | `executor/src/runtime_work/handler/queries.rs`                                                 |

## Essential invariants

- The normal lifecycle consumes only the event stream and never reads task lists or transcripts on a timer.
- A terminal event directly settles the shared lifecycle store by `deviceId + taskId`. The resident coordinator must not depend on a mounted pane or overwrite that terminal signal with a task list read immediately after the event, because the Executor and provider list projections may still be finishing the same turn.
- `executor.event_lagged` and runtime transport replacement also trigger reconciliation because they explicitly indicate that the local projection may be stale.
- Concurrent anomaly signals share one in-flight reconciliation request; new signals during that request coalesce into at most one serial trailing reconciliation and never create a concurrent request burst or timed retry loop.
- Terminal task state is projected from Executor persistence fields, never inferred from transcripts, turn items, or rollout JSONL.
- Transcript reads serve only user-visible chat loading or explicit message synchronization; they are not lifecycle heartbeats.
