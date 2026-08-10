---
sidebar_position: 18
---

# Wework 聊天状态信源

本文记录 Wework 聊天链路的状态信源和维护规则。目标是让 UI 只读取明确的单一派生状态，避免发送按钮、消息流、队列和 runtime 任务状态互相覆盖。

## 核心原则

1. `RuntimeTaskMachine` 是单个任务执行、turn、Goal 和未读生命周期的聚合根；reducer 只是状态机内部的转换实现。
2. `RuntimeTaskLifecycleStore` 管理所有任务状态机并路由 executor、UI 和 transcript 事件，是前端任务生命周期的唯一信源。
3. `RuntimeTaskLifecycleProvider` 只把 Store 订阅适配给 React，不持有、不缓存、也不派生生命周期状态。
4. `useWorkbenchPaneSession` 管理消息、排队输入等 pane 内容，但任务和 turn 生命周期事实全部读取 Store。
5. `runtimePaneStatus.ts` 只是把生命周期快照投影到现有 pane 展示字段的只读适配层，不能自行推断执行或 turn 状态。

## 状态信源清单

| 状态                          | 唯一信源                                                                                                                        | 派生值/使用方                                                                                          | 维护规则                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 消息内容与消息状态            | `useWorkbenchPaneSession.messages`                                                                                              | `MessageList`、导出、文件变更、request user input                                                      | 只能通过 transcript reset 或 `reduceWorkbenchMessages` 更新                                                                                                                     |
| assistant turn 是否活跃       | `RuntimeTaskLifecycleStore` 中任务快照的 `turn.phase`                                                                           | 消息流式展示、调试状态                                                                                 | 实时 stream 与 transcript 事件统一路由到任务状态机；布局和 pane 代码不能再从消息自行推断 turn 是否活跃                                                                          |
| 本地发送阶段                  | `RuntimeTaskLifecycleStore` 中任务快照的 `turn.phase`                                                                           | `status.isSubmitting`、`status.isWaitingForAssistantIndicator`、兼容字段 `sending/waitingForAssistant` | 乐观发送、确认、拒绝、stream 开始与结算都作为任务状态机事件处理                                                                                                                 |
| 当前 runtime 运行快照         | executor 的 `running` 输入经 `RuntimeTaskLifecycleStore` 路由                                                                   | 生命周期快照、侧栏、composer、消息区、队列推进                                                         | executor 字段是权威外部事实；生命周期 Store 是前端唯一访问入口，乐观转换也由同一状态机维护                                                                                      |
| pane 是否忙碌                 | `paneSession.status.isBusy`                                                                                                     | 当前 pane 队列是否可推进                                                                               | 由 `isSubmitting`、`isAwaitingAssistant`、`isAssistantStreaming`、`taskExecution.running` 合成                                                                                  |
| 队列消息                      | `queuedMessages`                                                                                                                | `ConversationQueuePanel`、自动发送下一条 follow-up                                                     | 只在 pane session 内增删改；推进条件必须使用 `status.canSendQueuedMessage`                                                                                                      |
| 引导消息                      | 按生命周期阶段唯一：待应用时为 `queuedMessages`；应用后为当前或后台 live projection；Provider 覆盖该 turn 后为 Codex transcript | `ConversationQueuePanel`、`MessageList`                                                                | 引导成功后必须先从队列移除；源 pane 未挂载时写入的后台缓存只用于填补运行中 transcript 窗口，不能合并进 Provider 分页消息，Provider 覆盖同一 turn 后必须整体接管                 |
| transcript 加载与分页         | `transcriptLoading`、`transcriptHasMoreBefore`、`transcriptBeforeCursor`、`loadedTranscriptRanges`                              | 滚动加载、turn navigation                                                                              | 只由 transcript API 响应更新                                                                                                                                                    |
| runtime goal                  | `threadGoal` + `pendingGoalState`                                                                                               | goal bar、goal draft、首条消息 initial goal                                                            | 已持久化目标来自 runtime goal API；新建任务前目标暂存在 pending seed                                                                                                            |
| request user input 已处理集合 | `answeredRequestUserInputIds`                                                                                                   | 隐藏已响应/忽略的 request user input 卡片                                                              | 只由提交或忽略动作更新                                                                                                                                                          |
| 模型上下文用量                | Codex `thread/tokenUsage/updated` runtime stream 事件；`runtime.tasks.transcript.contextUsage`                                  | composer 右下角上下文窗口用量圆环和 tooltip                                                            | executor 必须原样转发 Codex token usage notification，并在历史 transcript 响应中从同一 rollout 读取最新 token count；UI 只按当前 runtime task 保存到 `projectChat.contextUsage` |
| 长回复正文与工具输出          | `reduceWorkbenchMessages` 的预览窗口；`runtime.tasks.transcript` 的截断字段与完整加载标记                                       | `MessageList`、processing block、Debug Panel 内存摘要                                                  | 默认 resident `messages` 只保留尾部预览、原始长度和加载引用；只有用户显式加载完整 transcript 后，当前 pane 才能升级为完整态并替换 `messages`                                    |
| 附件/模型/技能选择            | `projectChat` context                                                                                                           | send payload、composer 控件                                                                            | 当前 LocalTask 内选项锁定由 `projectChat.isOptionsLocked` 派生                                                                                                                  |
| 设备可用性                    | `state.devices` + 当前任务/项目设备选择                                                                                         | composer disabled reason、设备提示                                                                     | 只用于发送前置条件，不参与 assistant streaming 判断                                                                                                                             |

## Runtime 事件流

1. 新消息提交时，`sendPhase` 进入 `submitting`。
2. runtime 接受请求后，`sendPhase` 进入 `awaiting_assistant`。
3. `chat:start` 转换为 `assistant_started`，消息 reducer 创建/更新 assistant streaming 消息，`sendPhase` 回到 `idle`。
4. `chat:chunk` 和 block 事件只更新 `messages`。
5. Codex `thread/tokenUsage/updated` 事件只更新 `projectChat.contextUsage`，不能创建空消息，也不能写入 transcript。
6. 打开历史任务时，`runtime.tasks.transcript.contextUsage` 只恢复当前任务的 `projectChat.contextUsage`，不能通过额外 UI fallback 重新扫描消息或任务列表。
7. `chat:done`、`chat:error`、取消事件通过 reducer 结算 assistant 消息，并触发 work list 刷新。
8. 如果 runtime work 与消息状态不一致，不做兜底结算；必须修正缺失的 stream event、transcript 数据或 reducer action。

发送启动期间可能先收到 `source: pending_local_task`、空消息且
`running: false` 的本地 transcript，此时真实 runtime task 尚未出现在任务列表中。
当 turn 仍处于 `submitting` 或 `awaiting_assistant` 且没有已结算 assistant 时，这个
transcript 不能结算 executor 或 turn；后续任务列表的 `running: true` 才是已启动
executor 的权威快照。流式 assistant 已明确存在时返回的 `running: false` 仍然是终态，
必须正常结算，不能把所有 false 快照一概忽略。

Codex provider 可能只发送带完整正文的 `item/completed`，而不发送
`item/agentMessage/delta`。executor 必须在当前最终回复尚未接收任何 delta 时把该完整
正文转换为一次 `response.output_text.delta`；已接收 delta 时则忽略完成快照，避免
重复正文。临时聊天是 ephemeral thread，不能依赖 `thread/read(includeTurns)` 补回
丢失的实时文本。

任务在后台结算后，用户切回 pane 时可能先加载到只包含上一轮的旧 transcript。
`useWorkbenchPaneSession` 必须比较缓存最新轮和 transcript 已结算 assistant 的轮身份；
轮身份由 `turnId` 与标准化 `subtaskId` 共同表示。transcript 尚未覆盖同一轮时，缓存仍
是当前消息的权威来源；只有同一轮 assistant 已在 transcript 中结算后，才切换为
transcript。不得按正文长度、block 数量或其他内容权重推断新旧。

work list 刷新也可能立即触发一次已完成 transcript 重载。该 transcript 负责最终文本、
消息状态和文件变更，但 Codex 的 `thread/read` 可能暂时缺少实时流中已经完成的工具
条目。实时消息在 `assistant_done` 入口用规范 `turnId` 标准化 `subtaskId`；切换到同一
轮 transcript 后，`useWorkbenchPaneSession` 保留 transcript 的权威字段，同时补回实时
消息中状态为 `done` 或 `error` 且 transcript 尚未包含的 tool block。不得补回
`pending` 或 `streaming` block，否则已完成任务会重新显示为执行中。

同一个 Codex turn 可能因为工具调用或中途引导被拆成多条 assistant 消息。每条消息
必须使用不同的消息 `id`，但都保留相同的规范 `turnId`。fork、回滚等 turn 级操作
只能使用 Codex 持久化的规范 turn ID，不能使用为了界面分段生成的消息 ID。

### Codex Turn 身份与恢复

Codex app-server 的 `turn/start` 返回值是新 turn 身份的权威来源。executor 必须在
请求成功后立即记录返回的 turn ID；后续 `turn/started` notification 只用于确认或
纠正，不能作为进入活跃 turn 的必要条件。这样即使实时通知延迟或遗漏，引导和中断
仍能定位当前 turn。

用户发送引导时，Wework 先把引导消息乐观插入当前 turn，再调用
`runtime.tasks.guidance`。如果 Codex `turn/steer` 明确返回预期 turn ID 与实际活跃
turn ID 不一致，executor 用返回的实际 ID 更新记录并只重试一次。成功回执中的
turn ID 可以把乐观消息重新绑定到正确 turn；失败时必须移除乐观消息并保留可重试的
队列项，不能让 transcript 中出现未被 Codex 接受的引导。

“立即发送”在发起中断请求前先把当前运行 turn 乐观标记为已取消，并移除正在发送的
乐观引导；中断接口必须把“已经没有活跃 turn”视为幂等成功，然后启动新 turn。请求
失败时，前端恢复此前的 turn 状态和乐观引导，避免消息丢失。

实时事件只负责增量更新。WebView 或 runtime transport 重建后，恢复路径必须对已持久化
的 Codex thread 执行 `thread/resume`，再用 `thread/read(includeTurns)` 读取完整快照；
快照重新建立 turn、消息和运行状态，不能依赖断线前的内存事件缓存继续推断。

首条消息携带 pending Goal seed 时，发送入口和 pane 初始化都必须先把 seed 的状态
写入 `RuntimeTaskLifecycleStore`。异步 `runtime.goal.get` 在 Goal 尚未持久化时可能返回
空值；在 seed 仍属于当前任务时，空结果不能清除 lifecycle 中的 Goal 状态。这样即使
stream 结算先于 Goal 持久化完成，active Goal 也能继续约束任务生命周期。

## 本地多目录项目与任务归属

本地 Codex 项目可以包含一个有序的根目录列表。第一项是主根，用于 composer
默认工作区和执行请求的 `cwd`；完整、去重后的根目录列表是项目级执行上下文，不能
缩减为当前 workspace。

多目录上下文按以下主链路传递：

1. Wework 从 runtime project 的 `roots` 读取目录；仅在该字段缺失时才从
   `deviceWorkspaces` 派生，并在创建任务和发送消息时传递
   `runtimeProjectKey`、`runtimeProjectName` 和 `runtimeWorkspaceRoots`。
2. local services 将这些字段写入 execution request metadata。
3. executor 把项目 key 和根目录列表保存到 `RuntimeTaskLink`，并在 Codex
   `thread/start`、`thread/fork`、`thread/resume` 和 `turn/start` 请求中传递
   `runtimeWorkspaceRoots`。
4. follow-up 请求缺少项目 metadata 时，executor 从现有 `RuntimeTaskLink`
   恢复这些字段，保证同一 thread 和重新打开后的会话继续使用相同项目范围。
5. Codex 全局线程归属优先使用显式 project key，再进行路径匹配，避免一个多目录
   项目在侧栏中被拆成多个项目。

`runtimeWork` 的本地快照是本地任务展示的当前事实。异步云端刷新必须与刷新完成时的
最新本地快照合并，不能用请求发起前捕获的旧状态覆盖新建任务。用户选择“新建会话”
只清空当前聊天 pane，不归档或删除原任务；原任务继续显示在项目下，并可重新打开。
环境弹层必须展示和复制项目的全部根目录，而不是只显示主根。

这些规则只改变本地 Codex 项目。远程和云端任务仍遵循其原有的单 workspace 选择
语义，不能因为本地多目录支持而隐式扩大远程执行范围。

### 网页搜索工具块

Codex 的网页搜索在 `item/started` 时可能还没有查询动作，在 `item/completed` 时才提供最终的 `action`。executor 必须用相同 block id 发出更新，把状态结算为 `done`，并将最终 `action` 写入 `tool_input`；否则 Wework 会一直显示“正在搜索网页”，展开后也没有内容。实时事件和历史 transcript 必须生成一致的 `web_search` 工具块。

Wework 展示层兼容 Responses API 的 snake_case 动作名（如 `open_page`、`find_in_page`）和 Codex app-server 的 camelCase 动作名（如 `openPage`、`findInPage`）。动作名差异只能在工具详情解析边界处理，不能通过 UI 占位内容或状态兜底掩盖缺失的完成事件。

### 工具活动预览滚动

折叠的工具活动预览最多显示三行，并在用户没有展开工具详情时跟随最新活动。自动滚动必须同时响应工具行数量变化和底部“正在思考”行的出现或消失；工具完成后即使行数不变，“正在思考”也必须保持在内层滚动区域的可见范围内。展开详情时预览解除高度限制，不能用强制滚动覆盖用户阅读位置。

## Goal 与任务执行状态

Goal 条的运行态必须受当前 runtime task 的执行快照约束：当 App Server 明确返回当前任务 `running: false` 时，仍为 `active` 的 goal 在 UI 中必须派生为 `paused`，并停止累计显示的耗时。这避免在重新打开已中断任务时，goal 继续显示“进行中”并计时。

- 仅当 `running` 是明确的布尔值时，任务执行状态才是已知状态；缺失该字段意味着状态尚不确定，不能据此暂停 goal。
- 此派生只影响 Wework 的展示与计时，不会自动调用 goal 暂停接口。用户点击“暂停目标”才会持久化 `paused` 状态。
- 任务重新处于 `running: true` 时，goal 继续使用 runtime goal API 返回的原始状态。

Active Goal 的自动续跑状态由 root turn 生命周期事件单独驱动。收到
`runtime.goal.continuation: started` 后，Goal 条必须持续显示“目标继续执行中”，包括
assistant 已开始输出、思考或调用工具的阶段；assistant 输出开始不是 turn 结束信号，
不得清除续跑状态。只有对应的 `settled` 事件、Goal 变为非 active 状态、Goal 被清除或
pane 切换到其他任务时才清除该状态。

用户停止一个带有 active goal 的当前回复时，Wework 必须先通过 runtime goal API
持久化 `paused`，确认成功后再取消当前 turn。这个顺序先关闭自动续跑源，避免当前
turn 被取消后 goal 在暂停请求到达前启动下一 turn。如果 goal 暂停失败，不得继续把
当前回复标记为已停止。Goal 详情仍在加载时，停止流程必须使用任务列表快照中的
`goalStatus` 判断是否需要暂停，不能因为尚未渲染 Goal 条而跳过持久化。

## 任务运行、持续与未读

左侧运行标记、输入框状态、消息状态和未读提醒表达的是不同事实，不能共用一个模糊的“活跃”布尔值：

| 状态       | 判定                                                    | UI 约束                                                                        |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 运行中     | `task.running === true`                                 | 左侧显示运行 spinner；当前 pane 的 composer 显示暂停能力；消息区显示“正在思考” |
| 单轮输出中 | `task.running === true` 且存在 streaming assistant 消息 | 只用于流式消息生命周期，不得成为侧栏、composer 或未读状态的另一套运行判定      |
| 已结束未读 | 任务从“运行中”转换为“不再运行”，且不是当前打开任务      | 左侧显示蓝色未读点，并可触发一次完成通知                                       |

`running` 是 executor 对任务级执行生命周期的权威判断，不是当前单个 turn 的状态。Active Goal 的 continuation loop 仍存活时，即使两个自动 turn 之间暂时没有 streaming assistant 消息，executor 也必须继续报告 `running: true`，因此左侧 spinner、composer 暂停按钮和消息区“正在思考”保持可见且不产生未读。executor 重启后若没有恢复该执行循环，则即使持久化的 `goalStatus` 仍为 `active`，也必须报告 `running: false`；Wework 不得自行把它推断为运行中。前一轮残留的 streaming 消息不能复活。

任务终止事件应立即把本地任务标记为 `running: false`，并刷新 work list。若并发刷新返回了更早的 `running: true` 快照，reducer 必须保留本地已结算状态，直到同一任务收到新的启动事件，不能让旧响应把 spinner、暂停按钮或“正在思考”重新点亮。同一任务的执行身份由 `deviceId + taskId` 决定；`workspacePath` 是可能在创建、刷新和 transcript 恢复间变化的路由元数据，不能参与运行状态身份判断。

未读只在当前 Wework renderer 生命周期内观察到 `running: true -> false` 边沿时产生，不根据 `status` 文本或持久化记录猜测运行历史；本地持久化只保存已经产生的未读结果，不保存运行态。持久化 Goal 仍为 `active` 但 executor 已不再运行的任务属于待恢复状态，不得因应用或 executor 重启产生完成未读。当前任务和所有运行中任务都必须从可见未读集合排除；打开任务会清除其未读状态。

executor 的 `RuntimeTaskLink.running` 只存在于当前进程内存和 runtime API
响应中。`runtime-work/index.json` 不得序列化该字段，读取旧索引时也必须忽略其中
残留的 `running` 值；任务是否正在执行只能由当前 executor 的活动任务集合决定。

## Composer 模式提示

当 composer 处于计划模式或目标草稿模式时，底部模式胶囊必须在标签左侧显示对应的语义图标：计划模式使用清单图标，目标草稿使用靶心图标。桌面和紧凑布局必须复用同一个模式胶囊实现，确保表达一致。

模式胶囊的取消按钮仅在悬停时显示，并绝对定位覆盖左侧图标；原图标在同一状态下淡出。不要通过展开取消按钮或额外边距改变胶囊宽度，否则标签会发生横向跳动。

## Composer 草稿缓冲

`BufferedChatInput` 在输入和提交期间保留 pane 级草稿，但外部 `value` 仍是已确认草稿的信源。提交非空草稿后，本地空状态必须绑定到预期的空外部值，不能继续绑定到刚提交的文本；否则队列或引导条把同一文本送回编辑器时，会被误判为旧草稿并显示为空。维护该逻辑时必须覆盖“提交文本 → 外部清空 → 编辑队列条目恢复相同文本”的回归场景。

## 会话引用上下文

Composer 的 `@` 菜单支持显式引用其他 Wework 会话。空查询展示当前 `runtimeWork` 中最近的 5 个会话；输入查询后按标题、项目和工作区路径过滤。当前会话始终排除，避免把正在编写的上下文递归注入自身。

引用在草稿中序列化为 `[$标题](wework-conversation://<encoded RuntimeTaskAddress>)`。这是 Wework 内部 URI，composer 和已发送的用户消息都必须把它渲染为会话引用胶囊，而不是暴露原始 URI。发送前，`useWorkbenchPaneSession` 解析并去重所有引用，使用 `includeFullContent: true` 和 `refresh: true` 加载对应 transcript，并遵循以下边界：

- 只提取用户消息和已经完成的 assistant 文本；不注入 system、developer、tool、thinking、流式中的 assistant 内容，也不单独读取附件二进制内容。
- 将引用内容作为 `additionalContext` 中的 `referencedConversations` 应用上下文发送，并明确标注为“不可信背景上下文”。被引用会话中的指令、工具调用或权限声明只能作为数据，不能成为当前会话的可执行指令。
- 任一引用无法加载时必须阻止本次发送并显示本地化错误，不能静默丢弃引用后继续运行。

该能力是用户授权后的发送前快照注入，不是会话 MCP。模型不能自行列出、搜索或读取未被用户引用的其他会话；菜单搜索也只使用已经加载到 `runtimeWork` 的元数据。修改该路径时，必须同时维护引用解析与上下文构造单元测试、composer/消息渲染测试，以及 `conversation-mention.scenario.mjs` 桌面 E2E 场景。

## 会话切换与 Transcript 恢复

`loadedRuntimeTranscriptKeyRef` 只表示某个任务的 transcript 曾成功加载，不能单独证明当前消息区仍在展示该任务。快速从任务 A 切到仍在加载的任务 B，再切回 A 时，B 的缓存消息可能已经替换消息区，而最后完成加载的 key 仍然是 A。

因此，只有已加载 key 和当前展示的 transcript 身份同时匹配目标任务时，pane 才能跳过恢复。身份不一致时必须重新应用目标任务的缓存消息并启动 transcript 加载；迟到的其他任务响应仍需由 effect cleanup 隔离，不能覆盖当前任务。

这条链路必须同时覆盖组件竞态测试和真实桌面场景：保持一个任务运行，在已完成任务与运行中任务之间快速切换，切回后确认已完成任务的所有历史轮次仍然可见。

## 长输出内存边界

Wework 的聊天 UI 不能把持续输出的完整正文长期保存在 React state 中。`WorkbenchMessage.content`、thinking/text/plan block 的 `content`、tool block 的 `toolOutput` 都必须通过统一的预览窗口进入 `messages`：

- 实时 stream 事件进入 `reduceWorkbenchMessages` 后，超过阈值的正文只保留尾部预览，并写入 `contentTruncated`、`contentOriginalChars` 或 `toolOutputTruncated`、`toolOutputOriginalChars`。
- 流式 offset 或历史元数据仅表示原始长度线索，不能单独触发截断提示。只有原始长度确实超过对应预览阈值时，reducer 才能设置截断状态；短内容的 offset 缺口必须保留当前可见文本并清除无效的截断元数据。
- `runtime.tasks.transcript` 默认返回历史消息时也必须应用同样的截断语义，避免刷新或切换任务后重新把完整大字符串加载回 WebView。
- 用户点击“加载完整输出”时，前端通过同一个 runtime transcript 方法请求 `includeFullContent: true`。executor 返回完整 transcript 和 `fullContent: true`，当前 pane 用完整 messages 替换预览 messages，并清空分页/gap 状态；后续展开其他控件直接复用该完整态，不再逐个走长路径。
- `MessageList` 和 `ToolBlocksDisplay` 只能渲染当前预览内容和截断提示；仅用 CSS 折叠隐藏完整内容不算释放内存。
- 右侧临时聊天必须复用同一套 reducer 与 stream action 批处理，不能为临时线程单独累积完整输出。

## Transcript 顺序

服务端返回的 `messageIndex` 是 Codex 持久 transcript 的唯一顺序。加载较早页面或补中间 gap 时，只能把来自同一 Provider transcript 的页面按 `messageIndex` 组合；不得把后台消息缓存、`runtimeHandle.messages` 或按正文匹配出的本地用户消息并入 Provider 页面。

当前 pane 的实时 turn 尚未被 transcript 覆盖时，可以继续整体展示该 pane 的 stream 投影；Provider 覆盖同一 turn 后应整体切换到 transcript，而不是对两组消息做并集。消息分页去重只使用 Provider 的稳定 message id，不根据内容、角色或 subtask 猜测身份。

Codex 可能从 Provider transcript 的 `items` 中过滤初始用户输入，但 Wework 仍会在
`RuntimeTaskLink.userMessagePresentations` 中保存用户实际提交的可见文本。executor
补回这类消息时，必须把它归属到时间线上紧随其后的 Provider turn，并同时写入规范
`turnId`/`subtaskId`；用户输入与首个 assistant 消息时间戳相同时，用户输入必须排在
assistant 之前。canonical `turns` 是前端 transcript 的唯一输入，不能只把补回消息
留在兼容 `messages` 数组中。

## 引导消息顺序

运行中的 Codex LocalTask 支持把队列消息作为原生引导发送。引导是当前 turn 内的用户输入，不是新的 follow-up turn，所以 UI 必须在发送开始时就把本地用户消息插入到当前 assistant 中间：

1. 将对应 `queuedMessages` 项标记为 `sending`，提示文案为“正在引导当前对话”。
2. 用同一个本地消息 id 和 `createdAt` 创建 user message，并把当前 streaming assistant 拆成两段。
3. 引导前 assistant 冻结为 done，移除 `subtaskId`，后续 stream 不再写入它。
4. 引导后 assistant 继续保留原 `subtaskId`，并先放入一条 `conversation_guidance` tool block，用于标记引导位置。
5. 后续 `chat:chunk` 和 `chat:done` 可能携带完整文本，必须按拆分时记录的 assistant 文本前缀裁剪后再进入 reducer。

不要把引导成功后的 user message append 到对话底部，也不要等 `runtime.tasks.guidance` 返回后才拆分 assistant；这会让引导请求等待期间产生的 assistant 文本出现在用户引导消息之前，造成流式显示和刷新后 transcript 顺序不一致。

如果引导应用时源 pane 没有挂载，后台订阅者必须从 `queuedMessages` 移除对应条目，并把已确认的 user message 写入 `runtimeConversationCache.messages` 的内存 live projection。后台路径必须复用前台的 `AppliedRuntimeGuidanceMessage` 构造和 assistant 拆分入口，禁止直接执行 `[...messages, guidance]`；否则重新打开仍在运行的会话时，user message 会落在整个 assistant 后面。拆分前缀边界必须按 conversation key 共享，使后台拆分后切回前台的 `chat:done` 仍能去掉已展示的 assistant 前缀。用户在 Codex transcript 尚未覆盖当前运行中 turn 时重新打开源对话，必须先看到这条已确认消息；Provider transcript 覆盖同一 turn 后再整体接管内容和顺序。该缓存不得持久化，也不得与 Provider 分页消息做并集合并，因此不会成为第二份持久 transcript 信源。

引导消息插入后，即使用户此前已经向上滚动，消息区域也必须主动滚动到底部并保持一段短暂的稳定跟随，使新插入的 user message 和 assistant continuation 可见。该强制滚动只适用于当前会话中新应用的引导；加载包含旧引导的历史页面时，必须保留用户当前的视口锚点。

## 右侧临时聊天

右侧工作区的“临时聊天”用于在当前 Codex 本地线程旁边发起一次短对话。它不是 fork，也不是左侧任务列表中的普通 runtime task：

- 每个临时聊天 tab 都有独立的 `chat:<id>` 实例标识，允许在右侧工作区同时打开多个临时聊天。
- UI 状态保存在 `TemporaryChatPanel` 内部，并以实例标识作为未创建 runtime 线程前的 `conversationKey`；切换 tab 时面板保持挂载，避免丢失本地消息和输入状态。
- 每个临时聊天的附件选择、上传进度和错误状态也按实例隔离，不能复用主聊天 composer 的附件状态；首条消息必须把该实例的附件显式传给 `createTemporaryRuntimeTask`。
- 右侧工作区只打开一个临时聊天时，默认使用紧凑的 `420px` 面板宽度；打开其他工作区 tab 后恢复通用分栏默认值，用户手动调整的宽度仍然优先。
- 首条消息通过 `createTemporaryRuntimeTask` 创建 `ephemeral` runtime task，并携带当前主线程的 `sideSource`。该任务不写入左侧任务列表，也不触发主 pane 导航。
- 后续消息必须继续使用已加载的临时线程。Codex app-server 路径使用 `direct_thread_id` 直接 `turn/start`，不能走普通 `resume_thread_id` 的 `thread/resume` 路径，否则会因为临时线程没有 rollout 映射而出现 `no rollout found`。
- 临时聊天只复用当前工作区和当前线程上下文；如果没有可用的主线程 source，应阻止发送并提示用户先打开已有对话。
- runtime work 列表刷新后，reducer 必须用同一设备、同一任务的权威 `threadId/runtimeHandle` 水合当前任务地址；不能因为设备仍在线就保留缺少 thread 的 optimistic address，否则右侧临时聊天无法建立 `sideSource`。

维护规则：不要用 fallback 在 UI 里把临时聊天补进左侧任务列表，也不要在 executor 中为临时线程伪造 rollout。临时聊天的主路径是 `ephemeral + sideSource + direct_thread_id`。

修改该链路后运行 `pnpm --dir wework e2e:desktop`。主桌面场景会断言右栏约为 `420px`，在右栏上传并发送附件，并确认主 composer 始终没有继承右栏附件；关键阶段截图写入 `wework/test-results/desktop-e2e/<run-id>/`。

## 顶层页面切换

工作台包含输入草稿、Terminal 会话和内置浏览器等无法可靠序列化的实时状态。用户从工作台切换到插件、应用或 iframe 应用时，`AppRoutes` 必须保持 `WorkbenchProvider` 和 `WorkbenchPage` 挂载，只隐藏工作台表面；返回后继续使用原组件实例。直接打开辅助页面时可以延迟首次挂载工作台，避免创建没有使用过的后台会话。

不要通过路由切换卸载工作台，也不要为 Terminal 或浏览器增加不完整的状态恢复 fallback。新增顶层页面时，应将它纳入辅助页面渲染分支，并保持工作台生命周期不变。

多个顶层文档标签会用 React `Activity` 保持各自的工作台实例。隐藏
`Activity` 的更新可能延迟提交，但它创建到全局标题栏的 Portal 仍会保留在目标节点中。
因此所有全局标题栏 Portal 都必须标记所属文档标签，并由 `AppRoutes` 的活动标签状态统一
控制可见性；不能仅依赖隐藏工作台内部的条件渲染来撤销 Portal。切换标签时只能显示当前
活动标签的主标题栏、面板操作区、右侧工作区标题和反馈入口。

## 工作台 pane 缓存

桌面工作台最多缓存 20 个普通 pane，使用户在并行任务之间切换时保留消息、输入草稿和局部 UI 状态。超出上限后按最近使用顺序淘汰非活跃 pane；正在运行的任务和已固定终端的 pane 不计入普通缓存上限，并保持挂载直到任务结束或终端解除固定。维护此边界时应继续复用 `CachedWorkbenchPaneStack` 的 LRU 与固定机制，不能在布局层增加第二套 pane 缓存。

消息区按 `conversationKey` 保存每个任务的阅读位置。任务切换时，恢复流程会在布局稳定窗口内重复对齐已保存的消息锚点；这段时间由程序触发的 `scroll` 事件不能覆盖快照。用户主动滚轮或触摸滚动时则应立即退出恢复状态。修改这条链路时，必须覆盖“滚到长回复中部 → 切到另一任务 → 切回原任务”的真实桌面 E2E，并保留切换前、切换后和恢复后的截图。

## 审核结果

- 桌面和移动布局不再直接扫描 `messages` 判断是否 streaming，统一读取 `paneSession.status.isAssistantStreaming`。
- composer 禁用状态不再读取独立 `paneSession.sending`，统一读取 `paneSession.status.isSubmitting`。
- 消息等待指示不再拼接 `sending || waitingForAssistant`，统一读取 `paneSession.status.isWaitingForAssistantIndicator`。
- 队列推进不再使用散落的 `currentRuntimeTask && !busy`，统一读取 `paneSession.status.canSendQueuedMessage`。
- 侧栏、composer 和消息区的任务状态全部订阅 `RuntimeTaskLifecycleStore`，没有模块直接读取 `runtimeWork.running`。
- 乐观发送态与 executor 确认态使用同一个任务状态机，发送确认和 stream 竞态不会产生多个前端权威源。
- `runtimePaneStatus.ts` 只把生命周期快照投影成兼容展示字段，不维护任务或 turn 状态。

## 后续维护规则

- 新增任务生命周期状态或转换时，先扩展 `RuntimeTaskMachine` 及其内部 reducer，再暴露 Store 事件与派生快照字段。
- 不要在布局、pane hook 或组件中重新计算任务运行、turn 活跃、busy 或未读状态。
- 不要新增独立的 `isSending`、`isRunning`、`isStreaming` React state；新的外部事实必须通过 Store 事件路由进入状态机。
- runtime work 与消息状态冲突时，不允许在 UI 组件里临时覆盖显示，也不允许新增 fallback 结算；必须修主路径。
