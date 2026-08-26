---
sidebar_position: 19
---

# Project Execution State-of-Truth Refactoring

> Implementation status: the state-of-truth path and concurrency extension are complete; full Backend, Wework, and Executor regression, MySQL migration rollback/upgrade, and real Electron desktop acceptance have passed.
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
  subgraph Config["Existing configuration — no new table"]
    DEVICE["Runtime Settings<br/>D = maxConcurrentTasks<br/>single device-wide limit"]
    OBS["Live Runtime observation<br/>limit / active / active_task_ids / queued<br/>Local IPC; Cloud Redis TTL"]
    DOMAIN["Capacity domain<br/>owner_user_id + runtime_instance_id<br/>multiple routes share one domain"]
    ROBOT["loop_items.metadata<br/>R = max_concurrent_executions<br/>global per robot, default 1"]
  end
  subgraph Existing["Execution truth and projections — no new table"]
    EXEC["MySQL / SQLite loop_item_executions<br/>one row = one attempt<br/>persists runtime_instance_id at claim"]
    ITEM["loop_items<br/>workflow / Automation projection"]
    MSG["project_chat_messages<br/>text and activity projection"]
  end
  subgraph Claim["Canonical claim path"]
    LOCK["owner lock → runtime_instance lock"]
    DGATE{"Valid observation?<br/>O = Runtime active + durable reservations<br/>not present in active_task_ids<br/>O < D?"}
    RGATE{"Project-robot occupancy < R?<br/>manager has no agent gate"}
    SGATE{"execution_scope free?"}
    CAS["CAS queued → claimed<br/>write runtime_instance_id"]
    HOLD["Remain queued"]
  end
  subgraph Runtime["Physical Runtime concurrency"]
    START["Persist start_requested_at<br/>Start fence"]
    SCHED{"Runtime active tasks < D?"}
    WAIT["Accepted but queued in Runtime<br/>waiting_runtime"]
    RUN["Actually running"]
    OTHER["Normal chat / other Runtime tasks"]
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
  DEVICE --> OBS
  OBS --> DOMAIN
  DOMAIN --> LOCK
  DEVICE --> SCHED
  ROBOT --> RGATE
  EXEC -->|"claimed / running / cancel_requested"| DGATE
  LOCK --> DGATE
  DGATE -->|"no"| HOLD
  DGATE -->|"yes"| RGATE
  RGATE -->|"no"| HOLD
  RGATE -->|"yes"| SGATE
  SGATE -->|"no"| HOLD
  SGATE -->|"yes"| CAS
  CAS --> EXEC
  CAS --> START
  START --> SCHED
  OTHER --> SCHED
  SCHED -->|"no physical slot"| WAIT
  SCHED -->|"slot available"| RUN
  WAIT -->|"observed=accepted"| EXEC
  RUN -->|"identity + eventSeq / trusted callback"| EXEC
  EXEC -->|"same transaction"| ITEM
  EXEC -->|"same transaction"| MSG
  EXEC --> MAP
  MAP --> API
  API --> QUEUE
  API --> DETAIL
  API --> MYWORK
  API --> RULES
  API --> OVERLAY
```

The direction is one-way: Execution → Message/Automation/Workflow projections. A message, `metadata.ai_state`, board lane, or UI cannot decide Execution state.

`D` has one configuration source. Occupancy is neither the sum nor the maximum of two unrelated counters. It is merged by Runtime task identity: `O = Runtime active + durable capacity rows whose runtime_task_id is absent from active_task_ids`. A robot process visible to both layers is counted once, while manual Runtime work and claimed work not yet seen by Runtime are both retained. Runtime remains the hard physical limit for chat, robots, and automations together. “Run now” can only move a queued task to the front; it cannot start task D+1.

Capacity is live Runtime state and is never persisted into Device Kind as fact. Local claim reads it through App IPC. Cloud Runtime reports `limit/active/active_task_ids/queued/runtimeInstanceId` into the existing Redis online record under its TTL. Every active count must have one unique non-empty task ID. Missing, expired, incomplete, or mismatched observations stop claim. Claim APIs reject caller-supplied `deviceCapacity` and have no fixed-constant fallback.

`execution_device_id` is a transport route, not capacity identity. All local/app/socket routes for one installation share `owner_user_id + runtime_instance_id`; claim persists that identity in the existing execution row. Robot `R` is global by `agent_id` across routes and environments. `claimed`, `running`, `cancel_requested`, and `unknown` retain both device and robot capacity. Bound project runs with `R > 1` require a verified Git repository and a separate worktree per attempt; a non-isolatable workspace cannot enable parallel robot execution.

## 3. Zero-new-table model

One existing `loop_item_executions` row is one attempt. This concurrency migration adds only `runtime_instance_id` and the non-unique `idx_exec_runtime_capacity` index to the existing MySQL table; it contains no `CREATE TABLE`. Local SQLite alters the existing table, creates `ix_exec_runtime_capacity` after the column exists, and moves to schema version 7.

| Dimension             | Columns                                     | Meaning                                                                                                    |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Control               | `status`                                    | `pending_approval`, `queued`, `claimed`, `running`, `cancel_requested`, `completed`, `failed`, `cancelled` |
| Runtime observation   | `observed_state`, `observed_at`             | Latest verified Runtime state and evidence time                                                            |
| Sync health           | `sync_state`                                | `pending`, `in_sync`, `stale`, `diverged`                                                                  |
| Attempt causality     | `attempt_no`, `previous_execution_id`       | Attempt number and previous-attempt link                                                                   |
| Concurrency domain    | `execution_scope`                           | Project robot by task; manager by Automation Run                                                           |
| Start fence           | `claimed_at`, `start_requested_at`          | Separates a releasable claim from a Start that may have arrived                                            |
| Runtime identity      | `runtime_device_id`, `runtime_task_id`      | Task ID is deterministically `codex-queue-{execution.id}` and validated at every write                     |
| Capacity identity     | `runtime_instance_id`                       | Merges all routes by `owner_user_id + runtime_instance_id`                                                 |
| Event fence           | `last_event_seq`                            | Only a greater Runtime sequence is accepted                                                                |
| Cancellation/terminal | `cancel_requested_at`, `termination_reason` | Cancellation intent time and confirmed terminal reason                                                     |
| Control lease         | `heartbeat_at`, `lease_expires_at`          | Dispatcher/claim liveness, never standalone process proof                                                  |

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
  participant H as Redis Runtime Capacity TTL
  participant DB as loop_item_executions
  participant W as Celery Dispatch
  participant G as Runtime RPC Gateway
  participant R as Cloud Executor
  C->>H: read instance + limit/active/active_task_ids
  H-->>C: fresh identity-matching observation
  C->>C: owner lock → runtime_instance lock
  C->>DB: merge exact O; check O < D, agent < R, scope free
  C->>DB: CAS queued → claimed<br/>bind runtime_instance_id + codex-queue-{id}
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
  participant IPC as App IPC
  participant SQL as Local SQLite
  participant API as Runtime Work API
  participant R as Local Executor
  APP->>IPC: executions.claim_next without capacity
  IPC->>R: runtime.capacity.get
  R-->>IPC: limit/active/active_task_ids/queued
  IPC->>SQL: inject trusted capacity + runtime_instance_id
  SQL->>SQL: check O < D, agent < R, scope free<br/>CAS queued → claimed
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

## 11. Concurrency, capacity, and fairness

```mermaid
flowchart TD
  SCAN["Scan all queued rows by owner/device<br/>no fixed 16/32 candidate window"] --> OBS["Read fresh Runtime capacity<br/>instance + active_task_ids"]
  OBS --> OL["Acquire owner lock"]
  OL --> DL["Acquire runtime_instance lock"]
  DL --> MERGE["O = Runtime active<br/>+ durable task IDs absent from active_task_ids"]
  MERGE --> CAP{"O < D?"}
  CAP -->|no| END["Do not claim"]
  CAP -->|yes| PRI["Partition by priority"]
  PRI --> RR["Round-robin agents within priority<br/>FIFO within each agent"]
  RR --> AG{"Global agent occupancy < R?"}
  AG -->|no| NEXT["Skip this agent"]
  AG -->|yes| SP{"execution_scope occupied?"}
  SP -->|yes| NEXT
  SP -->|no| ISO{"Bound project and R > 1?"}
  ISO -->|yes| GIT["Verify Git at configuration and preflight<br/>one worktree per attempt"]
  ISO -->|no| CAS["CAS queued → claimed"]
  GIT -->|not isolatable| NEXT
  GIT -->|isolatable| CAS
  CAS -->|lost| NEXT
  CAS -->|won| SLOT["write runtime_instance_id<br/>claimed/running/cancel_requested/unknown occupy O and R"]
```

The fixed order is fresh observation → owner lock → Runtime-instance lock → database CAS. A batch CAS must update every selected row or roll back the whole batch; Runtime identity is never written onto a row that was not claimed. Unknown retains capacity. Higher priority runs first, while agents round-robin within a priority and remain FIFO internally, so a 20-item queue for one robot cannot starve another robot.

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

| Scenario                                                       | Required result                                       | Forbidden result                             |
| -------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Claimed, Start not sent                                        | `starting`                                            | `running`                                    |
| Runtime accepted, no active turn yet                           | `waiting_runtime`                                     | `starting` or `running`                      |
| Start response lost                                            | `unknown`, capacity held                              | Same-row redelivery or duplicate run         |
| First Runtime event                                            | `running` with `observed_at/eventSeq`                 | Heartbeat-as-proof                           |
| Missing-sequence, duplicate, reordered, or post-terminal event | Execution and every downstream projection ignore it   | Message/activity bypasses the truth gate     |
| Cancel before Start                                            | Immediate `cancelled`                                 | Pointless Runtime cancel                     |
| Cancel after Start                                             | `cancelling` until ACK/event                          | Immediate fake cancelled                     |
| Lease expires before Start                                     | Same row queued, retry unchanged                      | Duplicate attempt                            |
| Lease expires after possible Start                             | Unknown, reconcile, hold capacity                     | Automatic failure/redelivery                 |
| Runtime failure and retry                                      | Old row failed, new row queued                        | Old row changed back to queued               |
| GET/page refresh                                               | State unchanged                                       | Read-time mutation                           |
| My Work/Queue/Detail/Automation                                | Same exact display state                              | Pending/claimed shown as running             |
| Missing/expired/mismatched capacity heartbeat                  | Stop claiming and retain existing state               | Fixed or caller-supplied capacity fallback   |
| Runtime active and durable claim share a task ID               | Count once                                            | False-full double count                      |
| Manual Runtime task and not-yet-delivered durable claim differ | Count both in O                                       | `max()` undercount and over-claim            |
| One robot reaches R                                            | Other robots remain claimable fairly                  | Hot-robot starvation or route-based R bypass |
| Bound non-Git project requests R > 1                           | Reject at configuration and verify again at preflight | Concurrent execution in one shared directory |
| “Run now” while Runtime is full                                | Move to queue front and wait                          | Start task D+1                               |
| Migration                                                      | ALTER existing table and create index only            | Any new table                                |

## 15. Automated and manual verification

Automation must cover: no-`create_table` migration, capacity identity and heartbeat TTL, exact `active_task_ids` deduplication, D shared across device routes, global robot R, same-priority round-robin, no fixed candidate window, all-or-nothing batch CAS, non-Git concurrency rejection, Runtime hard limit and force-start, claim/identity/Start fence, event sequence, competing terminals, pre/post-Start cancellation, ambiguous dispatch, cloud/local recovery and reconciliation (including `running` plus `turnStatus`), new-attempt retry, same-transaction projections, pure GET, local IPC/store, UI mapping, and TypeScript/Rust compilation.

Manual acceptance sequence:

1. Run one cloud and one local task through `queued → starting → (optional waiting_runtime) → running → succeeded`.
2. Disconnect after Start and verify unknown appears without a second launch.
3. Cancel once while queued and once while running; verify immediate terminal versus cancelling-first behavior.
4. Produce a Runtime failure and verify retry preserves the old attempt and uses a new task ID.
5. Open Queue, Task Activity, My Work, Automation, and Overlay together and compare states.
6. Refresh and repeat GET requests; verify reads do not change state.
7. Set D to 2, mix normal chat and robot work, and verify physical active count never exceeds 2 while accepted work shows waiting_runtime.
8. Set one robot to R=2 and pull through two routes; verify it remains globally capped at 2 and another same-priority robot is not starved.
9. Verify R > 1 creates distinct worktrees for a Git project and is rejected at save time for a plain directory.
