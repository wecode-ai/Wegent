---
sidebar_position: 21
---

# 任务运行态状态机

## 背景

任务页可能长时间停留在浏览器后台。浏览器节流、WebSocket 重连、事件乱序或遗漏都可能导致前端看到的运行态和服务端实际状态不一致，例如服务端任务已经结束，但页面仍保留 `RUNNING` 或 queued message 阻塞状态。

Wegent 前端使用每个任务一个 `TaskStateMachine` 作为任务运行态和消息流的统一状态源，避免组件各自组合 `selectedTaskDetail.status`、streaming flags 和本地 loading 状态。

## 核心原则

- `TaskStateMachine` 是任务运行态的单一来源。
- `TaskContext` 负责把任务状态事件和任务详情快照输入状态机。
- `ChatStreamContext` 只负责把 `chat:*` WebSocket 事件路由给对应任务状态机。
- 页面可见、WebSocket 重连、queued message 卡住等外部触发只适配为 `TaskStateMachine.requestRuntimeCheck(reason)`。
- pull 只校验 task/runtime checkpoint，不返回 message body；消息内容恢复仍然只走 socket join/resume。
- UI 控件只读取 `useTaskStateMachine()` 返回的 `runtime` 和 `derived` 派生值。

## 运行态分类

任务状态通过 `taskStatusClassifier` 统一分类：

| 分类             | 状态                                         | 运行态                   |
| ---------------- | -------------------------------------------- | ------------------------ |
| Active execution | `PENDING`, `RUNNING`, `CANCELLING`           | `running` 或 `streaming` |
| Terminal         | `COMPLETED`, `FAILED`, `CANCELLED`, `DELETE` | `terminal`               |
| Waiting for user | `PENDING_CONFIRMATION`                       | `waiting_for_user`       |
| Unknown          | 未知或缺失状态                               | `unknown`                |

状态机输出的 `derived` 字段用于 UI 判断：

- `blocksQueuedDispatch`: queued message 是否必须继续阻塞。
- `canQueueMessage`: 当前是否允许把用户输入加入队列。
- `canCancelTask`: 当前是否允许取消任务。
- `isTerminal`: 当前任务是否已经进入终态。
- `shouldJoinRoom`: active execution 状态下是否需要加入 task room。

## 健康检查入口

公开的运行态检查入口是 `TaskStateMachine.requestRuntimeCheck(reason)`：

1. 调用轻量 `runtime-check` pull 接口，获取 task 状态和 active stream cursor。
2. 状态机对比本地 runtime checkpoint，判断是否需要 join/resume/清理本地 stream。
3. 如果需要补消息内容，只通过 socket join/resume 完成。
4. `TaskContext` 可在 page-visible 和 websocket-reconnect 后刷新 task detail/list，但不负责恢复策略。

WebSocket 连接恢复也由状态机按这个顺序统一处理：外部触发（例如 page-visible 或 network-online）先进入 `requestRuntimeCheck(reason)`，状态机先调用 `runtime-check`。只有当检查结果显示需要 socket join/resume，且当前 socket 未连接时，状态机才触发连接能力并进入 `waiting_socket`，等待 WebSocket 恢复后再通过同一套 `websocket-reconnect` 检查继续收敛。

当前健康检查原因包括：

- `page-visible`
- `websocket-reconnect`
- `queued-message-blocked`
- `task-selected`
- `manual-refresh`
- `network-online`
- `runtime-instability-probe`

## 稳态和非稳态收敛

状态机有两类路径：

- 正常路径：服务端事件完整到达，状态机通过 `chat:start`、`chat:chunk`、`chat:done`、`chat:error`、`chat:cancelled` 和 `task:status` 推进。路径内的状态都应能直接被 UI 消费。
- 异常路径：关键事件缺失、取消 ack 丢失、断线重连或本地状态和服务端状态不一致。状态机进入非稳态后，内部 `RuntimeStabilityProbe` 使用统一 grace window 延迟运行同一套 runtime-check 流程，通过 `runtime-check` 拉取服务端 task status 和 active stream checkpoint，再回到稳定状态。

`RuntimeStabilityProbe` 只负责调度和重试检查，不耦合具体状态转换逻辑。检查结果仍由状态机统一消费并转换状态。每次状态变化后，状态机会在需要时重新同步 probe；如果检查失败且非稳态仍存在，probe 会重新布置下一次检查，避免只触发一次后永久卡住。

当前内部 probe 只有一个场景：

- `runtime-instability-probe`：本地运行态处于不稳定窗口，包括任务 `RUNNING` 但还没有 active stream 且服务端未确认无流，或用户已经停止流式响应但本地仍有 active stream 且任务未进入终态。probe 使用统一 3 秒 grace window 后检查，避免过早把延迟到达的 socket 事件误判为丢失事件。

这个延迟只触发状态机运行态检查，不直接在 UI 或 socket 层判定成功失败。页面可见、WebSocket 重连、queued message 卡住、手动刷新和网络恢复等外部触发仍然直接调用 `requestRuntimeCheck(reason)`，不再维护额外的延迟分支。

## 一致性规则

### Active execution

当任务处于 active execution：

- 状态机应确保 task room 已加入。
- join ack 会同步消息列表和 active stream。
- queued message 不直接发送，直到 `blocksQueuedDispatch` 变为 `false`。

### Terminal

当任务进入 terminal：

- 清理 active stream 和 streaming subtask。
- 将仍在 streaming 的消息固化为 completed、error 或 cancelled。
- 清理 `isStopping` 等运行中状态。
- 解除 queued message 的运行态阻塞。

### Stream done

`chat:done` 只表示当前消息流结束，不等价于任务生命周期终态。若 `chat:done` 后运行态仍阻塞 queued message，`useChatStreamHandlers` 会触发当前任务状态机的 `requestRuntimeCheck('queued-message-blocked')`，让前端重新对齐服务端状态。

### 取消与状态收敛

运行时任务取消必须同时收敛两类状态：

- executor 暴露的运行时任务状态，例如 `runtime.tasks.list` 返回的 `running` 和 `status`，用于侧边栏运行标记、关闭保护和任务列表。
- 当前 pane 内的消息流状态，例如仍处于 `assistant:streaming` 的消息，用于输入框停止按钮、发送锁和本地流式 UI。

取消流程必须遵循以下规则：

- executor 收到 `runtime.tasks.cancel` 后必须中断当前 turn，并等待 app-server 或子进程实际退出；如果超过超时时间仍未退出，应返回 `cancel_timeout`，前端不能把它当作已停止。
- Codex app-server 这类会派生子进程的运行器必须按进程组管理和终止，避免只停止父进程而后台 worker 继续执行。
- 前端收到已接受的取消结果后，必须刷新 runtime work 列表，让侧边栏和关闭保护看到 `running: false`。
- pane session 必须把本地仍在 streaming 的 assistant 消息固化为 cancelled，因为取消不一定会产生正常的 `chat:done` 或 response completed 事件。
- 只更新 runtime work 会导致输入框仍显示运行中；只更新消息流会导致侧边栏仍显示运行中。两类状态必须在同一个停止路径里同时更新。

## 修改指南

新增或修改任务运行态 UI 时：

- 不要直接以 `selectedTaskDetail.status === 'RUNNING'` 作为唯一判断。
- 优先读取 `useTaskStateMachine(taskId).derived`。
- 需要校验状态时调用当前任务的 `TaskStateMachine.requestRuntimeCheck(reason)`；页面可见、WebSocket 重连、网络恢复、手动刷新和 queued message 卡住等触发应通过 task session 或 runtime signal bridge 路由给对应状态机。
- 任务详情刷新后必须通过 `taskStateManager.syncTaskDetail()` 进入状态机。
- WebSocket `task:status` 事件必须通过 `taskStateManager.handleTaskStatus()` 进入状态机。
