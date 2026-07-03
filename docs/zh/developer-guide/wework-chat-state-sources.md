---
sidebar_position: 18
---

# Wework 聊天状态信源

本文记录 Wework 聊天链路的状态信源和维护规则。目标是让 UI 只读取明确的单一派生状态，避免发送按钮、消息流、队列和 runtime 任务状态互相覆盖。

## 核心原则

1. `useWorkbenchPaneSession` 是聊天 pane 的状态边界。
2. `paneSession.status` 是布局层判断聊天运行态的唯一入口。
3. `runtimePaneMessages.ts` 只负责把 runtime stream 事件转换成 message action，不再承载 UI 状态判断。
4. `runtimePaneStatus.ts` 负责从消息、发送阶段和 runtime work 执行快照派生运行态。
5. 兼容字段 `paneSession.sending` 和 `paneSession.waitingForAssistant` 只能由 `paneSession.status` 派生，不能再独立写入。

## 状态信源清单

| 状态 | 唯一信源 | 派生值/使用方 | 维护规则 |
| --- | --- | --- | --- |
| 消息内容与消息状态 | `useWorkbenchPaneSession.messages` | `MessageList`、导出、文件变更、request user input | 只能通过 transcript reset 或 `reduceWorkbenchMessages` 更新 |
| assistant 是否正在输出 | `paneSession.status.isAssistantStreaming` | 桌面/移动 composer 的暂停按钮、关闭任务提示 | 由 `messages` 中最后一个 `assistant + streaming` 消息派生，布局层不能自行扫描 |
| 本地发送阶段 | `sendPhase: idle/submitting/awaiting_assistant` | `status.isSubmitting`、`status.isWaitingForAssistantIndicator`、兼容字段 `sending/waitingForAssistant` | API 调用中为 `submitting`，请求被 runtime 接受后为 `awaiting_assistant`，收到 start/done/error 或 transcript 已结算后回到 `idle` |
| 当前 runtime 执行快照 | `getRuntimePaneTaskExecution(state.runtimeWork, address)` | `status.taskExecution`、队列推进、`currentRuntimeTaskRunning` | 只能从 `RuntimeWorkListResponse.localTasks[].running/status` 读取 |
| pane 是否忙碌 | `paneSession.status.isBusy` | 当前 pane 队列是否可推进 | 由 `isSubmitting`、`isAwaitingAssistant`、`isAssistantStreaming`、`taskExecution.running` 合成 |
| 队列消息 | `queuedMessages` | `ConversationQueuePanel`、自动发送下一条 follow-up | 只在 pane session 内增删改；推进条件必须使用 `status.canSendQueuedMessage` |
| 引导消息 | `guidanceMessages` | `ConversationQueuePanel` | 当前为 pane-local 状态，不能参与 composer 运行态判断 |
| transcript 加载与分页 | `transcriptLoading`、`transcriptHasMoreBefore`、`transcriptBeforeCursor`、`loadedTranscriptRanges` | 滚动加载、turn navigation | 只由 transcript API 响应更新 |
| runtime goal | `threadGoal` + `pendingGoalState` | goal bar、goal draft、首条消息 initial goal | 已持久化目标来自 runtime goal API；新建任务前目标暂存在 pending seed |
| request user input 已处理集合 | `answeredRequestUserInputIds` | 隐藏已响应/忽略的 request user input 卡片 | 只由提交或忽略动作更新 |
| 附件/模型/技能选择 | `projectChat` context | send payload、composer 控件 | 当前 LocalTask 内选项锁定由 `projectChat.isOptionsLocked` 派生 |
| 设备可用性 | `state.devices` + 当前任务/项目设备选择 | composer disabled reason、设备提示 | 只用于发送前置条件，不参与 assistant streaming 判断 |

## Runtime 事件流

1. 新消息提交时，`sendPhase` 进入 `submitting`。
2. runtime 接受请求后，`sendPhase` 进入 `awaiting_assistant`。
3. `chat:start` 转换为 `assistant_started`，消息 reducer 创建/更新 assistant streaming 消息，`sendPhase` 回到 `idle`。
4. `chat:chunk` 和 block 事件只更新 `messages`。
5. `chat:done`、`chat:error`、取消事件通过 reducer 结算 assistant 消息，并触发 work list 刷新。
6. 如果 runtime work 与消息状态不一致，不做兜底结算；必须修正缺失的 stream event、transcript 数据或 reducer action。

## 审核结果

- 桌面和移动布局不再直接扫描 `messages` 判断是否 streaming，统一读取 `paneSession.status.isAssistantStreaming`。
- composer 禁用状态不再读取独立 `paneSession.sending`，统一读取 `paneSession.status.isSubmitting`。
- 消息等待指示不再拼接 `sending || waitingForAssistant`，统一读取 `paneSession.status.isWaitingForAssistantIndicator`。
- 队列推进不再使用散落的 `currentRuntimeTask && !busy`，统一读取 `paneSession.status.canSendQueuedMessage`。
- `currentRuntimeTaskRunning` 改为通过 `getRuntimePaneTaskExecution` 派生，避免重复实现 runtime running 读取逻辑。
- `runtimePaneMessages.ts` 删除了 active assistant 查询逻辑，状态查询集中到 `runtimePaneStatus.ts`。

## 后续维护规则

- 新增聊天运行态时，先扩展 `RuntimePaneStatus`，再由布局或组件读取。
- 不要在布局层重新计算 `assistant streaming`、`busy`、`can send queued message`。
- 不要新增独立的 `isSending`、`isRunning`、`isStreaming` React state；除非它是新的外部事实信源，并且写入本表。
- runtime work 与消息状态冲突时，不允许在 UI 组件里临时覆盖显示，也不允许新增 fallback 结算；必须修主路径。
