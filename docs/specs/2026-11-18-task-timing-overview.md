---
sidebar_position: 20
---

# 任务 Wall Time 阶段总览

## 目标

为一次任务执行提供粗粒度 wall time 总览，让用户在不阅读日志的情况下快速判断时间主要消耗在：

1. 队列等待
2. 公共执行器运行环境准备
3. 任务派发
4. Agent 执行
5. 结果处理与回调

本阶段不追求精确性能剖析。它是产品级 overview，不是 profiler，也不是完整的 OpenTelemetry span 树。

## 问题

公共执行器任务经常运行较长时间。现有 UI 可以显示单个工具或单轮回复的耗时，但缺少跨层级的整体视图，用户难以判断：

- 任务是否长时间停留在队列中
- 是否在创建容器或等待运行环境就绪时耗时过长
- 是否在初次派发时重试或阻塞
- 时间主要消耗在 Agent、模型、工具，还是基础设施等待

现有计时数据分散在 executor_manager、executor、backend 和前端状态中，没有一个按执行聚合的稳定结构。

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

### Backend 回调

`POST /api/internal/callback` 是 executor 事件的统一入口。回调请求已经携带 task/subtask 身份和事件数据，适合扩展少量 timing metadata，而不需要新增主数据通道。

## 非目标

本阶段不包含：

- 精确模型 token 延迟分析
- CPU、内存或网络性能剖析
- 完整 OpenTelemetry span 树
- 跨任务报表
- 新建独立 tracing 页面
- 为所有 shell 类型强制补齐所有时间字段

缺失时间字段时 UI 必须显示不可用，不允许伪造或用客户端时间替代服务端事实。

## 设计原则

1. 以一次 subtask execution 为聚合单位。
2. 保存阶段边界时间，而不是只保存 duration，便于绘制区间和处理乱序事件。
3. 阶段之间允许存在空档；不承诺所有阶段百分比相加为 100%。
4. 产品功能不依赖 OpenTelemetry 是否开启。
5. 不新增数据库表；第一版把 timing summary 放入现有 subtask result metadata。
6. 复用 `ExecutionEvent`、callback 和前端 block 数据结构，不引入并行事件协议。

## Timing 数据契约

### 字段

第一版在 subtask result 中保存：

```json
{
  "timing": {
    "enqueuedAt": 1780000000000,
    "dequeuedAt": 1780000123000,
    "instanceCreateStartedAt": 1780000123100,
    "instanceCreateFinishedAt": 1780000141000,
    "instanceReadyAt": 1780000149000,
    "taskDispatchedAt": 1780000149900,
    "agentStartedAt": 1780000150000,
    "agentFinishedAt": 1780001100000,
    "terminalReceivedAt": 1780001100500
  }
}
```

所有时间为 epoch milliseconds；executor_manager 现有的 queue 秒级时间在注入时必须统一转换为毫秒。字段可以缺失，缺失表示该阶段没有被观察到。

### 时钟域

`executor_manager`、executor 和 Backend 是不同时钟域。第一版不尝试跨机器校正时钟，阶段耗时优先使用同一个组件派生的 duration 字段：

```json
{
  "queueDurationMs": 123000,
  "createDurationMs": 18000,
  "waitReadyDurationMs": 21000,
  "dispatchDurationMs": 900,
  "agentDurationMs": 920000
}
```

这些 duration 分别由 executor_manager 或 executor 在同一时钟域内计算。UI 不再展示跨时钟域的 `terminalReceivedAt - agentFinishedAt` 阶段；该字段仅保留为诊断数据。部署环境应保持 NTP/chrony 同步，但产品 overview 不依赖跨机器时钟差来计算主要阶段耗时。

### 派生阶段

展示层或后端聚合器可以派生：

| 阶段 | 计算 |
| --- | --- |
| 队列等待 | `queueDurationMs` |
| 容器创建 | `createDurationMs` |
| 等待就绪 | `waitReadyDurationMs` |
| 初次派发 | `dispatchDurationMs` |
| Agent 执行 | `agentDurationMs` |

容器创建、等待就绪和初次派发可以合并展示为“运行环境准备”。

### 语义

- 复用已有 executor 的任务不记录 `instanceCreateStartedAt` 和 `instanceCreateFinishedAt`。
- `prepare_only` 任务只记录已发生阶段。
- 失败任务保留已观察到的阶段，不允许因为失败而丢弃 timing。
- 多次回调重试时，第一次观察到的边界优先，后续重复值不得覆盖已有边界。
- 服务端时间是权威来源；前端本地时间只用于运行中的实时估算。

## 数据流

### 1. 队列与准备阶段

`TaskQueueService` 保持 pending record 现有用途。在 task 被 dequeue 时，把 `enqueued_at`、`dequeued_at` 注入任务 payload 的 timing metadata。

`DockerExecutor` 或通用 executor 编排层在调用抽象方法前后记录：

- `create_instance` 开始/结束
- `wait_instance_ready` 结束
- `dispatch_task_to_instance` 结束

记录逻辑应尽量放在通用编排层，避免每个 executor 重复实现。若某实现绕过通用边界，其阶段显示为不可用，而不是猜测。

### 2. Executor 阶段

Executor 收到请求时记录 `agentStartedAt`。

终态事件中携带：

- `agentStartedAt`
- `agentFinishedAt`
- 已从 executor_manager 继承的 timing metadata

事件负载中的 timing metadata 不进入模型提示词，也不进入工具参数。

### 3. Backend 汇聚

Backend callback 处理器：

1. 读取事件中的 timing metadata
2. 记录 `terminalReceivedAt`
3. 归并到 subtask result 的 `timing` 字段
4. 保留第一次观察到的边界

持久化跟随现有 subtask result 更新路径，不新增数据库迁移。

### 4. 前端读取

前端从 subtask result 读取 timing summary，并在 assistant 消息的处理区域展示。

实时任务可以显示已观察阶段和当前运行中的 Agent 阶段，但不把客户端时间持久化为最终时长。

## UI 设计

### Summary

在现有 assistant 消息用时旁边展示紧凑摘要：

```text
总用时 18m 32s · 排队 2m 10s · 准备 48s · Agent 15m 20s
```

缺失阶段不显示或显示为 `N/A`，必须避免让用户误以为该阶段耗时为 0。

### Stage waterfall

点击摘要后展开轻量区间视图：

```text
排队等待     ████████ 2m 10s
容器创建     ██ 18s
等待就绪     ██ 21s
任务派发     ▏ 0.9s
Agent 执行   ████████████████ 15m 20s
终态回调     ▏ 0.5s
```

图形按各阶段 duration 的相对占比绘制，不按跨时钟域的绝对时间强行铺满。

### Top slow items

第一版可以从既有 block 数据中展示最多三个最耗时项：

- 工具名或子 Agent 标题
- `durationMs`
- 状态

Agent 内部的模型、工具、子 Agent 精细归因属于第二阶段，第一版只做保守展示。

## 兼容性

- 老任务没有 timing 字段时显示“耗时明细不可用”，总耗时继续使用现有 turn duration 逻辑。
- 新事件对老 Backend 必须可忽略；timing metadata 是可选字段。
- 新 Backend 读取老 executor 事件时不得因为缺 timing 而失败。
- Web 和 Wework 复用 `packages/collaboration` 的展示组件。
- 不改变现有 `data-testid`，新增控件使用新的描述性 `data-testid`。

## 测试计划

### executor_manager

- 队列入队/出队时间注入 payload
- 新建容器路径记录 create/ready/dispatch 时间
- 复用容器路径不记录 create 时间
- 派发失败时保留已观察边界
- `prepare_only` 保留已观察边界

### executor / backend

- 终态事件携带 timing metadata
- callback 记录 `terminalReceivedAt`
- 重复回调不覆盖第一次边界
- 老事件缺失 timing 时正常处理
- 失败与取消任务保留 timing

### 前端

- summary 文案与格式
- waterfall 区间计算
- 缺失阶段显示
- 老任务降级展示
- Web 与 Wework 复用组件

## 实施顺序

1. 定义 timing metadata 字段和归并规则
2. executor_manager 注入 queue/provision 时间
3. executor 终态事件继承并携带 timing
4. backend callback 归并并持久化
5. 前端 summary 与 waterfall
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
