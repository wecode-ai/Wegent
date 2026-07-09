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

| 状态                          | 唯一信源                                                                                           | 派生值/使用方                                                                                          | 维护规则                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 消息内容与消息状态            | `useWorkbenchPaneSession.messages`                                                                 | `MessageList`、导出、文件变更、request user input                                                      | 只能通过 transcript reset 或 `reduceWorkbenchMessages` 更新                                                                      |
| assistant 是否正在输出        | `paneSession.status.isAssistantStreaming`                                                          | 桌面/移动 composer 的暂停按钮、关闭任务提示                                                            | 由 `messages` 中最后一个 `assistant + streaming` 消息派生，布局层不能自行扫描                                                    |
| 本地发送阶段                  | `sendPhase: idle/submitting/awaiting_assistant`                                                    | `status.isSubmitting`、`status.isWaitingForAssistantIndicator`、兼容字段 `sending/waitingForAssistant` | API 调用中为 `submitting`，请求被 runtime 接受后为 `awaiting_assistant`，收到 start/done/error 或 transcript 已结算后回到 `idle` |
| 当前 runtime 执行快照         | `getRuntimePaneTaskExecution(state.runtimeWork, address)`                                          | `status.taskExecution`、队列推进、`currentRuntimeTaskRunning`                                          | 只能从 `RuntimeWorkListResponse.localTasks[].running/status` 读取                                                                |
| pane 是否忙碌                 | `paneSession.status.isBusy`                                                                        | 当前 pane 队列是否可推进                                                                               | 由 `isSubmitting`、`isAwaitingAssistant`、`isAssistantStreaming`、`taskExecution.running` 合成                                   |
| 队列消息                      | `queuedMessages`                                                                                   | `ConversationQueuePanel`、自动发送下一条 follow-up                                                     | 只在 pane session 内增删改；推进条件必须使用 `status.canSendQueuedMessage`                                                       |
| 引导消息                      | `queuedMessages` + `messages` 中的本地 user message                                                | `ConversationQueuePanel`、`MessageList`                                                                | 发送引导时先把队列消息标记为 sending，再立即在当前 streaming assistant 位置插入本地 user message；不能等引导 RPC 返回后再插入    |
| transcript 加载与分页         | `transcriptLoading`、`transcriptHasMoreBefore`、`transcriptBeforeCursor`、`loadedTranscriptRanges` | 滚动加载、turn navigation                                                                              | 只由 transcript API 响应更新                                                                                                     |
| runtime goal                  | `threadGoal` + `pendingGoalState`                                                                  | goal bar、goal draft、首条消息 initial goal                                                            | 已持久化目标来自 runtime goal API；新建任务前目标暂存在 pending seed                                                             |
| request user input 已处理集合 | `answeredRequestUserInputIds`                                                                      | 隐藏已响应/忽略的 request user input 卡片                                                              | 只由提交或忽略动作更新                                                                                                           |
| 模型上下文用量                | Codex `thread/tokenUsage/updated` runtime stream 事件；`runtime.tasks.transcript.contextUsage`       | composer 右下角上下文窗口用量圆环和 tooltip                                                            | executor 必须原样转发 Codex token usage notification，并在历史 transcript 响应中从同一 rollout 读取最新 token count；UI 只按当前 runtime task 保存到 `projectChat.contextUsage` |
| 附件/模型/技能选择            | `projectChat` context                                                                              | send payload、composer 控件                                                                            | 当前 LocalTask 内选项锁定由 `projectChat.isOptionsLocked` 派生                                                                   |
| 设备可用性                    | `state.devices` + 当前任务/项目设备选择                                                            | composer disabled reason、设备提示                                                                     | 只用于发送前置条件，不参与 assistant streaming 判断                                                                              |

## Runtime 事件流

1. 新消息提交时，`sendPhase` 进入 `submitting`。
2. runtime 接受请求后，`sendPhase` 进入 `awaiting_assistant`。
3. `chat:start` 转换为 `assistant_started`，消息 reducer 创建/更新 assistant streaming 消息，`sendPhase` 回到 `idle`。
4. `chat:chunk` 和 block 事件只更新 `messages`。
5. Codex `thread/tokenUsage/updated` 事件只更新 `projectChat.contextUsage`，不能创建空消息，也不能写入 transcript。
6. 打开历史任务时，`runtime.tasks.transcript.contextUsage` 只恢复当前任务的 `projectChat.contextUsage`，不能通过额外 UI fallback 重新扫描消息或任务列表。
7. `chat:done`、`chat:error`、取消事件通过 reducer 结算 assistant 消息，并触发 work list 刷新。
8. 如果 runtime work 与消息状态不一致，不做兜底结算；必须修正缺失的 stream event、transcript 数据或 reducer action。

## 引导消息顺序

运行中的 Codex LocalTask 支持把队列消息作为原生引导发送。引导是当前 turn 内的用户输入，不是新的 follow-up turn，所以 UI 必须在发送开始时就把本地用户消息插入到当前 assistant 中间：

1. 将对应 `queuedMessages` 项标记为 `sending`，提示文案为“正在引导当前对话”。
2. 用同一个本地消息 id 和 `createdAt` 创建 user message，并把当前 streaming assistant 拆成两段。
3. 引导前 assistant 冻结为 done，移除 `subtaskId`，后续 stream 不再写入它。
4. 引导后 assistant 继续保留原 `subtaskId`，并先放入一条 `conversation_guidance` tool block，用于标记引导位置。
5. 后续 `chat:chunk` 和 `chat:done` 可能携带完整文本，必须按拆分时记录的 assistant 文本前缀裁剪后再进入 reducer。

不要把引导成功后的 user message append 到对话底部，也不要等 `runtime.tasks.guidance` 返回后才拆分 assistant；这会让引导请求等待期间产生的 assistant 文本出现在用户引导消息之前，造成流式显示和刷新后 transcript 顺序不一致。

## 右侧临时聊天

右侧工作区的“临时聊天”用于在当前 Codex 本地线程旁边发起一次短对话。它不是 fork，也不是左侧任务列表中的普通 runtime task：

- 每个临时聊天 tab 都有独立的 `chat:<id>` 实例标识，允许在右侧工作区同时打开多个临时聊天。
- UI 状态保存在 `TemporaryChatPanel` 内部，并以实例标识作为未创建 runtime 线程前的 `conversationKey`；切换 tab 时不能丢失本地消息和输入状态。
- 临时聊天的 runtime stream 订阅归 tab 生命周期管理，不能绑定到 `TemporaryChatPanel` 的 React effect cleanup。Activity 隐藏 inactive pane 或 tab 时会暂停组件 effect，但临时聊天的 AI 回复仍必须继续进入对应 tab 的消息 reducer；只有关闭临时聊天 tab 时才释放订阅。
- 首条消息通过 `createTemporaryRuntimeTask` 创建 `ephemeral` runtime task，并携带当前主线程的 `sideSource`。该任务不写入左侧任务列表，也不触发主 pane 导航。
- 后续消息必须继续使用已加载的临时线程。Codex app-server 路径使用 `direct_thread_id` 直接 `turn/start`，不能走普通 `resume_thread_id` 的 `thread/resume` 路径，否则会因为临时线程没有 rollout 映射而出现 `no rollout found`。
- 临时聊天只复用当前工作区和当前线程上下文；如果没有可用的主线程 source，应阻止发送并提示用户先打开已有对话。

维护规则：不要用 fallback 在 UI 里把临时聊天补进左侧任务列表，也不要在 executor 中为临时线程伪造 rollout。临时聊天的主路径是 `ephemeral + sideSource + direct_thread_id`。

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
