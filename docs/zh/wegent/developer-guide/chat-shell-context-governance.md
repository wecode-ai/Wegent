---
sidebar_position: 31
---

# Chat Shell 上下文治理

## 概述

`chat_shell` 的上下文治理分三步落地：

1. **Stage 1：工具输出治理**
   把超长 tool output 收敛成稳定的 model-visible 紧凑表示，并补齐上下文指标与前端状态展示。
2. **Stage 2：总结压缩**
   当完整 live state 接近窗口上限时，在同一个 guard 框架里做 request-level summary compact，并在失败时回退到更保守的 fallback。
3. **Stage 3：附件上下文治理**
   把大附件从“整段常驻注入”改成“有界预览 + 按需读取”，避免附件长期挤占上下文。

这三步共同目标不是“做一个压缩器”，而是建立一套**统一、可扩展、可观测**的模型调用前治理框架。

## 改造前的缺口

在这三阶段改造之前，`chat_shell` 已经有一些局部控制手段，但整体上仍有三个明显缺口：

- **没有统一的模型调用前入口**
  一部分控制在 `build_messages`，一部分依赖 tool event 或后处理，pre-turn 和 mid-turn 的预算口径并不天然一致。
- **缺少对不同上下文源的分层治理**
  tool output、历史消息、附件注入都可能把 live state 推高，但系统没有一个统一框架先做 source-level 收缩，再看整体预算。
- **缺少稳定的运行时观测面**
  当会话“变卡”或“突然超长”时，很难快速回答到底是哪类上下文在膨胀、是否已经触发压缩、压缩后是否真的回到了安全区。

更具体地说，旧链路里最典型的问题有：

- 大 tool output 会进入后续模型调用，只有局部截断，且不同路径容易出现双重截断或口径漂移；
- 历史压缩更偏 turn-start 行为，mid-turn 在多次 tool 调用后仍可能把 live state 推高；
- 附件提取文本会作为 `<attachment>` 块整段常驻注入，即使当前轮没有触发 summary compact，也会持续占用上下文；
- 一旦附件或旧历史进入 summary compact，往往会连同用户当前问题一起被折叠，恢复路径也不明确；
- 前端缺少稳定的剩余上下文状态展示，reload / reconnect 后也不容易知道当前会话是否已经处于压缩或高压状态。

因此，这次改造的重点不是单独优化某一条截断逻辑，而是把“模型调用前的上下文治理”从零散补丁收敛成统一机制。

## 设计思路

### 统一入口，而不是分散打补丁

核心控制点是 `LangGraph pre_model_hook`。原因很简单：它天然覆盖两类模型调用：

- **pre-turn**：本轮开始时的首次模型调用
- **mid-turn**：工具执行结束后的后续模型调用

这比把长度控制分散在 `build_messages`、tool event、history serialization 等多处更稳。治理逻辑最终收敛到 `UnifiedContextGuard`，避免不同路径口径漂移。

**覆盖边界（重要，别被“非流式”误导）。** `UnifiedContextGuard` 只在 **chat 执行引擎**构建 agent 时通过 `pre_model_hook` 挂载，所以要区分两种“非流式”：

- **传输层非流式**（HTTP `stream=false` 追问）：只是把 SSE 事件缓冲后一次性返回，**底层执行引擎仍是 `stream_tokens`**，照常挂 guard、走压缩恢复与落库。它**受**治理。
- **引擎级非流式**（`agent.execute` → `_collect_final_state_from_events`）：是否挂 guard 取决于调用方是否传入 `pre_model_hook`。当前唯一使用者是答案质检 `correction_service`，它**不传** `pre_model_hook`——这是一条 **guard 未覆盖的短路路径**：不做压缩治理、把待评估历史内嵌进 prompt、结果只写 `subtask.result.correction`（**不落 `messages_chain`**）、并自带 try/except 兜底。它是一次性质检器，不是对话/追问路径，与本上下文治理解耦。

### 区分“用户可见原始数据”和“模型可见紧凑数据”

这是整个设计里最重要的边界之一。

- **原始/UI 可见表示**：用于前端展示、结果回放、协议兼容
- **模型可见表示**：用于下一次 provider 调用前的预算治理

典型例子：

- tool output 的原始内容仍保存在 block / result 侧；
- `messages_chain` 里保存的是 compact 后的 model-visible 版本；
- 附件完整内容仍在沙箱原文或数据库提取文本中，模型上下文里只放 preview。

这样做的目的不是隐藏数据，而是避免把“方便展示”和“适合喂模型”混成一个字段。

### 分层治理，而不是只靠一种压缩

上下文治理最终形成了三层：

1. **source-level guard**
   先治理单一来源的大块内容，例如 tool output、附件预览。
2. **request-level compaction**
   在完整 live state 上重新计算预算，必要时做 summary compact。
3. **emergency fallback**
   若仍超预算，再做更保守的紧急再截断或失败恢复。

这套分层明显借鉴了 Codex 一类系统的治理方式，但没有照搬其历史重写模型。

## 借鉴与取舍

本方案借鉴了几条被证明有效的思路：

- 在**真正发起模型调用前**做统一预算判断，而不是只在 turn 开头估算一次。
- 优先对**高风险上下文源**做 source-level 收缩，再看整体是否仍超窗口。
- 对大内容提供**按需读取路径**，而不是逼模型反复消费长文本。

同时明确保留了 Wegent 自己的取舍：

- **检查点持久化进 `messages_chain`，而不是单独的 blob**（Phase 1）
  压缩那一轮成为自包含检查点（保留的近期 user 消息 + summary）落进它自己的
  `messages_chain`，reload 从最新检查点开始。功能上接近 Codex 的
  `replacement_history`，但复用现有持久化而非新增字段。Phase 2a 进一步通过
  request-local checkpointer 读取权威 LangGraph state，让这份持久化不再依赖该轮
  以何种方式结束。详见 Phase 1 与 Phase 2a 两节。
- **不把 summary compact 变成长期记忆层**
  它是 request-time 治理手段，不是新的会话存储模型。
- **不让单个 fallback 路径承载全部功能**
  tool output、summary compact、attachment preview 都是主路径能力，不是互相替代的兜底。

## 三个阶段各自解决了什么

## Stage 1：工具输出治理与状态可观测

Stage 1 的重点不是历史压缩，而是先把最容易失控的 source 收口，并让系统看得见当前上下文压力。

主要结果：

- 引入 `UnifiedContextGuard` 框架，并挂到 `pre_model_hook`
- 用 `ToolOutputGuardAdapter` 把超长工具输出改写成稳定紧凑格式
- 去掉旧的序列化期 tool truncation，避免双重截断和元数据漂移
- 输出 `context_metrics` 快照，并把状态传到前端 toolbar
- 支持 reload / reconnect 后恢复最近一次上下文状态

这一阶段建立的是**治理骨架和观测面**，不是最终压缩策略。

## Stage 2：总结压缩与预算闭环

Stage 2 把 request-level 治理补齐：当 source-level 收缩后仍接近窗口上限，就对完整 live state 做 summary compact。

主要结果：

- summary compact 进入 `UnifiedContextGuard` 的 Stage 2 主路径
- pre-turn 和 mid-turn 复用同一条预算判断与压缩链路
- 以平坦 reserved-output buffer 计算可用输入预算，而不是直接拿模型最大输出上限当保留值
- compaction 结果持久化到 `subtask.result.context_compactions`
- 增加 `[SummaryCompact]` 日志和完成态恢复逻辑

这一阶段的关键不是“总结能力”本身，而是**把整体上下文预算变成闭环**。

## Stage 3：附件预览与按需读取

Stage 3 解决的是另一个长期问题：附件提取文本会作为 `<attachment>` 块常驻注入，每轮都吃上下文，而且一旦进入 summary compact，往往会连同用户提问一起被折叠。

主要结果：

- 附件从“全文常驻注入”改成“有界 preview”
- preview 预算由 chat shell 用 token 口径控制，而不是单纯字符数
- 完整内容通过沙箱原文或 `read_attachment` 工具按需取
- 文本类与二进制类附件给出不同的 full-content hint
- 预览、tool output、summary compact 共用统一的保护 traces 结构

这一步的实质是把附件从“隐式历史负担”改成“显式可控上下文源”。

## Phase 1：检查点 reload 与卡死加固

Phase 1 补齐了 Stage 2 遗留的两个缺口。

### 检查点 reload（不再全量复原膨胀）

此前每个新 subtask 都会 reload 完整原始转录并重跑一次全量压缩——跨多天的长会话意味着每一新轮都要压缩约 1.7M tokens。Phase 1 把压缩那一轮做成**自包含检查点**：

- `_select_recent_user_messages` 把保留的近期 user 消息克隆成新 id 并打上 `checkpoint_retained` 标记，让本轮序列化器把它们保留进 `messages_chain`（和带 `summary_compacted` 的 summary、以及其后同轮生成的 suffix 一起）。
- backend 历史接口新增 `from_latest_compaction=true`：用 chain 内 `summary_compacted` 标记定位最新检查点，返回 `[检查点 chain] + [其后完整 turns]`；`limit` 绝不截断检查点 chain 本身。
- HTTP 端点与 package 模式共用同一条 `resolve_history_subtasks` 管线，保证 fork、`before_message_id`、`limit`、检查点切片语义一致。
- 由于 HTTP 传输会丢弃 `additional_kwargs`，reload 回来的 summary 通过内容标记重新识别，避免被再次当作 user 消息保留。

### 卡死加固

针对一次生产卡死（O(n²) 裁剪把 CPU 打满数分钟、随后 backend 读超时取消该轮）对 summary 压缩路径做了加固：

- 裁剪改为对 sanitized prompt 的单趟 O(n) 预算裁剪（不再每删一条重算、不再每条消息叠加一次 reply-priming）
- 压缩期间心跳 ticker 持续发 `summary_compact` in_progress 状态，保持 SSE 不断连，不再与 backend 读超时赛跑
- summary LLM 调用带 provider 超时 + `asyncio.wait_for` 兜底
- 超长判定识别 HTTP 413 与非英文 marker；裸 400 不再直接当超长（避免重试风暴）

## Phase 2a：终止路径无关的权威状态持久化

Phase 1 让压缩那一轮成为自包含检查点，但持久化仍依赖 happy path：该轮的
`messages_chain` 由 `_collected_state_messages` 序列化而来，而后者是在顶层
`on_chain_end` 事件里、用“保留最长快照”门槛捕获的。两个后果：

- 触发 `GraphRecursionError`（工具调用上限）时顶层 end 可能根本不触发，recovery
  又用请求前的 `lc_messages` 重建 chain —— 于是一轮“既压缩又撞工具上限”只持久化了
  recovery 回复，静默丢掉检查点，下次续聊回退到更早的检查点。
- 压缩会让 state **变短**，“最长快照”门槛可能拒绝真正的压缩后权威状态。

Phase 2a 让**最后的权威 LangGraph state** 成为唯一收口的唯一来源，覆盖所有终止路径。

### request-local checkpointer + `aget_state`

- 每次构建 agent 都挂一个 **request-local `InMemorySaver`**，每轮（以及每层截断重试）
  用唯一 `thread_id` 且 **`durability="exit"`**。exit 只在图退出时（含异常退出）提交
  一份 checkpoint，因此 `aget_state(config)` 能取到压缩后的权威状态（summary + 压缩后
  已完成的 tool pair），内存约 ~1×，而不是每个 super-step 一份。已删除失效的
  `ENABLE_CHECKPOINTING` 开关，checkpointer 不再可选。
- `_finalize_turn_history` 是唯一的原子收口：sanitize tool pair → 用 turn 不变的
  `original_input_ids`（见 `TurnExecutionContext`）过滤本轮新消息 → 序列化校验 →
  同时设置 `_last_messages_chain`、`_last_live_state_messages`、
  `_last_termination_reason`，三者不会漂移。
- 所有**流式**终止路径都经它：正常结束、`completed_with_unexecuted_tool_calls`、
  工具上限 recovery、截断重试与重试耗尽、silent/deferred。旧的
  `_collected_state_messages` / 长度门槛权威判定已移除。
- **finalizer 执行 ≠ 落库**：finalizer 只在 builder 上设置内存里的
  `_last_messages_chain`；它是否 durable 落进 `subtask.result.messages_chain` 取决于
  终止状态。受支持的（COMPLETED 类）终止会落库；`FAILED` / `CANCELLED` 的携带与落库
  推迟到 Phase 2b（见下文“不在 Phase 2a 范围”）。因此 finalizer 可能在一条最终并不
  落库的路径上运行。
- **引擎级非流式**路径（`agent.execute` → `_collect_final_state_from_events`）**不**
  构建 `messages_chain`：它返回 LangGraph 最终 state（调用方只消费 content/tool-results，
  `messages_chain` 仅在流式路径落库）。它仍复用 request-local checkpointer、exit
  durability、recovery-from-current-state 与每轮 thread 释放，只是不产出持久化历史，
  故没有 finalizer。**注意**：HTTP `stream=false` 的追问**不属于**此类——它底层仍是
  `stream_tokens`，照常走 finalizer 与落库（见“统一入口”一节的覆盖边界）。

### recovery 与 retry 用当前状态，不用 `lc_messages`

- **工具上限 recovery** 把当前权威状态（sanitize 后）喂给 recovery LLM，使其能看到本轮
  已产生的工具结果；final state = `safe_state + [recovery 回复]`，内部指令不入库。
- **截断重试** 用当前权威状态（sanitize 后）**新开一个 thread** 重建（向同一 thread 重交
  并不会删掉被截断的 tool call —— `add_messages` 按 id 合并），并**继承根轮的
  `original_input_ids`**。截断指令走独立的 **attempt 控制平面**：它只放在
  `_attempt_guidance` 里，由 builder 自己的 `_attempt_guidance_hook`（挂在 pre-model
  链的最后一环）在**压缩之后**通过 `llm_input_messages` 注入模型输入，从不写入
  `messages` channel。因此它既不进 summary source、不进 checkpoint、不进
  `messages_chain`，也不与真实用户消息争抢 recent-user 预算；因为在压缩之后才追加，重试
  thread 自身压缩也不会把它裁掉，重试 attempt 结束即自然销毁。`chain_pre_model_hooks`
  会把 `llm_input_messages` 逐环向后滚动，让用户 guidance 与 attempt guidance 叠加而非互相
  覆盖。

### 生命周期与可观测

- 每层 `stream_tokens` 在自己的 `finally` 里删**自己那个** thread（`adelete_thread`），
  失败会记日志而非静默吞掉，且在删除前测量 `checkpoints_in_saver`。每轮输出一条持久化
  日志：`path`、`chain_msgs`、`has_summary_marker`、`post_compaction_tool_pairs`、
  `checkpoints_in_saver`、`adelete_thread_ok`。
- checkpointer 只是请求内读取权威状态的临时暂存，持久真源仍是
  `subtask.result.messages_chain`；不引入独立 checkpoint blob，重建逻辑不变 —— finalizer
  复用同一序列化器，recovery 路径的检查点与正常结束的检查点重建结果一致。

不在 Phase 2a 范围（推迟）：让非 `COMPLETED` 终止（FAILED / CANCELLED）携带并持久化
`messages_chain`，以及放宽检查点定位以识别它们。

## Phase 2b（已评估搁置）

Phase 2b 原计划让 FAILED / CANCELLED 终止也携带并落库 `messages_chain`。经评估后**主动搁置**，
理由如下：

- **性质是"省 token 优化"，不是"弥补数据丢失"。** 失败时用户已看到的 partial 回复经
  `collect_completed_result(status="FAILED")` 从流式 blocks 重建进 `result.value`，reload
  仍能看到；真正缺失的只是失败轮的结构化 `messages_chain`。而 compaction 只改运行时上下文、
  **从不改写更早 subtask 的记录**，所以续聊会重新加载全量原始历史并重压一次——代价是一次重复
  压缩的 token，而非用户可见内容丢失。
- **触发面窄。** 需 (同一轮内发生 compaction) ∩ (该轮以 FAILED 收尾)，交集小。
- **成本/风险不成比例。** 打通失败链需改 SSE `error` 终止事件契约（`error` 事件先于
  `response.completed` 终止 SSE 读取循环，且 `_status_updated` 会拦截后续更新），blast radius
  覆盖 SSE / WebSocket / HTTP callback 三种 transport。

**若将来要做，更省的方向：** 不要把 chain 从 error 终止事件里艰难打通，而是在 **compaction
发生的那一刻就把 summary 落成独立持久化记录**（而非等 turn 结束），使其对任何结束态天然免疫。
重启条件：telemetry 显示失败重压 churn 可观，或届时正好要动 compaction 持久化结构。

## 实现落点

下列模块是后续维护最值得先看的入口：

| 模块 | 作用 |
|---|---|
| `chat_shell/guard/context_guard.py` | 统一治理主入口，串 source pass、summary compact、emergency pass |
| `chat_shell/guard/tool_output.py` | tool output 的 compact 表示和紧急重截断 |
| `chat_shell/compression/summary_compactor.py` | summary compact 主逻辑、O(n) 裁剪、检查点保留 |
| `chat_shell/compression/tool_sanitizer.py` | 共享 `sanitize_tool_pairs`，压缩 / recovery / finalizer 共用（Phase 2a） |
| `chat_shell/guard/composition.py` | `chain_pre_model_hooks`：组合多个 pre-model hook，`llm_input_messages` 逐环滚动叠加 |
| `chat_shell/agents/graph_builder.py` | request-local exit-durability checkpointer、`_finalize_turn_history`、attempt 控制平面（`_attempt_guidance_hook`）、各终止路径处理（Phase 2a） |
| `chat_shell/agents/turn_context.py` | `TurnExecutionContext`：turn 不变的 `original_input_ids` + 每层 thread 所有权（Phase 2a） |
| `chat_shell/history/loader.py` | 历史 reload；透传 `from_latest_compaction` |
| `backend/app/services/chat/compaction_checkpoint.py` | 定位最新检查点 + 共享 resolve→scope→limit 管线（Phase 1） |
| `chat_shell/compression/config.py` | 上下文窗口、reserved output、trigger/target limit 计算 |
| `chat_shell/compression/context_metrics.py` | 上下文指标快照 |
| `chat_shell/messages/attachment_preview.py` | 附件 preview 预算分配与截断 |
| `chat_shell/tools/builtin/read_attachment.py` | 附件按需读取 |
| `chat_shell/services/chat_service.py` | guard、tracker、summary llm 的组装位置 |

如果只想理解 Stage 3 细节，继续看 [Chat Shell 附件上下文管理（预览与按需读取）](./chat-shell-attachment-context.md)。

## 可观测性

当前最稳定的观测面有四类：

- `context_metrics`
  用于展示当前窗口、已用 token、剩余比例和 trigger 状态。
- `[SummaryCompact]` 日志
  用于排查压缩是否触发、是否 fallback、压缩前后 token 变化。
- `subtask.result.context_compactions`
  用于离线统计 summary compact 次数、成功率、token 节省等。
- `context_protection.{operation}` traces
  用于统一统计 `tool_output`、`summary_compact`、`attachment_preview` 的耗时与节省量。

三个防护统一通过 `chat_shell/guard/traces.py::record_protection_trace` 发出，事件名 `context_protection.{operation}`，schema 一致，便于聚合**事件数 / 成功率（按 status）/ 耗时（duration_ms）/ token 节省**：

| operation | 触发点 | status | 关键属性 |
|---|---|---|---|
| `attachment_preview` | 含附件块的消息 | `applied` / `noop` | duration_ms, before/after_tokens, tokens_saved, attachment_blocks_truncated |
| `tool_output` | 工具输出截断（仅发生时） | `applied` | duration_ms, messages_truncated, emergency |
| `summary_compact` | 请求级摘要压缩 | `completed` / `fallback` | duration_ms, before/after_tokens, tokens_saved, removed_history_items / failure_reason |

为避免噪声空跑不发事件（`tool_output` 仅截断时、`attachment_preview` 仅有附件块时）；telemetry 关闭时 `add_span_event` 为 no-op。

这也是为什么 Stage 1 先补“状态与指标”，再做 Stage 2/3：没有观测面，很难知道治理是否真的生效。

## 注意事项

### reload 从最新压缩检查点开始（Phase 1）

早期实现每一轮都从完整存储历史重建并重新评估压缩，长会话会因此“复原膨胀”。Phase 1 把自包含检查点持久化进压缩那一轮的 `messages_chain`（保留的近期 user 消息带 `checkpoint_retained`，summary 带 `summary_compacted`），并通过 backend 的 `from_latest_compaction` 路径从最新检查点 reload。详见上面的 Phase 1 一节。

### `max_output_tokens` 主要是预算输入，不是历史改写结果

上下文治理会用 `context_window` 和 `max_output_tokens` 参与 reserved-output 预算计算，但 live history 的改写本身不会反向修改模型实例参数。排查 provider 请求参数时，应优先看 `model_config` 传入链路，而不是先怀疑 guard 改写了参数。

### 附件 preview 只在 chat shell 侧做 token 化

backend / shared 不依赖 `tiktoken`。因此：

- shared 适合放纯字符串头部和 MIME 归类逻辑；
- token 预览必须放在 chat shell；
- executor / device 路径看到的是注入后的字符串，不具备 `read_attachment` 这个 chat-shell-only 工具。

### 不要混淆 raw transcript 和 model-visible transcript

后续如果有导出、恢复、协议兼容改动，必须先确认读取的是：

- 用户可见的原始输出
- 还是模型下一轮会看到的 compact 版本

很多“为什么内容变短了/为什么前端还显示全文”的问题，本质上都是这两个视图被混用了。

## 相关文档

- [Chat Shell 附件上下文管理（预览与按需读取）](./chat-shell-attachment-context.md)
- [Dynamic Context（动态上下文注入）](./dynamic-context.md)
