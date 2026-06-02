---
sidebar_position: 1
---

# 任务运行态状态机统一设计

## 背景

当前聊天任务页存在多个局部状态源共同表达“任务是否还在运行”：

- `TaskContext.selectedTaskDetail.status` 保存任务生命周期状态。
- `TaskStateMachine.status` 保存消息流状态。
- `useChatStreamHandlers` 保存 `isAwaitingResponseStart`、`isLoading`、`isStopping` 等本地发送状态。
- `useMessageSendQueue` 保存 queued message 的阻塞和发送状态。
- `TaskContext` 与 `ChatStreamContext` 各自处理页面可见性和 WebSocket 重连恢复。

这些状态源没有统一的运行态转换边界。WebSocket 事件丢失、页面后台、浏览器节流、重连或事件乱序时，前端可能出现消息流已经结束，但任务详情仍显示 `RUNNING/PENDING` 的状态。结果是 queued message 被旧状态永久阻塞，用户看到的页面状态与服务端实际状态不一致。

## 目标

一个任务只应有一个前端运行态状态机。任务页所有运行态 UI 都从这个状态机派生，而不是在组件里直接组合多个局部状态。

设计目标：

1. 当前任务页最终收敛到服务端实际状态。
2. `RUNNING/PENDING/CANCELLING` 状态必须确保加入 task room 并恢复消息流。
3. `COMPLETED/FAILED/CANCELLED/DELETE` 状态必须清理所有运行中本地状态。
4. queued message 的发送阻塞只依赖统一运行态派生值。
5. 页面可见性、WebSocket 重连、任务切换、任务状态事件、消息流事件统一进入同一个 per-task state machine。
6. 第一阶段不要求新增后端协议，优先用现有 `task:join` ack、`getTaskDetail` 和任务状态事件完成统一。

## 非目标

本设计不在第一阶段引入全量周期轮询，不要求修改后端事件协议，也不重新设计消息渲染组件。后端 snapshot 接口和 event version 属于第二阶段增强。

## 核心模型

扩展现有 `TaskStateMachine`，使它不仅管理消息流，还管理任务 runtime lifecycle。

```ts
type TaskRuntimePhase =
  | 'unknown'
  | 'syncing'
  | 'running'
  | 'streaming'
  | 'waiting_for_user'
  | 'terminal'
  | 'error'

interface TaskRuntimeState {
  taskId: number
  phase: TaskRuntimePhase
  taskStatus?: TaskStatus
  joinedRoom: boolean
  activeStreamSubtaskId?: number
  lastSyncedAt?: number
  lastStatusUpdatedAt?: string
  recoveryReason?: TaskRecoveryReason
  recoveryError?: string
}

type TaskRecoveryReason =
  | 'task-selected'
  | 'page-visible'
  | 'websocket-reconnect'
  | 'task-status-event'
  | 'join-ack'
  | 'queued-message-blocked'
  | 'manual-refresh'
```

状态分类统一抽取：

```ts
const ACTIVE_EXECUTION_STATUSES = ['PENDING', 'RUNNING', 'CANCELLING'] as const
const TERMINAL_TASK_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'DELETE'] as const
const WAITING_FOR_USER_STATUSES = ['PENDING_CONFIRMATION'] as const
```

派生状态统一由 state machine 输出：

```ts
interface TaskRuntimeDerivedState {
  isExecutionActive: boolean
  isTerminal: boolean
  isStreaming: boolean
  shouldJoinRoom: boolean
  canSendMessage: boolean
  canQueueMessage: boolean
  canCancelTask: boolean
  blocksQueuedDispatch: boolean
}
```

## 状态转换规则

### Active execution

当 `taskStatus` 属于 `PENDING/RUNNING/CANCELLING`：

1. `phase` 进入 `running`，如果存在 active stream，则进入 `streaming`。
2. state machine 必须确保 task room 已加入。
3. room join ack 或恢复结果必须同步消息列表和 active stream。
4. UI 可以显示停止或等待状态。
5. queued message 在 active stream 或 awaiting response 时保持 queued，不直接发送。

### Terminal

当 `taskStatus` 属于 `COMPLETED/FAILED/CANCELLED/DELETE`：

1. `phase` 进入 `terminal`。
2. 清除 `activeStreamSubtaskId`。
3. 所有 streaming AI message 必须转成 completed、error 或 cancelled 的稳定状态。
4. 清理 `isAwaitingResponseStart`、`isLoading`、`isStopping` 等运行中本地状态。
5. queued message 不再被任务运行态阻塞，可以继续 dispatch 或允许用户取消。

### Waiting for user

当 `taskStatus` 为 `PENDING_CONFIRMATION`：

1. `phase` 进入 `waiting_for_user`。
2. 不显示 active stream。
3. 允许用户确认、继续发送或执行下一阶段动作。

### Stream done is not lifecycle terminal

`chat:done` 只代表当前 active stream 结束，不直接代表任务生命周期终态。收到 `chat:done` 后：

1. 清除当前 stream。
2. 保留或更新 message 状态。
3. 如果 `taskStatus` 仍是 active execution，进入 `running`。
4. 如果存在 queued message 且运行态仍阻塞发送，请求 runtime recovery。

## 事件入口

所有影响运行态的事件都进入 `TaskStateMachine.dispatch()`：

```ts
type TaskRuntimeEvent =
  | { type: 'TASK_SELECTED'; taskId: number; taskStatus?: TaskStatus }
  | { type: 'TASK_STATUS_RECEIVED'; taskStatus: TaskStatus; updatedAt?: string }
  | { type: 'TASK_DETAIL_SYNCED'; taskDetail: TaskDetail }
  | { type: 'JOIN_ACK_RECEIVED'; payload: TaskJoinAckPayload }
  | { type: 'CHAT_START'; subtaskId: number; shellType?: string; messageId?: number }
  | { type: 'CHAT_DONE'; subtaskId: number; result?: unknown; hasError?: boolean }
  | { type: 'CHAT_ERROR'; subtaskId: number; error: string }
  | { type: 'CHAT_CANCELLED'; subtaskId: number }
  | { type: 'PAGE_VISIBLE' }
  | { type: 'SOCKET_RECONNECTED' }
  | { type: 'QUEUED_MESSAGE_BLOCKED' }
```

`TaskContext` 继续负责任务列表和当前任务选择，但任务详情状态变化后要 dispatch `TASK_STATUS_RECEIVED` 或 `TASK_DETAIL_SYNCED`。`ChatStreamContext` 继续注册 socket event handler，但只负责把 `chat:*` 事件 dispatch 给对应 task state machine。

## 恢复编排

保留一个轻量的恢复触发器，但它不保存第二套状态。它只负责把外部触发转换成 state machine 事件，并执行 state machine 要求的副作用。

触发器可以命名为 `useTaskRuntimeRecovery`：

```ts
interface TaskRuntimeRecoveryApi {
  requestRecovery: (taskId: number, reason: TaskRecoveryReason) => void
  isRecovering: boolean
  lastRecoveryError?: string
}
```

恢复流程：

1. dispatch recovery reason 到对应 `TaskStateMachine`。
2. 如果 state machine 派生出 `shouldJoinRoom=true`，调用 `joinTask(taskId)`。
3. 将 join ack dispatch 为 `JOIN_ACK_RECEIVED`。
4. 调用 `refreshSelectedTaskDetail(false)` 同步当前任务详情。
5. 将详情 dispatch 为 `TASK_DETAIL_SYNCED`。
6. 必要时调用 `refreshTasks()` 更新侧边栏列表。

去重规则：

1. 同一 task 同一 reason 在短时间内只执行一次。
2. 已有 recovery in flight 时，后续 recovery 合并为一次 pending recovery。
3. `queued-message-blocked` 触发只刷新当前任务，不刷新任务列表。
4. `page-visible` 和 `websocket-reconnect` 可以刷新当前任务和任务列表。

## UI 派生规则

组件不再直接判断 `selectedTaskDetail.status === 'RUNNING'`。它们读取：

```ts
const { runtime, derived } = useTaskRuntimeState(taskId)
```

发送按钮：

```ts
if (derived.isStreaming && derived.canQueueMessage) show stop + queue
else if (derived.isStreaming) show stop
else if (derived.canCancelTask) show cancel
else show send
```

queued message：

```ts
if (derived.blocksQueuedDispatch) keep queued
else dispatch next queued message
```

当前任务结束：

```ts
if (derived.isTerminal) {
  clear awaiting response
  clear local pending user message
  unblock queued dispatch
}
```

## 前后台与重连

页面切回前台和 WebSocket reconnect 不再分别由 `TaskContext` 和 `ChatStreamContext` 各自恢复。统一规则：

1. 当前有 selected task 时，dispatch `PAGE_VISIBLE` 或 `SOCKET_RECONNECTED`。
2. state machine 根据当前 `taskStatus` 决定是否 join room 和是否同步详情。
3. 如果任务是 terminal，恢复动作会清理所有运行中状态。
4. 如果任务是 active execution，恢复动作会 join room 并同步 active stream。

第一阶段不引入常驻周期轮询。只有事件触发式 recovery：

- task selected
- page visible
- websocket reconnect
- queued message blocked
- task status event
- manual refresh

## 后端增强

第二阶段可以新增轻量 snapshot 接口：

```ts
GET /api/tasks/{taskId}/runtime-snapshot
```

返回：

```ts
interface TaskRuntimeSnapshot {
  task_id: number
  status: TaskStatus
  progress?: number
  updated_at: string
  active_stream: {
    active: boolean
    subtask_id?: number
    last_activity_at?: string
  }
  version?: number
  server_time: string
}
```

有了 snapshot 后，recovery 可以从多次请求收敛成一次请求。WebSocket 事件后续也可以带 `version`，客户端只接受比当前 snapshot 更新的事件。

## 迁移计划

第一阶段：

1. 抽取 task status classifier。
2. 扩展 `TaskStateMachine` 的 state data，加入 `runtime` 和 `derived`。
3. 将 `selectedTaskDetail` 状态同步 dispatch 到 state machine。
4. 将 queued message 是否阻塞改为读取 `derived.blocksQueuedDispatch`。
5. 将 `ChatStreamContext` 和 `TaskContext` 的页面可见性恢复合并到统一 recovery 入口。
6. 删除 queued blocked 的局部刷新补丁，改为 `requestRecovery('queued-message-blocked')`。

第二阶段：

1. 增加后端 runtime snapshot 接口。
2. recovery 从 `joinTask + getTaskDetail` 切换为优先 snapshot。
3. 给 WebSocket task events 增加 `version` 或 `updated_at` 判断。

## 测试要求

必须覆盖：

1. 任务为 `RUNNING` 时，state machine 要求 join room。
2. 任务变为 `COMPLETED` 时，state machine 清除 active stream 和 awaiting 状态。
3. `chat:done` 后 task status 仍为 `RUNNING` 时，不进入 terminal。
4. `chat:done` 后 queued message 被 active status 阻塞时，触发 recovery。
5. `TASK_DETAIL_SYNCED` 返回 terminal 后，queued message 解除阻塞。
6. 页面 visible 触发当前任务 runtime recovery。
7. WebSocket reconnect 触发当前任务 runtime recovery。
8. 多个 recovery reason 并发时只执行一次实际恢复。
9. `PENDING_CONFIRMATION` 进入 waiting for user，不显示 streaming，也不阻塞用户确认。

## 验收标准

1. 当前任务页长时间停留后，前端运行态最终能收敛到服务端任务状态。
2. 消息流状态和任务 lifecycle 状态由同一个 per-task state machine 派生。
3. UI 中不再散落直接用 `selectedTaskDetail.status` 判断运行态的逻辑。
4. queued message 不会因为漏掉一次 `task:status` 事件永久卡住。
5. 页面切回前台和 WebSocket reconnect 走同一套 recovery 入口。
