---
sidebar_position: 20
---

# 任务 Wall Time 阶段总览实施计划

设计依据：[任务 Wall Time 阶段总览](../specs/2026-11-18-task-timing-overview.md)。

## 目标

按可独立验证的切片打通任务耗时数据链路：

1. executor_manager 记录队列和运行环境准备阶段
2. executor 终态事件继承 timing metadata
3. Backend 归并并持久化 timing
4. 前端展示总用时和阶段 waterfall

每个切片保持向后兼容；缺失字段不得导致执行失败。

## 切片 1：executor_manager 队列与准备阶段

状态：已实现。

### 行为

- `TaskQueueService.dequeue_task()` 将 pending record 中的秒级 `enqueued_at` / `dequeued_at` 转换为毫秒，写入 task payload：
  - `metadata.timing.enqueuedAt`
  - `metadata.timing.dequeuedAt`
- 通用 executor 编排层记录：
  - `instanceCreateStartedAt`
  - `instanceCreateFinishedAt`
  - `instanceReadyAt`
  - `taskDispatchedAt`
- 复用已有 executor 时不记录 create 阶段。
- `prepare_only` 任务保留已观察边界。
- 派发失败时保留已写入 payload 的 partial timing。
- 同组件派生 duration 字段，避免 UI 跨时钟域计算主要阶段：
  - `queueDurationMs`
  - `createDurationMs`
  - `waitReadyDurationMs`
  - `dispatchDurationMs`
  - `provisionDurationMs`

### 代码位置

- `executor_manager/services/task_queue_service.py`
- `executor_manager/executors/docker/executor.py`
- 如通用包装层不具备记录条件，允许第一版先落在 Docker executor，后续提取共享 helper。

### 测试

- dequeue 注入 queue timing，并将秒转换为毫秒
- 新建容器路径记录 create/ready/dispatch
- 复用容器路径不记录 create
- prepare-only 不记录 dispatch
- create 或 dispatch 失败时保留 partial timing

### 验证记录

```bash
cd executor_manager
UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/ uv run pytest \
  tests/services/test_task_queue_service.py \
  tests/executors/test_docker_executor.py -q
UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/ uv tool run black --check \
  services/task_queue_service.py executors/docker/executor.py \
  tests/services/test_task_queue_service.py tests/executors/test_docker_executor.py
UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/ uv tool run isort --check-only \
  services/task_queue_service.py executors/docker/executor.py \
  tests/services/test_task_queue_service.py tests/executors/test_docker_executor.py
```

- Pytest：47 passed
- Black：通过
- isort：通过

## 切片 2：executor 终态事件

状态：已实现。

### 行为

- Executor 启动任务时记录 `agentStartedAt`。
- 终态事件携带：
  - `agentStartedAt`
  - `agentFinishedAt`
  - 从请求 metadata 继承的 `timing`
- 请求 payload 中的 timing 不进入模型提示词或工具参数。

### 代码位置

- `executor/src/agents/` 的终态事件构造路径
- `executor/crates/execution-contracts/src/emitter/mod.rs`

### 测试

- 终态事件保留完整 timing
- 缺 timing 的老 payload 正常执行
- timing 不进入 prompt/tool payload

### 验证记录

```bash
cd executor
RUSTUP_TOOLCHAIN=1.88.0 cargo fmt --check
RUSTUP_TOOLCHAIN=1.88.0 cargo test --test runner_contract --test callback_contract
```

- cargo fmt：通过
- runner_contract：5 passed
- callback_contract：6 passed

## 切片 3：Backend callback 汇聚

### 行为

- `CallbackRequest` 增加可选 timing 字段。
- callback handler 记录 `terminalReceivedAt`。
- 按“第一次观察优先”归并 timing 到 subtask result。
- 老事件缺 timing 时正常处理。

### 代码位置

- `backend/app/api/endpoints/internal/callback.py`
- `backend/app/services/execution/emitters/status_updating.py`
- `backend/app/services/chat/storage/`

### 测试

- 成功、失败、取消均保留 timing
- 重复回调不覆盖第一次边界
- 老事件降级
- timing 归并只允许补充空字段

## 切片 4：前端总览

状态：已实现第一版。

### 行为

- Assistant 消息旁展示总用时和关键阶段 summary。
- 展开显示 stage waterfall。
- 缺失阶段显示不可用。
- 老任务继续使用现有 turn duration。

### 代码位置

- `packages/chat-core/`
- `packages/collaboration/src/conversation/`
- `wework/src/components/chat/`

### 测试

- duration 格式化
- 阶段区间计算
- 缺失数据降级
- Web 与 Wework 复用组件

### 实现说明

第一版 Web 任务消息直接从 `subtask.result.timing` 读取服务端持久化数据，并在
AI 消息头部下方展示紧凑 summary。点击后展开轻量 waterfall。缺失阶段自然隐藏。

Wework 原生 runtime 会话暂未把 subtask result 投影到共享 assistant 消息；
本阶段不伪造客户端时间，待 runtime transcript 提供 result timing 后复用同一展示组件。

UI 第一版只展示同组件派生 duration，不展示跨时钟域的终态回调阶段。

### 验证记录

```bash
pnpm --dir frontend test src/features/tasks/components/message/TaskTimingOverview.test.tsx
pnpm --dir frontend exec prettier --check \
  src/features/tasks/components/message/TaskTimingOverview.tsx \
  src/__tests__/features/tasks/components/message/TaskTimingOverview.test.tsx \
  src/features/tasks/components/message/MessageBubble.tsx \
  src/features/tasks/presentation/useMessagePresenter.ts
```

- Jest：2 passed
- Prettier：通过

## 顺序与验收

1. 切片 1 独立合入，不要求 UI 可见。
2. 切片 2 保持 executor 兼容老 executor_manager。
3. 切片 3 兼容老 executor 事件。
4. 切片 4 在前三层数据可信后实施。

每个切片完成后更新本文档状态，并补充实际测试命令与结果。
