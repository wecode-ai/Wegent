---
sidebar_position: 1
---

# Wework 任务执行目标 Fork 设计

## 背景

Wework 现在创建任务时会根据当前项目和设备选择一个执行目标：

- 如果任务带有 `spec.device_id`，后端执行路由会把请求发给对应本地设备的
  local executor。
- 如果任务不带 `device_id`，后端走托管云端执行器路径。

任务创建之后，后续消息会继承当前任务的 `device_id`，因此一个任务的执行目标
基本固定。用户需要把一个本地任务切到云端，或者把云端任务切到本地电脑继续
推进。这个能力不应该修改原任务的运行轨迹，而应该基于当前历史创建一个新的
分支任务。

## 目标

1. 在 Wework 支持从当前任务创建一个 fork，并选择新的执行目标。
2. fork 前如果原任务正在运行，先提示用户停止；停止完成后再创建 fork。
3. fork 只创建新任务和历史引用，不自动发送消息，不自动开始执行。
4. 历史采用快照语义：fork 之后原任务新增的消息不会出现在新任务中。
5. 数据模型采用链式引用，不复制完整 subtask 列表。
6. 新任务后续执行时，模型和 UI 都能看到 fork 时刻之前的上下文。
7. 目标选择同时支持托管云端执行器和具体本地设备。

## 非目标

- 不迁移正在运行的进程、容器、终端 session 或未落盘状态。
- 不把原任务的全部 subtasks 复制到新任务。
- 不做原任务与 fork 任务之间的实时同步。
- 不把每条消息建成 DAG；第一版只在 task 层记录父任务和快照边界。
- fork 后不自动运行，也不自动发送“继续”类消息。
- 第一版不支持跨用户 fork。共享任务复制继续走现有 shared task 逻辑。

## 用户体验

Wework 在当前任务的工作区或会话操作区提供“切换执行目标并 Fork”入口。用户
打开入口后选择目标：

- 托管云端执行器：新任务不设置 `device_id`。
- 本地设备：新任务设置选中的 `device_id`。

如果当前任务处于 `PENDING`、`RUNNING` 或 `CANCELLING` 等运行态，Wework 不
直接创建 fork，而是展示确认弹窗：

> 当前任务仍在运行。需要先停止当前任务，再基于已完成的历史创建新 fork。

用户确认后，前端调用现有停止能力，并等待任务进入稳定终态。停止完成后再调用
fork 接口。用户取消时不停止也不 fork。

fork 成功后，Wework 打开新任务详情。新任务展示 fork 前的历史，但 composer
处于空闲状态。用户需要主动输入下一条消息才会触发新的执行。

## 执行目标语义

API 层不要把“托管云端执行器”和现有 Device CRD 中的 cloud device 混在一起。
fork 请求使用明确的 target type：

```json
{
  "target": {
    "type": "managed"
  }
}
```

```json
{
  "target": {
    "type": "device",
    "device_id": "local-device-id"
  }
}
```

语义：

- `target.type = "managed"`：新任务清空 `spec.device_id`，由后端默认执行路由
  选择托管云端执行器。
- `target.type = "device"`：新任务设置 `spec.device_id = device_id`，后端验证
  设备属于当前用户，并且适合当前任务或项目。

Wework UI 可以把这两个选项展示为“云端执行器”和“本地电脑”，但后端协议用
`managed` 避免和 cloud device 概念冲突。

## API 设计

新增显式 fork 接口：

```http
POST /api/tasks/{task_id}/fork
```

请求体：

```json
{
  "target": {
    "type": "managed"
  }
}
```

响应体：

```json
{
  "task_id": 123,
  "task": {
    "id": 123,
    "kind": "Task",
    "metadata": {},
    "spec": {},
    "status": {}
  }
}
```

后端行为：

1. 验证源任务属于当前用户。
2. 如果源任务仍在运行态，返回 `409 task_is_running`。前端负责提示用户停止后
   重试。
3. 计算 fork 快照边界 `afterMessageId`。它等于源任务当前稳定历史中的最大
   `message_id`。
4. 创建新任务，复制必要的 task 元数据、项目引用、workspace 元数据和标题，
   但不复制 subtasks。
5. 根据 target 写入或清空新任务 `spec.device_id`。
6. 写入 fork 元数据。
7. 返回新任务详情。

这个接口不要复用现有 `PUT /tasks/{task_id}`。fork 是创建新任务，不是更新原
任务，也不应该通过共享任务复制接口实现。

## 数据模型

在 `TaskSpec` 中增加可选的 fork 元数据：

```json
{
  "fork": {
    "sourceTaskId": 42,
    "afterMessageId": 17,
    "rootTaskId": 11
  }
}
```

字段含义：

- `sourceTaskId`：直接父任务 id。
- `afterMessageId`：fork 时刻从父任务继承到的最大消息 id。父任务中大于该值
  的消息不属于这个 fork。
- `rootTaskId`：整条 fork 链的根任务 id。根任务没有 fork 元数据时，root 就是
  源任务自身。这个字段用于列表、调试和后续性能优化。

这相当于 task 级别的链表：

```text
root task -> fork A -> fork B -> current task
```

每个节点只保存“直接父节点”和“截断位置”。查询历史时沿链向上解析即可，不需要
为每次 fork 完整复制 subtasks。

## 历史解析

新增一个统一的 fork 历史解析服务，例如 `TaskForkHistoryResolver`。所有需要
“当前任务完整上下文”的地方都通过它取数据，而不是直接只查当前任务的 subtasks。

解析规则：

1. 从当前任务开始读取 `spec.fork`。
2. 沿 `sourceTaskId` 向上收集祖先任务，直到没有 fork 元数据。
3. 对每个祖先任务，只继承 `message_id <= 子任务节点 afterMessageId` 的
   subtasks。
4. 当前任务读取自己的全部 subtasks。
5. 按从根到当前任务的顺序拼接，并按 `message_id` 保持对话顺序。
6. 增加循环检测和最大深度保护，避免坏数据导致无限递归。

fork 历史是快照，不是引用父任务的实时尾部。假设任务 A 在 `message_id = 17`
时 fork 出任务 B，之后任务 A 新增 `message_id = 18`，任务 B 仍然只能看到 A
的 1 到 17。

## Message ID 规则

当前 `get_next_message_id` 只看当前任务 subtasks。fork 后需要改成：

```text
next_message_id = max(current task local max message_id, inherited max message_id) + 1
```

这样新 fork 的第一条用户消息会接在继承历史之后，而不是从 1 重新开始。消息
顺序对 UI、导出、执行上下文和审计都保持直观。

如果实现上当前任务 subtasks 允许与继承历史使用相同 `message_id`，渲染和执行
上下文会产生歧义，因此第一版必须保证 fork 任务中新消息的 id 大于继承边界。

## 任务详情与 UI 渲染

任务详情接口和 task room join ack 都应该返回 fork 解析后的组合历史。前端
继续使用已有消息来源渲染，不在 Wework 里重新实现一套链式解析。

为了避免 UI 把继承消息误认为当前任务的可变消息，序列化 subtasks 时可以增加
视图字段：

```json
{
  "inherited": true,
  "originTaskId": 42,
  "originSubtaskId": 99
}
```

UI 规则：

- 继承消息正常展示在聊天历史里。
- 继承消息不显示“正在运行”状态。
- 针对当前任务状态的操作，例如停止、继续、重新执行，只作用于当前任务。
- 对 inherited 消息的文件回滚、上下文编辑等变更类操作第一版不开放，除非对应
  功能显式支持 origin task。

## 执行上下文

fork 历史解析必须被执行路径复用。否则用户能在 UI 中看到旧消息，但新执行器
收不到这些上下文。

需要覆盖的路径：

- 后端构建 executor request 的历史上下文。
- WebSocket `task:join` 和 `chat:send` 相关的消息恢复。
- 如果存在 Redis 或 session 级消息缓存，新 fork 第一次执行前要用解析后的
  历史初始化，而不是只用当前任务 subtasks。

执行目标仍由新任务的 `spec.device_id` 决定。fork 不会影响源任务后续的执行
路由。

## Workspace 处理

fork 会复制源任务的项目引用和 execution workspace 元数据，但目标切换时必须
验证新目标能访问对应 workspace。

规则：

- 独立聊天任务没有项目 workspace 约束，可以在托管云端和本地设备之间 fork。
- Git-backed 项目可以 fork 到托管云端执行器，由云端按现有 workspace 机制准备
  代码。
- 只存在本地路径的项目不能直接 fork 到托管云端执行器，因为云端无法访问用户
  本机路径。后端应返回明确错误，例如 `workspace_not_available_for_target`。
- fork 到本地设备时，后端和前端都应验证目标设备在线且与项目配置兼容。

这条规则避免创建一个看起来成功、但下一条消息必然因为 workspace 不可达而失败
的任务。

## 前端集成

Wework 侧新增一个 fork target action。入口可以放在当前任务操作菜单或执行设备
提示区域，具体位置遵循现有 Workbench 布局。

前端流程：

1. 用户选择“切换执行目标并 Fork”。
2. 前端展示目标选择弹窗，列出托管云端执行器和可用本地设备。
3. 如果当前任务正在运行，确认弹窗提示需要先停止。
4. 用户确认后调用现有停止逻辑，并等待任务状态进入稳定终态。
5. 调用 `POST /api/tasks/{task_id}/fork`。
6. 成功后刷新任务列表并打开新任务。
7. 不向 composer 注入默认 prompt，不自动调用 send。

本地化文案放在 Wework 现有 i18n 命名空间中。新增交互按钮、弹窗标题、确认
文本、错误状态都要同时添加中文和英文文案。

## 错误处理

- `409 task_is_running`：前端提示先停止当前任务。
- `404 task_not_found`：源任务不存在或不属于当前用户。
- `400 invalid_target`：target type 或 device id 不合法。
- `403 device_not_allowed`：设备不属于当前用户或无权限。
- `409 device_offline`：目标本地设备不可用。
- `409 workspace_not_available_for_target`：workspace 无法被目标执行器访问。
- `500 fork_history_resolution_failed`：链式历史数据异常。记录服务端日志，并给
  用户展示可重试错误。

停止后 fork 的前端流程必须处理停止失败。如果停止失败，不继续创建 fork。

## 测试计划

后端测试：

- 运行态任务调用 fork 返回 `409 task_is_running`。
- 终态任务 fork 到 `managed` 后，新任务没有 `device_id`。
- 终态任务 fork 到 `device` 后，新任务设置指定 `device_id`。
- fork 只写入 fork 元数据，不复制 subtasks。
- task detail 返回继承历史和当前任务历史。
- 原任务 fork 后新增消息不会出现在 fork 任务详情中。
- fork-of-fork 能解析完整历史链。
- 新 fork 的下一条消息 id 大于继承边界。
- 无权限访问源任务或设备时返回明确错误。
- workspace 不可达时拒绝创建 fork。

前端测试：

- 当前任务运行时点击 fork，会先展示停止确认。
- 用户取消确认时不停止、不 fork。
- 停止成功后调用 fork 接口。
- fork 成功后打开新任务，但不自动发送消息。
- 目标选择能正确提交 `managed` 或 `device` payload。
- 设备离线和 workspace 不可用错误展示为可理解的用户提示。

## 实施边界

第一版把“迁移执行目标”定义为“停止当前任务后，创建一个历史快照 fork，并让
用户在新任务里手动继续”。这满足本地与云端之间切换执行环境的核心需求，同时
避免复制大量历史数据、迁移运行中进程或引入消息级 DAG。

后续如果需要提升长链查询性能，可以增加 materialized view、fork history cache
或异步压缩，但这些都是优化，不改变第一版的 task-level 链式语义。
