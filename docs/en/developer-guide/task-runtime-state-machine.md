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
- External triggers such as page-visible, WebSocket reconnect, and queued-message-blocked adapt to `TaskStateMachine.checkHealth(reason)`.
- Pull only verifies task/runtime checkpoints and must not return message bodies; message content recovery stays on socket join/resume.
- Task detail snapshots only sync lifecycle fields; even if the response includes `subtasks`, messages must not be recovered or displayed from REST task detail.
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

The unified health-check entry point is `TaskStateMachine.checkHealth(reason)`:

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
- If the state machine is in `waiting_socket` for socket recovery, a terminal task detail snapshot may update runtime lifecycle state but must not move the machine to `ready`; messages still have to sync through socket `task:join`.

### Stream done

`chat:done` only means the current message stream ended. It does not prove the task lifecycle is terminal. If queued messages are still blocked after `chat:done`, `useChatStreamHandlers` calls the current task machine with `checkHealth('queued-message-blocked')` so the frontend converges back to the server state.

## Change Guidelines

When adding or changing task runtime UI:

- Do not use `selectedTaskDetail.status === 'RUNNING'` as the only runtime check.
- Prefer `useTaskStateMachine(taskId).derived`.
- Use the current task's `TaskStateMachine.checkHealth(reason)` for runtime checks. Use `taskStateManager.checkHealthAll(reason)` only for cross-task triggers.
- After refreshing task detail, feed the snapshot into the state machine through `taskStateManager.syncTaskDetail()`.
- Route WebSocket `task:status` events into the state machine through `taskStateManager.handleTaskStatus()`.
