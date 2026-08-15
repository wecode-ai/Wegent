---
sidebar_position: 19
---

# Project Execution State-of-Truth Refactoring

> Implementation status: code, automated regression, and isolated real-desktop verification are complete; code review and manual acceptance remain.
>
> Hard constraint: no new database tables. This change only extends the existing MySQL/SQLite `loop_item_executions` tables and continues using existing LoopItem, chat-message, and Automation Run storage.

## 1. Goal and scope

This is not an enum cleanup. It makes every user-visible execution state provable. It covers project-robot and automation-manager queueing, startup, events, cancellation, recovery, retry, and UI projection across cloud and local Runtime.

`TaskResource`/`Subtask` execution keeps its own existing `tasks`/`subtasks` authority. It is not copied into `loop_item_executions`, and this document does not claim that the two execution models were merged.

The implementation guarantees:

- Claim proves control-plane ownership, not that Runtime is running.
- Once Start may have arrived, timeout cannot requeue the same attempt.
- Heartbeat renews a control lease; it does not prove process liveness.
- Unprovable state is `unknown`, not guessed failure, success, or retryability.
- Runtime terminal events use attempt identity, monotonic event sequence, and CAS.
- Cancellation intent is distinct from proof that Runtime stopped.
- A Runtime failure retry creates a new row in the existing table and preserves the old attempt.
- GET is read-only; message and cached state cannot overwrite execution truth.

## 2. Authority and projection connections

```mermaid
flowchart LR
  subgraph Commands["Command sources"]
    ASSIGN["Task assignment"]
    AUTO["Automation trigger"]
    USER["Approve / cancel / retry"]
  end
  subgraph Existing["Existing storage — no new table"]
    EXEC["MySQL loop_item_executions<br/>one row = one attempt"]
    LSQL["SQLite loop_item_executions<br/>same semantics"]
    ITEM["loop_items<br/>workflow / Automation projection"]
    MSG["project_chat_messages<br/>text and activity projection"]
  end
  subgraph Runtime["Actual Runtime"]
    CLOUD["Cloud Executor"]
    LOCAL["Local Executor"]
  end
  subgraph Read["Pure read projection"]
    MAP["execution_display_state<br/>execution_ai_state"]
    API["LoopItem / My Work / Queue API"]
  end
  subgraph UI["One display vocabulary"]
    QUEUE["Project Queue"]
    DETAIL["Task Activity"]
    MYWORK["My Work"]
    RULES["Automation Rules"]
    OVERLAY["Runtime Overlay"]
  end
  ASSIGN --> EXEC
  AUTO --> EXEC
  USER --> EXEC
  ASSIGN --> LSQL
  EXEC --> CLOUD
  LSQL --> LOCAL
  CLOUD -->|"identity + eventSeq"| EXEC
  LOCAL -->|"trusted in-process outcome"| LSQL
  EXEC -->|"same transaction"| ITEM
  EXEC -->|"same transaction"| MSG
  EXEC --> MAP
  LSQL --> MAP
  MAP --> API
  API --> QUEUE
  API --> DETAIL
  API --> MYWORK
  API --> RULES
  API --> OVERLAY
```

The direction is one-way: Execution → Message/Automation/Workflow projections. A message, `metadata.ai_state`, board lane, or UI cannot decide Execution state.

## 3. Zero-new-table model

One existing `loop_item_executions` row is one attempt. The migration only adds columns and the non-unique `idx_exec_scope_status` index; it contains no `CREATE TABLE`. Local SQLite applies `ALTER TABLE` to its existing table and moves to schema version 6.

| Dimension | Columns | Meaning |
| --- | --- | --- |
| Control | `status` | `pending_approval`, `queued`, `claimed`, `running`, `cancel_requested`, `completed`, `failed`, `cancelled` |
| Runtime observation | `observed_state`, `observed_at` | Latest verified Runtime state and evidence time |
| Sync health | `sync_state` | `pending`, `in_sync`, `stale`, `diverged` |
| Attempt causality | `attempt_no`, `previous_execution_id` | Attempt number and previous-attempt link |
| Concurrency domain | `execution_scope` | Project robot by task; manager by Automation Run |
| Start fence | `claimed_at`, `start_requested_at` | Separates a releasable claim from a Start that may have arrived |
| Runtime identity | `runtime_device_id`, `runtime_task_id` | Task ID is deterministically `codex-queue-{execution.id}` and validated at every write |
| Event fence | `last_event_seq` | Only a greater Runtime sequence is accepted |
| Cancellation/terminal | `cancel_requested_at`, `termination_reason` | Cancellation intent time and confirmed terminal reason |
| Control lease | `heartbeat_at`, `lease_expires_at` | Dispatcher/claim liveness, never standalone process proof |

There is deliberately no unique `runtime_task_id` index: a row is inserted before its ID exists, and historical empty defaults would conflict. Deterministic identity validation plus `execution_scope`, agent occupancy, owner/device locks, and CAS enforce the invariant.

## 4. Independent dimensions and display state

```mermaid
stateDiagram-v2
  [*] --> pending_approval
  [*] --> queued
  pending_approval --> queued: approve
  pending_approval --> cancelled: reject
  queued --> claimed: claim CAS
  claimed --> queued: lease expires and Start was never fenced
  claimed --> running: Runtime event/trusted query
  claimed --> cancel_requested: cancel after Start may arrive
  running --> cancel_requested: request cancel
  claimed --> failed: preflight failure before Start only
  running --> completed: Runtime succeeded
  running --> failed: Runtime failed
  cancel_requested --> cancelled: Runtime event or cancel ACK
  cancel_requested --> completed: Runtime success fact
  cancel_requested --> failed: Runtime failure fact
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
```

Display state is derived at request time with fixed precedence:

```mermaid
flowchart TD
  A["Read latest attempt"] --> T{"Confirmed terminal?"}
  T -->|completed| S["succeeded"]
  T -->|failed| F["failed"]
  T -->|cancelled| C["cancelled"]
  T -->|no| H{"sync stale/diverged?"}
  H -->|yes| U["unknown"]
  H -->|no| Q{"control state"}
  Q -->|pending_approval| WA["waiting_approval"]
  Q -->|queued| QQ["queued"]
  Q -->|claimed + observed unconfirmed| ST["starting"]
  Q -->|claimed + observed accepted| WR["waiting_runtime"]
  Q -->|cancel_requested| CG["cancelling"]
  Q -->|running + observed running| R["running"]
  Q -->|other unproved combination| WR["waiting_runtime"]
```

Updating `heartbeat_at` therefore cannot turn `starting/unknown` into `running`, and stale sync health cannot hide a confirmed terminal outcome.

## 5. Cloud startup sequence

```mermaid
sequenceDiagram
  participant C as Queue Consumer
  participant DB as loop_item_executions
  participant W as Celery Dispatch
  participant G as Runtime RPC Gateway
  participant R as Cloud Executor
  C->>C: owner lock → device lock
  C->>DB: capacity, agent, and scope checks
  C->>DB: CAS queued → claimed<br/>bind codex-queue-{id}
  W->>DB: build just-in-time Runtime payload
  W->>DB: persist start_requested_at fence
  W->>G: runtime.tasks.create
  G->>R: emit create command
  alt Explicitly not emitted
    G-->>W: emitted=false
    W->>DB: safely restore queued without retry cost
  else Ambiguous outcome or first-event timeout
    G--xW: response lost / no proof
    W->>DB: retain claimed, sync=stale
    Note over DB: display unknown, hold capacity, do not redeliver
  else Runtime emits its first event
    R-->>DB: identity + eventSeq
    DB->>DB: observed=running, status=running
  end
```

An RPC transport failure is distinct from an explicit `emitted=false`. After the Start fence, ambiguity can only become unknown.

## 6. Local/App startup sequence

```mermaid
sequenceDiagram
  participant APP as Wework Dispatcher
  participant SQL as Local SQLite
  participant API as Runtime Work API
  participant R as Local Executor
  APP->>SQL: claimNext → claimed<br/>bind device/task identity
  APP->>SQL: executions.start_requested
  APP->>API: createRuntimeTask(codex-queue-{id})
  alt Create response proves acceptance
    API-->>APP: accepted
    APP->>SQL: executions.runtime_start<br/>observed=accepted
    R->>SQL: active-turn callback<br/>status/observed=running
  else Outcome is ambiguous after Start
    API--xAPP: lost response / exception
    APP->>SQL: executions.dispatch_unknown
    Note over SQL: keep claimed + stale + unknown
  else Preflight fails before Start
    APP->>SQL: executions.dispatch_failed
    Note over SQL: this is the only safe local dispatch failure
  end
```

App IPC no longer exposes dispatcher-callable `executions.complete` or `executions.fail`. Local Executor turn outcomes write terminal state.

## 7. Event ordering and atomic terminal state

```mermaid
sequenceDiagram
  participant R as Runtime
  participant E as Event Gateway
  participant X as Execution Truth
  participant P as Activity / Automation / Task / Chat
  participant PUSH as Push
  R->>E: event(identity, eventSeq=41)
  E->>X: validate identity, sequence, and terminal truth
  X->>X: CAS last_event_seq < 41
  X-->>E: accept and write observation
  E->>P: project accepted event only
  R->>E: duplicate/reordered eventSeq=40
  E->>X: validate Runtime evidence
  X-->>E: reject
  E--xP: gate stays closed, no downstream advance
  par Competing terminals
    R->>E: succeeded seq=42
  and
    R->>E: failed seq=43
  end
  E->>X: first successful CAS elects irreversible terminal
  X->>P: update every projection in the same transaction
  P-->>PUSH: invalidate only after commit
  Note over E,P: missing-sequence, reordered, and post-terminal events advance nothing
```

Manual rejection uses the same transaction boundary: Execution, Activity, Automation projection, and task-version CAS commit together. Internal helpers cannot commit early.

## 8. Cancellation sequence

```mermaid
sequenceDiagram
  participant U as User/reassignment/stall policy
  participant DB as Execution
  participant R as Runtime
  U->>DB: cancel(executionId)
  alt pending/queued/claimed and Start was never fenced
    DB->>DB: terminal cancelled<br/>observed=cancelled
    Note over DB: a process is provably impossible
  else Start is fenced or running was observed
    DB->>DB: status=cancel_requested<br/>sync=pending
    DB->>R: runtime.tasks.cancel(identity)
    alt Runtime ACK / cancelled event
      R-->>DB: stop proof
      DB->>DB: cancelled + completed_at
    else Timeout/unreachable
      R--xDB: no proof
      DB->>DB: retain cancel_requested or stale
      Note over DB: display cancelling/unknown and retain capacity
    end
  end
```

The local Queue stop action first calls local `executions.cancel`, then calls `cancelRuntimeTask` with the identity stored on that row. It no longer calls the cloud stop API.

## 9. Retry and late-event isolation

```mermaid
sequenceDiagram
  participant R1 as Runtime Attempt 1
  participant DB as loop_item_executions
  participant Q as Queue
  participant R2 as Runtime Attempt 2
  R1->>DB: failed(id=101, seq=90)
  DB->>DB: Attempt 1 → failed, irreversible
  DB->>DB: INSERT Attempt 2<br/>id=102, attempt_no=2<br/>previous_execution_id=101
  Q->>DB: claim id=102
  Q->>R2: Start codex-queue-102
  R1-->>DB: late event codex-queue-101 seq=91
  DB-->>R1: matches terminal Attempt 1 only, reject mutation
  R2-->>DB: event codex-queue-102
  DB->>DB: update Attempt 2 only
```

Only a proven Runtime failure may consume retry budget and create a retry attempt. A definitively pre-Start infrastructure failure may restore the same row to queued because no process can exist.

## 10. Lease expiry, unknown, and reconciliation

```mermaid
sequenceDiagram
  participant S as Cloud Scan / Local App Recovery
  participant DB as Execution
  participant R as Runtime tasks.list
  participant UI as UI
  S->>DB: find expired capacity row
  alt claimed and start_requested_at is unset
    DB->>DB: restore same row to queued, no retry cost
    DB-->>UI: queued
  else Start may have arrived
    DB->>DB: sync=stale, retain capacity
    DB-->>UI: unknown
    S->>R: query by device/task identity
    alt running=true
      R-->>S: active turn
      S->>DB: observed=running, sync=in_sync
    else turnStatus is completed/failed/interrupted
      R-->>S: terminal turn
      S->>DB: write exact outcome
    else Task exists without an active turn
      R-->>S: queued/active + running=false
      S->>DB: observed=accepted, sync=in_sync
      DB-->>UI: waiting_runtime
    else Missing/unrecognized
      R-->>S: no matching task or unknown state
      S->>DB: sync=diverged, remain unknown
    else Runtime unreachable
      R--xS: query failed
      Note over S,DB: retain stale/unknown, do not guess
    end
  end
```

Both Cloud Scan and Local App reconcile by the persisted device/task identity. Local App uses `executions.list_stale` and `executions.reconcile` to recover events lost while it was offline. `task.status=active` alone is not running proof; reconciliation must combine `running` and `turnStatus`.

A long-running attempt with no text only triggers `cancel_requested` plus Runtime cancellation; it is not manufactured into `failed`.

## 11. Concurrency and capacity

```mermaid
flowchart TD
  SCAN["Scan queued by owner/device"] --> OL["Acquire owner lock"]
  OL --> DL["Acquire environment/device lock"]
  DL --> CAP{"Capacity available?"}
  CAP -->|no| END["Do not claim"]
  CAP -->|yes| AG{"Agent already has capacity row?"}
  AG -->|yes| NEXT["Skip candidate"]
  AG -->|no| SP{"execution_scope occupied?"}
  SP -->|yes| NEXT
  SP -->|no| CAS["CAS queued → claimed"]
  CAS -->|lost| NEXT
  CAS -->|won| SLOT["claimed/running/cancel_requested/unknown<br/>all occupy a slot"]
```

Lock order is owner → device → database CAS. Unknown retains its slot; releasing it could run a new attempt beside a still-running process.

## 12. Pure reads and UI consistency

```mermaid
flowchart LR
  GET["GET LoopItem / My Work / Queue"] --> LATEST["Read latest attempt"]
  LATEST --> MAP["Derive display/control/observed/sync/attempt/eventSeq"]
  MSG["Linked terminal message"] -->|"text/message context only"| MAP
  CACHE["Legacy metadata.ai_state"] -->|"context only"| MAP
  MAP --> RESP["Pure response, no database write"]
  RESP --> STATUS["executionStatus.ts exact normalization"]
  STATUS --> Q["Queue"]
  STATUS --> D["Task Activity"]
  STATUS --> M["My Work"]
  STATUS --> A["Automation"]
  STATUS --> O["Overlay"]
```

Precedence is latest Execution → linked terminal-message context → legacy cache. Expired cache becomes `unknown` in the response only. `failed`, `cancelled`, `skipped`, and `succeeded` remain distinct in the UI.

## 13. Implemented and removed entry points

Cloud/App startup protocol:

- `start-requested` persists the Start fence.
- `runtime-start` records Runtime acceptance without claiming running.
- `dispatch-unknown` holds capacity when Start outcome is ambiguous.
- `dispatch-failed` is valid only for a proven pre-Start failure.
- Runtime events and trusted status queries are the only running and execution-terminal authorities.

Direct App dispatcher `complete`/`fail` entry points were removed. Heartbeat requires the exact execution/device/task identity and only extends the lease.

## 14. Acceptance matrix

| Scenario | Required result | Forbidden result |
| --- | --- | --- |
| Claimed, Start not sent | `starting` | `running` |
| Runtime accepted, no active turn yet | `waiting_runtime` | `starting` or `running` |
| Start response lost | `unknown`, capacity held | Same-row redelivery or duplicate run |
| First Runtime event | `running` with `observed_at/eventSeq` | Heartbeat-as-proof |
| Missing-sequence, duplicate, reordered, or post-terminal event | Execution and every downstream projection ignore it | Message/activity bypasses the truth gate |
| Cancel before Start | Immediate `cancelled` | Pointless Runtime cancel |
| Cancel after Start | `cancelling` until ACK/event | Immediate fake cancelled |
| Lease expires before Start | Same row queued, retry unchanged | Duplicate attempt |
| Lease expires after possible Start | Unknown, reconcile, hold capacity | Automatic failure/redelivery |
| Runtime failure and retry | Old row failed, new row queued | Old row changed back to queued |
| GET/page refresh | State unchanged | Read-time mutation |
| My Work/Queue/Detail/Automation | Same exact display state | Pending/claimed shown as running |
| Migration | ALTER existing table and create index only | Any new table |

## 15. Automated and manual verification

Automation must cover: no `create_table` migration, claim/identity/Start fence, event sequence, competing terminals, pre/post-Start cancellation, ambiguous dispatch, cloud/local recovery and reconciliation (including `running` plus `turnStatus`), new-attempt retry, same-transaction projections, pure GET, local IPC/store, UI mapping, and TypeScript/Rust compilation.

Manual acceptance sequence:

1. Run one cloud and one local task through `queued → starting → (optional waiting_runtime) → running → succeeded`.
2. Disconnect after Start and verify unknown appears without a second launch.
3. Cancel once while queued and once while running; verify immediate terminal versus cancelling-first behavior.
4. Produce a Runtime failure and verify retry preserves the old attempt and uses a new task ID.
5. Open Queue, Task Activity, My Work, Automation, and Overlay together and compare states.
6. Refresh and repeat GET requests; verify reads do not change state.
