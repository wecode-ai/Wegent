---
sidebar_position: 21
---

# Task Runtime State Machine

## Background

A task page can stay open in the browser background for a long time. Browser throttling, WebSocket reconnects, out-of-order events, or missed events can make the frontend runtime state diverge from the server state. One common symptom is a server-side terminal task that still appears as `RUNNING` locally, leaving a queued message blocked.

Wegent uses one `TaskStateMachine` per task as the unified source of truth for task runtime lifecycle and message stream state. Components should not independently combine `selectedTaskDetail.status`, streaming flags, and local loading state.

## Principles

- `TaskStateMachine` is the single source of truth for task runtime state.
- `TaskContext` feeds task status events and task detail snapshots into the state machine.
- `ChatStreamContext` only routes `chat:*` WebSocket events to the corresponding task state machine.
- External triggers such as page-visible, WebSocket reconnect, and queued-message-blocked adapt to `TaskStateMachine.requestRuntimeCheck(reason)`.
- Pull only verifies task/runtime checkpoints and must not return message bodies; message content recovery stays on socket join/resume.
- UI controls read `runtime` and `derived` values from `useTaskStateMachine()`.

## Runtime Classification

Task statuses are classified by `taskStatusClassifier`:

| Category         | Statuses                                     | Runtime phase            |
| ---------------- | -------------------------------------------- | ------------------------ |
| Active execution | `PENDING`, `RUNNING`, `CANCELLING`           | `running` or `streaming` |
| Terminal         | `COMPLETED`, `FAILED`, `CANCELLED`, `DELETE` | `terminal`               |
| Waiting for user | `PENDING_CONFIRMATION`                       | `waiting_for_user`       |
| Unknown          | Missing or unknown status                    | `unknown`                |

The state machine exposes `derived` flags for UI decisions:

- `blocksQueuedDispatch`: whether queued messages must remain blocked.
- `canQueueMessage`: whether user input can be queued.
- `canCancelTask`: whether the task can be cancelled.
- `isTerminal`: whether the task is terminal.
- `shouldJoinRoom`: whether an active task needs to join its task room.

## Health Check Entry Point

The public runtime-check entry point is `TaskStateMachine.requestRuntimeCheck(reason)`:

1. Call the lightweight `runtime-check` pull endpoint to read task status and active stream cursor.
2. Let the state machine compare the local runtime checkpoint and decide whether to join, resume, or clear local stream state.
3. If message content must be recovered, use socket join/resume only.
4. `TaskContext` may refresh task detail/list after page-visible and websocket-reconnect, but it does not own recovery policy.

Supported health-check reasons include:

- `page-visible`
- `websocket-reconnect`
- `queued-message-blocked`
- `task-selected`
- `manual-refresh`
- `network-online`
- `runtime-instability-probe`

## Stable And Unstable Convergence

The state machine has two paths:

- Normal path: server events arrive completely, and the state machine advances through `chat:start`, `chat:chunk`, `chat:done`, `chat:error`, `chat:cancelled`, and `task:status`. States on this path are stable and can be consumed directly by the UI.
- Exceptional path: key events are missed, cancel ack events are lost, the socket reconnects, or local runtime state diverges from server state. After entering an unstable state, the internal `RuntimeStabilityProbe` uses one grace window before running the same runtime-check flow, pulls server task status and active stream checkpoints through `runtime-check`, and lets the state machine converge back to a stable state.

`RuntimeStabilityProbe` only owns scheduling and retrying checks. It does not own concrete transition logic. The check result is still consumed by the state machine, which performs the actual state transition. After each state change, the state machine resyncs the probe when needed. If a check fails and the unstable condition still exists, the probe is armed again so the state machine does not get stuck after a single failed attempt.

There is one internal probe scenario:

- `runtime-instability-probe`: the local runtime is in an unstable window. This includes a `RUNNING` task with no known active stream and no server confirmation that the stream is absent, or a user stop where local state still has an active stream and the task is not terminal. The probe waits one 3-second grace window before checking so late socket events are not treated as missing too early.

This delay only triggers a state-machine runtime check. It does not let the UI or socket layer decide success or failure directly. External triggers such as page-visible, WebSocket reconnect, queued-message-blocked, manual refresh, and network-online still call `requestRuntimeCheck(reason)` directly without maintaining separate delayed branches.

## Consistency Rules

### Active execution

When a task is active:

- The state machine should ensure the task room is joined.
- The join ack syncs messages and the active stream.
- Queued messages stay blocked until `blocksQueuedDispatch` becomes `false`.

### Terminal

When a task becomes terminal:

- Clear the active stream and streaming subtask.
- Finalize streaming messages as completed, error, or cancelled.
- Clear running local state such as `isStopping`.
- Unblock queued messages from task runtime state.

### Stream done

`chat:done` only means the current message stream ended. It does not prove the task lifecycle is terminal. If queued messages are still blocked after `chat:done`, `useChatStreamHandlers` calls the current task machine with `requestRuntimeCheck('queued-message-blocked')` so the frontend converges back to the server state.

## Change Guidelines

When adding or changing task runtime UI:

- Do not use `selectedTaskDetail.status === 'RUNNING'` as the only runtime check.
- Prefer `useTaskStateMachine(taskId).derived`.
- Use the current task's `TaskStateMachine.requestRuntimeCheck(reason)` for runtime checks. Route page-visible, WebSocket reconnect, network-online, manual-refresh, and queued-message-blocked triggers through the task session or runtime signal bridge so the owning machine performs the check.
- After refreshing task detail, feed the snapshot into the state machine through `taskStateManager.syncTaskDetail()`.
- Route WebSocket `task:status` events into the state machine through `taskStateManager.handleTaskStatus()`.
