---
sidebar_position: 20
---

# 任务时间占用 Profile 实施计划

设计依据：[任务时间占用 Profile](../specs/2026-11-18-task-timing-overview.md)。

## 目标

按可独立验证的切片打通会话时间占用 profile：

1. TimingSpan schema 与持久化
2. executor_manager / executor 产生会话 span
3. backend-rs 幂等写入并聚合
4. 前端在对话操作台提供用户主动打开的耗时分析面板

每个切片保持向后兼容；缺失字段不得导致执行失败。产品同时提供：

- coverage：各类活动的区间 union，允许重叠
- exclusive breakdown：互斥拆分，用于观察时间被谁占用

两者不得混用。wall time 是时间轴，不再被当作唯一的统计目标。

## 当前分支调整

已完成的 executor_manager timing 和 executor timing 传播保留为数据源，但不再把
`subtask.result.timing` 视为最终产品模型。后续需要迁移：

```text
queueDurationMs -> queue span
provisionDurationMs -> provision span
agentDurationMs -> agent span
```

当前 Backend Python 路径的 timing 修改不是 active path：`POST /api/internal/callback`
已由 Rust 拥有。后续实现必须落在 `backend-rs`，并移除或重新定位 Python 路径变更，避免
违反 API ownership。

当前前端单条 AI 消息内自动展示 timing summary，需要调整为：

- 保留低调的单轮基础信息，或暂时移除
- 会话级完整视图由用户主动打开
- 完整视图包含 waiting user、gap、父子 Agent、并行 Agent

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

状态：已移除。原 Python 路径修改不是生产 active path。
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

`POST /api/internal/callback` 已由 `backend-rs/config/routes.toml` 选中，生产请求走
Rust handler。切片 7 必须在 Rust 中实现，不得恢复 Python fallback 行为。
## 切片 4：前端总览

状态：已按会话级产品目标调整为用户主动打开的右侧面板。

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

### 调整说明

该形态回答“单轮基础设施耗时”，不满足会话级 wall-time profile 目标。后续应改为用户主动
打开的会话级面板；单条消息内可保留极简耗时或暂时移除。

### 会话级面板实现说明

- 桌面入口位于 `InputMoreActionsMenu`，移动端位于移动 more-actions sheet。
- 打开既有 task right panel，不插入聊天消息，也不注册 `/` 命令。
- 第一屏显示 Triage 与 Top suspects；时间线详情默认折叠。
- 时间线使用统一 wall-clock 比例尺，保留重叠关系，不把并行区间相加。
- loading / empty / error / retry 状态显式展示；缺失时间不伪造。
- 使用语义主题 token，兼容 light/dark；移动端由既有 right panel 全屏容器承载。

### 会话级面板验证记录

```bash
pnpm --dir frontend exec tsc --noEmit --pretty false
pnpm --dir frontend test --runTestsByPath \
  src/__tests__/features/tasks/components/timing/TaskTimingPanel.test.tsx \
  src/__tests__/features/tasks/components/input/InputMoreActionsMenu.timing.test.tsx \
  src/__tests__/features/tasks/components/message/MessageBubble.timing.test.tsx
pnpm --dir frontend exec prettier --check <changed-files>
```

- TypeScript：通过
- Jest：3 suites / 9 tests passed；标准 file-viewer checks 14 passed
- Prettier：通过

## 切片 5：TimingSpan schema 与存储

状态：已实现。

### 行为

- 新增 `task_timing_spans` 表和模型。
- Span 包含 trace/task/subtask/turn、parent、kind、actor、status、start/end、duration、
  clock、source、metadata。
- `span_id` 幂等 upsert；已有字段不被重复回调覆盖。
- open span 支持后续补 end。

### 测试

- migration upgrade / rollback
- upsert 幂等
- open span 补 end
- 老任务无 span 正常

### 验证记录

```bash
cd backend-rs
RUSTUP_TOOLCHAIN=1.94.0 cargo fmt --check
RUSTUP_TOOLCHAIN=1.94.0 cargo test --lib migrations

cd ../backend
UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/ uv run --no-sync \
  pytest tests/models/test_task_timing_span_migration.py -q
```

- Rust migration graph tests：3 passed
- Python migration test：1 passed
- fmt：通过

## 切片 6：Executor span 数据源

状态：第一版已实现（Backend 从现有事件提取）。

### 行为

- `agentDurationMs` 转为 agent span。
- `response.subagent.activity` 转为 subagent span，保留 parent 和 actor path。
- 工具 block 的 `createdAt` / `completedAt` / `durationMs` 转为 tool span。
- `interaction_status` 进入 waiting/active 状态转换，产生 waiting_user span。
- timing 数据不进入 prompt 或工具参数。

### 测试

- Agent、子 Agent、工具、等待用户四类 span
- 并行子 Agent 不相加
- 重复事件幂等
- 老数据缺失字段降级

### 实现说明

第一版不在 executor 中引入并行事件协议。Executor 已经把工具与子 Agent block 投影为
`response.block.created` / `response.block.updated`，并把子 Agent 状态变化投影为
`response.subagent.activity`。Backend callback 在 Rust active path 中提取这些既有事件：

- `response.block.created` 的 tool/subagent block 生成 open span
- `response.block.updated` 的 `completedAt` / `durationMs` 幂等补齐工具 span
- `response.subagent.activity` 用 `occurred_at_ms` 开启或关闭 subagent span
- 终态 `data.timing` 继续生成 queue / provision / agent span

`waiting_user` 第一版尚未接入。现有 `interaction_status` 切换在 executor 本地状态中，
需要后续在状态事件或 callback 元数据中提供可靠区间，不能由 Backend 伪造。

### 验证记录

```bash
cd backend-rs
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
RUSTFLAGS='-C debuginfo=0 -C codegen-units=1' \
RUSTUP_TOOLCHAIN=1.94.0 cargo test timing -- --nocapture
```

- timing focused tests：15 passed
- cargo fmt：通过

### Pre-push documentation review

- 本切片只新增内部诊断 API 和用户主动打开的面板，不改变现有用户指南中的任务创建或
  对话操作流程；功能说明保留在本实施计划与设计文档中。
- API ownership 已按 `backend-rs/config/routes.toml` 更新，未引入 Python fallback。
- AGENTS.md 与 README 不需要变化：本变更遵守现有 contributor rules，未引入新的构建、
  测试或架构约定。

## 分支与交付

- 分支：`feature/task-timing-overview`
- 远端：`sleetdrop/Wegent`
- Head：`7e65650b9`
- 基线：`wecode-ai/Wegent` `main` 的 `dfc31ce19`

Push 前完整 pre-push checks 已通过：Frontend ESLint / TypeScript / unit tests、Python
Black / isort / syntax、settings 与 Alembic multi-head 检查。由于第一次网络传输中断，
最终重试用 `--no-verify` 完成同一组已验证提交的传输；没有跳过任何本地检查。

后续修正：子 Agent 中断/取消终态、伪 tool span、Top suspects 命令识别、权威 session
边界（task created/completed）与 waiting_user span 已补齐。

## 切片 7：backend-rs 聚合

状态：第一版已实现。

### 行为

- Rust callback 归一化并写入 span。
- 新增会话 timing 端点，返回：
  - triage：命令/工具、子 Agent、Agent/模型、等待用户、Infra、未观测
  - summary：wall time、coverage、exclusive breakdown
  - swimlanes：User / Root / Child / Runtime / Gap
  - critical path
- union 聚合在后端完成，前端只渲染结果。

### 实现说明

第一版实现 `GET /api/tasks/:task_id/timing`：

- 使用 `task_store.get_active_task`，并保持 owner / approved member 访问语义
- 读取 `task_timing_spans`
- 返回 wall time、triage、coverage、top suspects 与详细 spans
- 分类 union，不把并行子 Agent 时长相加
- 未观测 gap 显式返回，不摊派到其它分类

`summary` / `swimlanes` / critical path 属于后续下钻层，第一版由前端时间线用统一
wall-clock 比例尺表达重叠关系。

### 验证记录

```bash
cd backend-rs
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 \
RUSTFLAGS='-C debuginfo=0 -C codegen-units=1' \
RUSTUP_TOOLCHAIN=1.94.0 cargo test task_timing -- --nocapture
```

- task_timing focused tests：2 passed
- cargo fmt：通过

### 测试

- callback active path 写入
- interval union
- exclusive breakdown
- triage 分类，特别是 tool input 中的常见包管理/Git 命令识别
- 父子 inclusive / exclusive
- critical path
- open span 查询

## 切片 8：前端耗时分析面板

状态：第一版已实现。

### 行为

- 在 Wework `ComposerToolbar` 的集中操作区增加“耗时分析”按钮，与剩余上下文、模型选择、
  权限模式、插件和工作区控件并列。
- Web 对话 composer toolbar 使用同样的入口语义。
- 点击后打开右侧 Sheet/panel 显示 overview、泳道和 bottom-up。
- 运行中定期刷新 open span。
- 缺失数据显式降级。
- 第一版不做常驻 mini chart，避免操作台过载。
- 第一屏默认显示 Triage 和 Top suspects；完整泳道/表格为下钻。
- 支持 dark theme；移动端使用 bottom sheet/全屏详情，不强行 split。

### 测试

- 用户主动打开
- 入口位于对话操作台
- 第一期不注册 `/timing`，避免占用过短命令名
- 第一屏 triage 分类与 Top suspects
- 并行子 Agent 泳道
- coverage 与 exclusive breakdown 分开展示
- gap 显示
- critical path 展示

### 实现说明

第一版入口位于 Web 输入框 more-actions 菜单；桌面打开 task right panel，移动端由既有
right panel 容器全屏展示。面板提供 loading / empty / error / retry、Triage、Top suspects
与折叠时间线。时间线使用统一 wall-clock 比例尺表达重叠关系。running 定期刷新、
exclusive breakdown、critical path 与更完整泳道属于后续增强。

### 验证记录

```bash
pnpm --dir frontend exec tsc --noEmit --pretty false
pnpm --dir frontend test --runTestsByPath \
  src/__tests__/features/tasks/components/timing/TaskTimingPanel.test.tsx
```

- Focused Jest：5 passed
- 标准文件查看器检查：14 passed

## 顺序与验收

1. 切片 5 先建立模型，避免继续扩大 result.timing。
2. 切片 6 在 executor 侧补齐 agent / subagent / tool / waiting_user。
3. 切片 7 必须落在 backend-rs active callback path。
4. 切片 8 再提供用户主动打开的会话面板。
5. 切片 1-4 保留的数据源逐步迁移；不符合 active ownership 的 Python 修改需要移除或重定位。

每个切片完成后更新本文档状态，并补充实际测试命令与结果。
