---
sidebar_position: 20
---

# 任务时间占用 Profile

## 目标

让研发/进阶用户在长时间任务中主动打开一个会话级时间占用 profile，在不阅读日志的情况下快速判断：

1. 时间被 Agent 工作、等待用户、排队、环境准备、工具或子 Agent 分别占用了多少
2. 当前卡在谁身上：根 Agent、子 Agent、运行时，还是等待用户
3. 父子 Agent 与并行 Agent 的重叠关系是什么，关键路径在哪里
4. 哪些时间没有可靠采样，需要作为未知空档呈现

产品目标是时间占用的统计与可视化，wall time 是自然的时间轴之一，但不是唯一目标。它不
追求严格分布式追踪，也不假设每个区间都能被精确归属；数据必须使用统一的区间模型，避免
为了简单百分比而伪造不可靠的归因。

## 问题

公共执行器任务经常运行较长时间。现有 UI 可以显示剩余上下文、模型选择和单轮回复耗时，但缺少会话级整体视图，用户难以判断：

- 任务是否长时间停留在队列中
- 是否在创建容器或等待运行环境就绪时耗时过长
- 是否在初次派发时重试或阻塞
- Agent 是否在等待用户回复，而不是实际执行
- 父 Agent 与子 Agent 是否并行，瓶颈在父协调、某个子 Agent，还是关键路径上的工具
- 未被采样覆盖的时间到底是可解释空档，还是缺失数据

现有计时数据分散在 executor_manager、executor、backend 和前端状态中，没有一个按会话聚合的稳定结构。

## 现有可采样点

### executor_manager 队列

`TaskQueueService` 已经记录：

- `enqueued_at`：任务进入 Redis 队列的时间
- `dequeued_at`：consumer 取出任务的时间

当前 pending record 主要用于 stalled dispatch 检测，任务成功派发后会被清除。因此需要把队列时间随执行结果传递，而不是依赖 pending record 保留历史。

### executor_manager 运行时准备

通用 executor 抽象已经有清晰边界：

- `create_instance`
- `wait_instance_ready`
- `dispatch_task_to_instance`

Docker executor 已实现这些边界。新增采样可以覆盖现有 executor 实现，并保持 Kubernetes/E2B 等实现的可扩展性。

### executor 事件

Executor 已经产生 `response.created`、`response.completed`、`response.failed`、`response.incomplete`，并在部分 Codex 路径中携带：

- `startedAt`
- `completedAt`
- `durationMs`

工具和子 Agent block 已有 `createdAt`、`completedAt`、`durationMs` 等字段。

### 用户等待

Executor 本地任务状态已有 `interaction_status`：

- `waitingForUserInput`
- `awaitingUserReply`
- `waitingForApproval`

状态切换时会更新 `RuntimeTaskLink.updated_at` 并发出 `runtime.work.changed`。这可以作为
`waiting_user` 区间的权威起点；用户提交回复、审批结束或状态清除时结束该区间。

### 子 Agent

Executor 已有：

- `response.subagent.activity` 事件
- `agent_path` / `agent_thread_id`
- `occurred_at_ms`
- started / running / done / error 等状态
- transcript 中 `type: "subagent"` block，包含 `timestamp`、`completedAt`、`durationMs`

Backend project projection 也会把子 Agent 活动投影为带 `parent_agent_id`、
`subagent_id`、`parent_message_id` 的活动记录。父子关系和并行区间有现成采样点。

### Backend 回调

`POST /api/internal/callback` 是 executor 事件的统一入口。回调请求已经携带 task/subtask 身份和事件数据，适合扩展少量 timing metadata，而不需要新增主数据通道。

## 非目标

本阶段不包含：

- 精确模型 token 延迟分析
- CPU、内存或网络性能剖析
- 独立 OpenTelemetry 后端部署与查询系统
- 跨任务报表
- 精确到每次模型调用的自动归因，除非底层事件已经提供可靠区间
- 为所有 shell 类型强制补齐所有时间字段

缺失时间字段时 UI 必须显示不可用，不允许伪造或用客户端时间替代服务端事实。

## 设计原则

1. 以一个会话为聚合单位，一次 subtask execution 是会话中的一组区间。
2. 使用 span/interval 表示时间，不使用一串互斥阶段百分比。
3. 保留父子关系和 actor 身份；子 Agent 可以并行，不能把子 Agent 时长相加当作会话耗时。
4. 主要 duration 在同一组件内派生；跨组件绝对时间只用于粗粒度对齐和诊断。
5. Agent active 与 waiting user 是两种状态，不把用户未回复时间算进 Agent 执行。
6. 未知空档显式显示为 gap，不摊派到其它阶段。
7. 产品功能不依赖 OpenTelemetry 是否开启。
8. 复用 `ExecutionEvent`、callback、runtime 事件和前端 block 数据结构，不引入并行事件协议。

## 业界实践

这个需求本质上是 tracing/profile 视图，而不是普通指标图表。可借鉴的既有实践包括：

| 来源 | 可借鉴点 | Wegent 取舍 |
| --- | --- | --- |
| Chrome DevTools Performance | 顶部 summary 与可下钻泳道、Main/Network/Timings 分轨、未知空档保留 | 使用用户主动打开的会话面板，主视图默认不改变 |
| 火焰图 / KCachegrind | inclusive/exclusive/critical path 分离；并行调用不简单相加 | 父 Agent 显示 inclusive，子 Agent 独立泳道，根路径聚合用区间并集 |
| OpenTelemetry Traces | Trace + Span + parent/attributes；span 可重叠、可嵌套 | 保留 OTel 语义但内嵌到任务 UI，不要求外部 OTel 后端 |
| Langfuse / LangSmith | LLM 调用、工具、嵌套 run 的 latency tree | 先做产品级时间线，后续可选导出 OTel |

## TimingSpan 数据契约

### 字段

统一使用会话级 span：

```json
{
  "id": "span-123",
  "traceId": "session-42",
  "parentId": "span-root",
  "kind": "agent",
  "actor": {
    "id": "root-agent",
    "type": "root-agent",
    "label": "Root Agent"
  },
  "turnId": "turn-7",
  "subtaskId": 123,
  "status": "completed",
  "startAt": 1780000000000,
  "endAt": 1780000123000,
  "durationMs": 123000,
  "clock": "executor",
  "source": "executor-response"
}
```

所有时间为 epoch milliseconds；executor_manager 现有的 queue 秒级时间在注入时必须统一转换为毫秒。字段可以缺失，缺失表示该区间没有被观察到。

### kind

第一版：

- `session`：会话总区间，从第一条用户消息到当前或任务结束
- `agent`：根 Agent 或子 Agent 执行
- `subagent`：子 Agent，可有 parent
- `tool`：工具执行
- `queue`：队列等待
- `provision`：环境创建、就绪、派发
- `waiting_user`：等待用户输入、回复或审批
- `gap`：未被观测区间，由聚合器推导，不持久化为源数据

后续可扩展 `model`、`retrieval`、`permission`，但只在实际有可靠采样时增加。

### 时钟域

`executor_manager`、executor 和 Backend 是不同时钟域。产品不尝试跨机器校正时钟，span 必须保存产生它的组件名：

主要 duration 在同一组件内派生。跨组件 `startAt` 只用于泳道排序和明显异常检测；若某
组件时间戳明显越界，展示层将其标记为 `clock_suspect`，而不是静默修正。部署环境应保持
NTP/chrony 同步，但产品 overview 不依赖跨机器时钟差来计算主要耗时。

已实现的同组件 duration 字段仍可作为旧数据源：

```text
queueDurationMs -> queue span
provisionDurationMs -> provision span
agentDurationMs -> agent span
```

## 聚合规则

### 第一版 Triage 分层

第一版优先回答“应该找谁、下一步查什么”，不是提供完整 profiler。面板分三层：

1. **Triage**：用互斥拆分给出责任归属的大头：
   - 命令/工具执行
   - 子 Agent
   - Agent/模型自身
   - 等待用户
   - Infra/runtime（队列、环境准备、派发）
   - 未观测
2. **Top suspects**：最多 3-5 个可操作项，例如 `pnpm install 22m`、`git clone 12m`、
   等待用户确认 26m。这一层决定用户第一眼看到什么。
3. **Timeline/details**：泳道和 bottom-up 属于下钻层，不承担第一眼结论。

### 责任分类

第一版必须区分责任，而不是只展示技术层：

| 分类 | 指向 | 第一版数据来源 | 备注 |
| --- | --- | --- | --- |
| 命令/工具执行 | 任务/工程环境/网络 | tool span + tool name/input | 可识别 `npm`、`pnpm`、`uv`、`cargo`、`git` 等常见命令 |
| 网络/仓库 | Infra/网络配置 | git clone 事件、tool input 中的域名 | 第一版不做网络探测，只从命令名和域名做粗提示 |
| 模型/Agent | 模型或编排负责人 | agent exclusive + reasoning tokens | thinking 时间若无法从事件直接得到，归为 Agent 自身，不伪造模型细分 |
| 子 Agent | 编排负责人 | subagent span + parent | 看并行与 critical path |
| 等待用户 | 发起人 | interaction_status | 不算 Agent 执行 |
| Infra/runtime | Infra | queue/provision span | 排队、容器创建、就绪、派发 |
| 未观测 | 需要进一步排查 | gap | 不摊派 |

`npm/uv/cargo` 下载慢是否由 mirror 配置引起，第一版不做配置归因，只在 Top suspects 中
显示具体命令和耗时，让用户能判断“这是包管理命令慢”。后续可加配置提示或网络 span。

### 会话总览

```text
sessionWallMs = sessionEndAt - sessionStartAt
wallTimeMs = sessionEndAt - sessionStartAt
agentActiveMs = union(agent/subagent spans)
toolBusyMs = union(tool spans)
subagentBusyMs = union(subagent spans)
waitingUserMs = union(waiting_user spans)
runtimeMs = union(queue/provision spans)
unobservedMs = wallTimeMs - union(all observable spans)
```

核心是 union，不是求和：

- 两个子 Agent 并行 10 分钟，Agent active 仍按 10 分钟计，不按 20 分钟计。
- Agent A 等待用户，同时子 Agent B 继续运行时，waiting user 与 agent active 可以重叠，
  总览分别展示，不要求互斥。
- 工具嵌套在 Agent 内时不把 Agent 与工具相加。

`agentActiveMs`、`toolBusyMs`、`subagentBusyMs` 可以重叠。它们回答“这一类活动总共在
时间轴上覆盖了多少”，而不是“它们如何瓜分会话 wall time”。如果需要一个瓜分视角，另行
计算互斥分类：

```text
exclusiveAgentMs = union(agent spans) - union(child/subagent/tool spans within agent)
runtimeOnlyMs = runtime union not covered by agent spans
```

互斥分类必须显式命名为 exclusive / breakdown，不与 union 总览混用。

### 父子 Agent

- 父 Agent span 的时长是 inclusive duration。
- 子 Agent 有独立泳道，可并行。
- 父 Agent 的 exclusive duration 不等于“父时长 - 子时长”的总和；应计算父区间减去子区间
  union，且明确它包含模型、工具和未细分协调时间。
- critical path 以会话终点为终点，从时间上最后结束的子区间反向选择决定其结束时间的路径。
  并行分支中未决定终点的分支不进入 critical path。

### 用户等待

优先使用 executor 的 `interaction_status` 状态切换：

1. 状态从空变为 `waitingForUserInput` / `awaitingUserReply` / `waitingForApproval` 时开启
   `waiting_user` span。
2. 状态清除、用户提交、审批结束或终态到达时关闭 span。
3. 重复状态切换只刷新状态，不开启重复 span。
4. 若只知道开始时间而任务仍在等待，运行中视图显示 open span；刷新页面后从持久化
   timing spans 恢复。

## 存储

新增会话级 `task_timing_spans` 表，而不是把所有 span 塞进 subtask result：

```text
id
trace_id / session_id
task_id
subtask_id
turn_id
parent_span_id
span_id
kind
actor_id
actor_type
actor_label
status
start_at
end_at
duration_ms
clock
source
metadata JSON
created_at
updated_at
```

原因：

- 会话级视图需要跨 subtask 和异步子 Agent 查询。
- open span 需要更新，不能只依赖终态 result。
- subtask result 是回复内容投影，不适合作为运行诊断索引。

按 `span_id` 幂等 upsert；重复回调只补充空字段，不覆盖第一次观察到的边界。

## 数据流

### 1. 队列与准备阶段

executor_manager 在 queue/provision 边界产生或传递 `queue` / `provision` span。

### 2. Executor

Executor 产生：

- `agent`
- `subagent`
- `tool`
- `waiting_user`

跨进程路径先通过 callback 携带，本地 runtime 路径通过现有 runtime 事件携带。

### 3. Backend

Backend 归一化、补 `clock` / `source`、按 `span_id` 幂等写入 `task_timing_spans`。

### 4. 会话端点

按 `trace_id` 聚合，返回 summary、swimlanes 和 critical path。

```json
{
  "summary": {
    "wallTimeMs": 4320000,
    "coverage": {
      "agentActiveMs": 2280000,
      "toolBusyMs": 1860000,
      "subagentBusyMs": 1320000,
      "waitingUserMs": 1560000,
      "runtimeMs": 240000,
      "unobservedMs": 240000
    },
    "exclusiveBreakdown": {
      "toolMs": 1440000,
      "subagentMs": 720000,
      "agentMs": 240000,
      "waitingUserMs": 1560000,
      "runtimeMs": 120000,
      "unobservedMs": 240000
    }
  }
}
```

coverage 与 exclusive breakdown 必须分开返回，前端不得混用同一字段。

已实现的 per-turn `result.timing` 不作为最终模型。它可转换为几个基础 span；旧任务没有
span 时显示“时间线不可用”，不允许用客户端时间补齐。

### 语义

- 复用已有 executor 的任务不记录容器创建 span。
- `prepare_only` 任务只记录已发生 span。
- 失败任务保留已观察到的 span，不允许因为失败而丢弃 timing。
- 多次回调重试时，第一次观察到的边界优先，后续重复值不得覆盖已有边界。
- 服务端时间是权威来源；前端本地时间只用于运行中的实时估算。

## UI 设计

### 入口

用户主动触发，入口放在对话输入区的集中操作台。Wework 的 `ComposerToolbar` 已经集中放置：

- 剩余上下文 token
- 模型选择
- 权限模式
- 插件
- 工作区/执行模式
- 发送/暂停操作

新增一个“耗时分析”图标按钮，与这些操作台控件并列。该按钮只在当前任务存在可分析数据或
任务正在运行时可用；无数据时保留入口但显示不可用状态，避免用户找不到功能。

第一期不提供 `/timing` 快捷命令。`timing` 过短，容易与后续插件类命令冲突；先通过
`ComposerToolbar` 按钮建立唯一入口，避免过早占用短命令名。Wework 已有 `/model`、
`/plan`、`/goal`、`/compact` 这类“触发 UI 或运行时动作”的快捷命令，因此后续如果有
真实需求，可以使用 `/timing-analysis` 或 `/time-profile` 这类更完整的命名。新增命令
时必须与按钮复用同一 handler，避免两套状态。

第一期也不把面板注册为独立 DSH 插件菜单，避免把内置诊断功能做成扩展形态。

Web 也遵循同一语义：入口放在对话 composer toolbar 的诊断/工具区域，而不是消息气泡。

点击后打开右侧分析面板或全宽 Sheet，不把分析视图常驻在聊天正文。面板打开状态由用户
控制，默认不影响输入区布局。

### 入口层次

第一版不做常驻 mini chart。理由是剩余 token 是输入决策信息，用户在发送前需要持续看到；
时间 profile 是诊断信息，只在用户怀疑慢或要优化时需要。一个按钮比常驻图形更符合操作台
的可读性。

后续如果需要轻量提示，可显示“耗时分析”按钮上的红点或总耗时数字，但不默认展开图形。
- 面板可从会话开始看到当前时刻，运行中定期刷新 open span

### Overview

```text
Wall time 1h 12m
最可能耗时点：命令/工具执行 31m · 等待用户 26m · 子 Agent 12m · Infra 4m
关键路径：Root Agent -> Worker B -> build command
```

第一版默认打开 **互斥拆分**，而不是 Coverage。原因：

- 用户最初的问题是“时间花在哪、找谁”，互斥拆分更接近答案；
- Coverage 允许重叠，第一眼容易误解为百分比；
- Coverage 保留为第二视角，供研发进一步分析并行活动。

顶部提供两个视角：

1. **Coverage**：展示各类活动的区间 union。数值可以重叠，用于回答“某类活动覆盖了多少
   时间”。
2. **Exclusive breakdown**：按优先级拆分会话 wall time，数值互斥，用于回答“时间被谁
   占用”。

```text
Coverage
Agent active   ████████████████ 38m
Tool busy      ████████████ 31m
Subagent busy  ████████ 22m
Waiting user   ██████████ 26m

Exclusive breakdown
Tool           █████████ 24m
Subagent       █████ 12m
Waiting user   ██████████ 26m
Runtime        █ 4m
Unobserved     █ 4m
```

Coverage 与 exclusive breakdown 分开命名，避免把并行活动的时间相加或强行瓜分。

### Swimlanes

```text
User        ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
Root Agent  ████    ████████    ███
Worker A        ███████
Worker B          █████████████
Runtime      ▌        ▌
Gap              ▨   ▨
```

- User 泳道显示用户消息和 waiting_user 区间
- Root / child agents 各一条泳道，保持父子缩进
- Tool 归属在其调用者泳道下，必要时折叠为 caller 内部的小行
- Runtime 泳道显示 queue/provision
- Gap 使用浅色或斜纹，明确是未观测
- 悬停显示绝对时间、duration、source、clock 和状态
- 支持缩放；默认自动聚焦最长活动窗口，同时保留会话全宽 overview

泳道的横轴是 wall time。这里不要求所有区间来自同一时钟；跨机器时间只用于排序。主要
duration 展示在 tooltip 与详情中，避免时钟差影响条宽解读。

### Bottom-up

概览下方显示最耗时的具体项：

- Tool: `pnpm test` 12m
- Subagent: Worker B 18m
- Waiting user: approval 26m

第一版只保留 Top 3-5 个 suspects，默认显示：

- 名称，如 `pnpm install`
- 责任分类
- duration
- 状态
- 一句话建议，如“检查 registry/mirror 或网络”

完整 bottom-up 表格移到下钻视图，不作为第一屏默认内容。

### Callback review

与常见工具对齐后的取舍：

| 工具 | 可借鉴 | 第一版取舍 |
| --- | --- | --- |
| Chrome DevTools Summary | 第一屏给出大类占比和主线索 | 保留互斥大类 + Top suspects |
| Chrome Network/Waterfall | 按请求看耗时与阻塞 | 第一版只通过 tool span 近似，不做 HTTP 捕获 |
| 火焰图 | inclusive/exclusive/critical path | 不做火焰图；保留 agent/subagent 泳道下钻 |
| OTel/Jaeger | span/parent/trace | 数据模型保留；UI 不做完整 trace 树 |
| Langfuse | LLM call latency tree | reasoning 归入 Agent/模型分类，不伪造逐次 LLM call span |
| KCacheGrind | callee 分组与 self/inclusive | 借鉴 self/exclusive 概念，但第一版不展示树形全量数据 |

### 降级

- 老任务没有 span：显示不可用
- 只有 per-turn timing：显示每轮基础阶段，不显示会话泳道
- 子 Agent 只有状态没有 start/end：显示状态点，不绘制区间
- 等待用户缺结束时间：运行中显示 open span；终态后仍缺结束则显示 unknown end

### 主题与响应式

- 面板必须使用 Wegent design tokens，支持 light/dark theme；
- 深色主题不是简单反转，需要降低大面积颜色饱和度，确保 gap、running、error 状态可区分；
- 桌面使用 right split panel，移动端使用 bottom sheet 或全屏页面，不复用桌面 split；
- 移动端第一屏只显示 Triage 大类、Top suspects 和时间范围，泳道和表格通过“查看详情”进入；
- 触控目标至少 44px；
- 时间线和表格在移动端优先显示 top 5，不默认渲染全量数据；
- 图表颜色需满足对比度要求，深浅主题下都不得仅用颜色表达状态。

## 兼容性

- 老任务没有 timing span 时显示“耗时时间线不可用”。
- 新事件对老 Backend 必须可忽略；timing span 是可选字段。
- 新 Backend 读取老 executor 事件时不得因为缺 timing span 而失败。
- Web 和 Wework 复用 `packages/collaboration` 的展示组件。
- 不改变现有 `data-testid`，新增控件使用新的描述性 `data-testid`。

## 测试计划

### executor_manager

- 产生 queue/provision span
- 复用容器路径不记录容器创建 span
- 派发失败时保留已观察 span
- `prepare_only` 保留已观察 span

### executor

- Agent turn 产生 agent span
- 子 Agent activity 产生 subagent span，并保留 parent
- 工具 block 产生 tool span
- `interaction_status` 切换产生/关闭 waiting_user span
- 运行中 span 可恢复
- timing 不进入 prompt 或工具参数

### backend-rs

- callback 归一化 span
- 按 `span_id` 幂等 upsert
- 重复回调只补充空字段
- 老事件缺失 timing span 正常处理
- 会话聚合返回 coverage、exclusive breakdown、swimlanes 和 critical path

### 前端

- 用户主动打开面板
- summary 与 union 计算
- 泳道布局与父子缩进
- coverage 使用区间 union，并行子 Agent 不重复计入
- exclusive breakdown 分开计算并可解释
- waiting user 与 agent active 重叠展示
- gap 与 missing data 降级
- Web 与 Wework 复用组件

## 实施顺序

1. 定义 TimingSpan schema 和数据库迁移
2. executor_manager 把 queue/provision timing 转为 span
3. executor 补 agent/subagent/tool/waiting_user span
4. backend-rs 幂等写入并提供会话聚合端点
5. 前端用户主动打开的耗时分析面板
6. 补充 focused tests

## 后续阶段

### Agent 内部近似归因

基于现有 block 时间归并为：

- 工具执行
- 子 Agent
- 模型/推理
- 区间空档

该阶段继续明确标注为近似归因。

### 跨执行对比

展示同一任务、Agent 或模型维度的：

- 总耗时趋势
- 队列时间趋势
- 运行环境准备趋势
- Agent 执行趋势
- Top slow items 变化

等第一版数据稳定后再设计。
