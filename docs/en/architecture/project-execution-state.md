---
sidebar_position: 30
---

# Project execution state and Runtime capacity

Scope: execution claim, event ordering, cancellation, late events, lease reconciliation, device concurrency capacity, and UI projection.

```mermaid
flowchart LR
    INTENT[(persisted execution intent)] --> CLAIM[atomic Runtime claim]
    CLAIM --> ACTIVE[(active attempt + lease)]
    ACTIVE --> PROCESS[real process]
    PROCESS --> EVENT[attempt/sequence event]
    EVENT --> FENCE[identity and ordering fence]
    FENCE --> TRUTH[(execution-state truth)]
    TRUTH --> NORMALIZE[execution ID sentinel normalization]
    NORMALIZE --> VIEW
    VIEW[pure UI projection]
    SETTINGS[device slot_max] --> SCHEDULER[Runtime scheduler]
    SCHEDULER --> CLAIM
    SCHEDULER --> CAPACITY[slot_used / slot_max projection]
```

```mermaid
sequenceDiagram
    participant Q as execution queue
    participant R as Runtime scheduler
    participant P as real process
    participant S as state service
    participant U as UI

    Q->>Q: persist unbound team/task identifiers as sentinel 0
    R->>Q: claim(execution_id, attempt_id)
    Q-->>R: accepted + lease
    R->>P: start
    P-->>S: sequenced running/output events
    S->>S: validate attempt, sequence, lease
    alt normal termination
        P-->>S: terminal event
        S->>S: atomically write terminal state and release slot
    else cancellation
        U->>S: cancellation intent
        S->>R: cancel command
        R-->>S: stopped ACK
        S->>S: write cancelled and release slot
    else lease expiry
        S->>R: reconcile
        S->>S: recover or terminate from real process truth
    end
    S-->>U: normalize 0 to null and return a read-only projection
```

| Edge                                  | Code owner                                                      |
| ------------------------------------- | --------------------------------------------------------------- |
| Claim, attempt, and state transitions | `backend/app/services/loop_item_executions/service.py`          |
| Execution ID storage and normalization | `backend/app/models/loop_item_execution.py`, execution API/schema |
| Scheduler, slots, and real process    | `executor/src/runner/`, `executor/src/runtime_work/`            |
| Local IPC and Runtime RPC             | `executor/src/local/app_ipc.rs`, Backend device runtime service |
| UI projection                         | Wework workbench stores and board queries                       |

Invariants: attempt identity and event sequence must match; late events cannot overwrite a newer attempt; terminal state and slot release are atomic; sending cancellation is not cancellation success; `loop_item_executions.team_id/backend_task_id=0` means unbound only, existence checks must use positive-ID semantics, and APIs/UI must normalize the sentinel to `null`; capacity belongs to each device Runtime scheduler and aggregate capacity is not execution truth; UI never derives or writes runtime state.

See [project execution state-of-truth refactoring](../wework/developer-guide/wework-project-execution-state-truth-refactoring.md) for the detailed state matrix and acceptance coverage.
