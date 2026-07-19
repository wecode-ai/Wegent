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

| 状态                          | 唯一信源                                                                                           | 派生值/使用方                                                                                          | 维护规则                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 消息内容与消息状态            | `useWorkbenchPaneSession.messages`                                                                 | `MessageList`、导出、文件变更、request user input                                                      | 只能通过 transcript reset 或 `reduceWorkbenchMessages` 更新                                                                                                                     |
| assistant 是否正在输出        | `paneSession.status.isAssistantStreaming`                                                          | 桌面/移动 composer 的暂停按钮、关闭任务提示                                                            | 由 `messages` 中最后一个 `assistant + streaming` 消息派生，布局层不能自行扫描                                                                                                   |
| 本地发送阶段                  | `sendPhase: idle/submitting/awaiting_assistant`                                                    | `status.isSubmitting`、`status.isWaitingForAssistantIndicator`、兼容字段 `sending/waitingForAssistant` | API 调用中为 `submitting`，请求被 runtime 接受后为 `awaiting_assistant`，收到 start/done/error 或 transcript 已结算后回到 `idle`                                                |
| 当前 runtime 执行快照         | `getRuntimePaneTaskExecution(state.runtimeWork, address)`                                          | `status.taskExecution`、队列推进、`currentRuntimeTaskRunning`                                          | 只能从 `RuntimeWorkListResponse.localTasks[].running/status` 读取                                                                                                               |
| pane 是否忙碌                 | `paneSession.status.isBusy`                                                                        | 当前 pane 队列是否可推进                                                                               | 由 `isSubmitting`、`isAwaitingAssistant`、`isAssistantStreaming`、`taskExecution.running` 合成                                                                                  |
| 队列消息                      | `queuedMessages`                                                                                   | `ConversationQueuePanel`、自动发送下一条 follow-up                                                     | 只在 pane session 内增删改；推进条件必须使用 `status.canSendQueuedMessage`                                                                                                      |
| 引导消息                      | `queuedMessages` + `messages` 中的本地 user message                                                | `ConversationQueuePanel`、`MessageList`                                                                | 发送引导时先把队列消息标记为 sending，再立即在当前 streaming assistant 位置插入本地 user message；不能等引导 RPC 返回后再插入                                                   |
| transcript 加载与分页         | `transcriptLoading`、`transcriptHasMoreBefore`、`transcriptBeforeCursor`、`loadedTranscriptRanges` | 滚动加载、turn navigation                                                                              | 只由 transcript API 响应更新                                                                                                                                                    |
| runtime goal                  | `threadGoal` + `pendingGoalState`                                                                  | goal bar、goal draft、首条消息 initial goal                                                            | 已持久化目标来自 runtime goal API；新建任务前目标暂存在 pending seed                                                                                                            |
| request user input 已处理集合 | `answeredRequestUserInputIds`                                                                      | 隐藏已响应/忽略的 request user input 卡片                                                              | 只由提交或忽略动作更新                                                                                                                                                          |
| 模型上下文用量                | Codex `thread/tokenUsage/updated` runtime stream 事件；`runtime.tasks.transcript.contextUsage`     | composer 右下角上下文窗口用量圆环和 tooltip                                                            | executor 必须原样转发 Codex token usage notification，并在历史 transcript 响应中从同一 rollout 读取最新 token count；UI 只按当前 runtime task 保存到 `projectChat.contextUsage` |
| 长回复正文与工具输出          | `reduceWorkbenchMessages` 的预览窗口；`runtime.tasks.transcript` 的截断字段与完整加载标记          | `MessageList`、processing block、Debug Panel 内存摘要                                                  | 默认 resident `messages` 只保留尾部预览、原始长度和加载引用；只有用户显式加载完整 transcript 后，当前 pane 才能升级为完整态并替换 `messages`                                    |
| 附件/模型/技能选择            | `projectChat` context                                                                              | send payload、composer 控件                                                                            | 当前 LocalTask 内选项锁定由 `projectChat.isOptionsLocked` 派生                                                                                                                  |
| 设备可用性                    | `state.devices` + 当前任务/项目设备选择                                                            | composer disabled reason、设备提示                                                                     | 只用于发送前置条件，不参与 assistant streaming 判断                                                                                                                             |

## Runtime 事件流

1. 新消息提交时，`sendPhase` 进入 `submitting`。
2. runtime 接受请求后，`sendPhase` 进入 `awaiting_assistant`。
3. `chat:start` 转换为 `assistant_started`，消息 reducer 创建/更新 assistant streaming 消息，`sendPhase` 回到 `idle`。
4. `chat:chunk` 和 block 事件只更新 `messages`。
5. Codex `thread/tokenUsage/updated` 事件只更新 `projectChat.contextUsage`，不能创建空消息，也不能写入 transcript。
6. 打开历史任务时，`runtime.tasks.transcript.contextUsage` 只恢复当前任务的 `projectChat.contextUsage`，不能通过额外 UI fallback 重新扫描消息或任务列表。
7. `chat:done`、`chat:error`、取消事件通过 reducer 结算 assistant 消息，并触发 work list 刷新。
8. 如果 runtime work 与消息状态不一致，不做兜底结算；必须修正缺失的 stream event、transcript 数据或 reducer action。

### 网页搜索工具块

Codex 的网页搜索在 `item/started` 时可能还没有查询动作，在 `item/completed` 时才提供最终的 `action`。executor 必须用相同 block id 发出更新，把状态结算为 `done`，并将最终 `action` 写入 `tool_input`；否则 Wework 会一直显示“正在搜索网页”，展开后也没有内容。实时事件和历史 transcript 必须生成一致的 `web_search` 工具块。

Wework 展示层兼容 Responses API 的 snake_case 动作名（如 `open_page`、`find_in_page`）和 Codex app-server 的 camelCase 动作名（如 `openPage`、`findInPage`）。动作名差异只能在工具详情解析边界处理，不能通过 UI 占位内容或状态兜底掩盖缺失的完成事件。

## Goal 与任务执行状态

Goal 条的运行态必须受当前 runtime task 的执行快照约束：当 App Server 明确返回当前任务 `running: false` 时，仍为 `active` 的 goal 在 UI 中必须派生为 `paused`，并停止累计显示的耗时。这避免在重新打开已中断任务时，goal 继续显示“进行中”并计时。

- 仅当 `running` 是明确的布尔值时，任务执行状态才是已知状态；缺失该字段意味着状态尚不确定，不能据此暂停 goal。
- 此派生只影响 Wework 的展示与计时，不会自动调用 goal 暂停接口。用户点击“暂停目标”才会持久化 `paused` 状态。
- 任务重新处于 `running: true` 时，goal 继续使用 runtime goal API 返回的原始状态。

## Composer 模式提示

当 composer 处于计划模式或目标草稿模式时，底部模式胶囊必须在标签左侧显示对应的语义图标：计划模式使用清单图标，目标草稿使用靶心图标。桌面和紧凑布局必须复用同一个模式胶囊实现，确保表达一致。

模式胶囊的取消按钮仅在悬停时显示，并绝对定位覆盖左侧图标；原图标在同一状态下淡出。不要通过展开取消按钮或额外边距改变胶囊宽度，否则标签会发生横向跳动。

## 长输出内存边界

Wework 的聊天 UI 不能把持续输出的完整正文长期保存在 React state 中。`WorkbenchMessage.content`、thinking/text/plan block 的 `content`、tool block 的 `toolOutput` 都必须通过统一的预览窗口进入 `messages`：

- 实时 stream 事件进入 `reduceWorkbenchMessages` 后，超过阈值的正文只保留尾部预览，并写入 `contentTruncated`、`contentOriginalChars` 或 `toolOutputTruncated`、`toolOutputOriginalChars`。
- `runtime.tasks.transcript` 默认返回历史消息时也必须应用同样的截断语义，避免刷新或切换任务后重新把完整大字符串加载回 WebView。
- 用户点击“加载完整输出”时，前端通过同一个 runtime transcript 方法请求 `includeFullContent: true`。executor 返回完整 transcript 和 `fullContent: true`，当前 pane 用完整 messages 替换预览 messages，并清空分页/gap 状态；后续展开其他控件直接复用该完整态，不再逐个走长路径。
- `MessageList` 和 `ToolBlocksDisplay` 只能渲染当前预览内容和截断提示；仅用 CSS 折叠隐藏完整内容不算释放内存。
- 右侧临时聊天必须复用同一套 reducer 与 stream action 批处理，不能为临时线程单独累积完整输出。

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
- UI 状态保存在 `TemporaryChatPanel` 内部，并以实例标识作为未创建 runtime 线程前的 `conversationKey`；切换 tab 时面板保持挂载，避免丢失本地消息和输入状态。
- 首条消息通过 `createTemporaryRuntimeTask` 创建 `ephemeral` runtime task，并携带当前主线程的 `sideSource`。该任务不写入左侧任务列表，也不触发主 pane 导航。
- 后续消息必须继续使用已加载的临时线程。Codex app-server 路径使用 `direct_thread_id` 直接 `turn/start`，不能走普通 `resume_thread_id` 的 `thread/resume` 路径，否则会因为临时线程没有 rollout 映射而出现 `no rollout found`。
- 临时聊天只复用当前工作区和当前线程上下文；如果没有可用的主线程 source，应阻止发送并提示用户先打开已有对话。

维护规则：不要用 fallback 在 UI 里把临时聊天补进左侧任务列表，也不要在 executor 中为临时线程伪造 rollout。临时聊天的主路径是 `ephemeral + sideSource + direct_thread_id`。

## 顶层页面切换

工作台包含输入草稿、Terminal 会话和内置浏览器等无法可靠序列化的实时状态。用户从工作台切换到插件、应用或 iframe 应用时，`AppRoutes` 必须保持 `WorkbenchProvider` 和 `WorkbenchPage` 挂载，只隐藏工作台表面；返回后继续使用原组件实例。直接打开辅助页面时可以延迟首次挂载工作台，避免创建没有使用过的后台会话。

不要通过路由切换卸载工作台，也不要为 Terminal 或浏览器增加不完整的状态恢复 fallback。新增顶层页面时，应将它纳入辅助页面渲染分支，并保持工作台生命周期不变。

## 工作台 pane 缓存

桌面工作台最多缓存 20 个普通 pane，使用户在并行任务之间切换时保留消息、输入草稿和局部 UI 状态。超出上限后按最近使用顺序淘汰非活跃 pane；正在运行的任务和已固定终端的 pane 不计入普通缓存上限，并保持挂载直到任务结束或终端解除固定。维护此边界时应继续复用 `CachedWorkbenchPaneStack` 的 LRU 与固定机制，不能在布局层增加第二套 pane 缓存。

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
