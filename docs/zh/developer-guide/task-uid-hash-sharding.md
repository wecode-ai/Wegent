---
sidebar_position: 29
---

# 任务 UID Hash 分表方案

## 目标

解决 `tasks` / `subtasks` 单表增长和多机时间发号不可靠的问题，同时保持任务列表、任务详情、消息列表、单条 subtask 查询路径清晰。

核心目标：

- `task_id` 全局唯一。
- `subtask_id` 全局唯一。
- 不依赖应用服务器本地时间保证多机唯一。
- 用户自己的任务列表不需要跨表扫描。
- 历史 `tasks` / `subtasks` 数据保留，支持 legacy fallback。

## 总体方案

使用统一发号器生成带 UID 路由信息的 `task_id` 和 `subtask_id`，真实任务数据按 owner UID hash 分表。调用方只依赖发号函数接口，后期如需替换发号服务，不改 task/subtask store 的调用方式。

```text
tasks_0000 ... tasks_1023
subtasks_0000 ... subtasks_1023

tasks      # legacy，只读旧数据
subtasks   # legacy，只读旧数据
```

分片规则：

```text
task 表名 = tasks_{owner_user_id % shard_count}
subtask 表名 = subtasks_{owner_user_id % shard_count}
```

subtask 跟随 task owner 落表，不按发送者 UID 分表。

## 表结构

### 发号器接口和 ID 格式

统一发号器以函数形式提供，不让业务代码直接依赖具体发号服务。

```text
allocate_task_id(user_id) -> int
allocate_subtask_id(user_id) -> int
```

当前实现：

```text
task_id = UserScopedIdFactory.next_id(owner_user_id)
subtask_id = UserScopedIdFactory.next_id(owner_user_id)

53-bit ID = 16-bit uid + 4-bit reserved + 33-bit seq
```

约束：

- 全局递增 seq 负责唯一性，ID 高位 uid 负责路由。
- `task_id` 和 `subtask_id` 共用同一个 UUID 序列，避免两个 ID 空间冲突。
- 业务代码只调用 `allocate_task_id()` 和 `allocate_subtask_id()`。
- 后期替换发号实现时，不改 task/subtask store 的调用方式。
- 新建数据不维护 `task_uid_index` / `subtask_uid_index` 路由表。

### tasks_xxxx

结构与当前 `tasks` 基本一致。新任务写入 `tasks_{owner_user_id % shard_count}`。

### subtasks_xxxx

结构与当前 `subtasks` 基本一致。新消息写入 task owner 对应的 `subtasks_xxxx`。

## 写入流程

### 创建任务

```text
1. 调用 `allocate_task_id(owner_user_id)` 获取全局唯一 task_id
2. 根据 owner_user_id 计算 tasks_xxxx 表名
3. 写 tasks_xxxx
```

### 创建 subtask

```text
1. 从 task_id 解析 owner uid
2. 调用 `allocate_subtask_id(owner_user_id)` 获取全局唯一 subtask_id
3. 根据 owner_user_id 计算 subtasks_xxxx 表名并写入
```

## 查询流程

### 任务详情

```text
task_id
-> 从 ID 解析 owner uid
-> tasks_{owner_user_id % shard_count}
```

如果 route 查不到，fallback 到 legacy `tasks`。

### 用户任务列表

```text
user_id
-> tasks_{user_id % shard_count}
-> where user_id = ?
-> order by updated_at desc
```

owner 自己的任务列表不需要额外 `task_index`。

### 消息列表

```text
task_id
-> 从 ID 解析 owner uid
-> subtasks_{owner_user_id % shard_count}
-> where task_id = ?
```

如果 route 查不到，fallback 到 legacy `subtasks`。

### subtask 单查

```text
subtask_id
-> 从 ID 解析 owner uid
-> subtasks_{owner_user_id % shard_count}
```

如果 route 查不到，fallback 到 legacy `subtasks`。

## 群聊和共享任务

按 task_id 打开群聊不受影响：

```text
task_id -> 从 ID 解析 owner uid -> tasks_xxxx / subtasks_xxxx
```

权限仍通过现有共享关系表判断，例如 `resource_members`。

用户查看自己参与的群聊列表时，前期使用现有关系表作为入口：

```text
resource_members where entity_id = current_user_id and resource_type = 'Task'
-> task_id list
-> 批量解析 owner uid
-> tasks_xxxx 批量取详情
```

如果后期参与群聊列表数据量大，且需要按最近活跃精准分页，再新增面向成员 UID 的索引表。

## Legacy 兼容

现有 `tasks` / `subtasks` 保留为 legacy 表。

```text
新数据：写 tasks_xxxx / subtasks_xxxx
旧数据：继续查 tasks / subtasks
```

路由查询规则：

```text
ID 可解析 owner uid -> 分表
ID 不符合新格式 -> legacy 表
```

首发不要求搬迁历史数据。

## 优点

- 任务和消息 ID 全局唯一。
- 多机唯一性由 UUID factory 保证，不依赖各应用服务器本地时间一致。
- 发号器通过函数封装，后期可替换实现。
- 用户任务列表直接按 UID hash 定位分表。
- 点查 task/subtask 可直接从 ID 解析路由。
- 不需要维护 `task_index` / `subtask_index` 两张列表索引表。
- 不需要维护 `task_uid_index` / `subtask_uid_index` 两张 ID 路由表。
- 历史数据可平滑保留。

## 风险和约束

- 超大单用户会集中到一个 shard。
- 按月归档和冷热隔离不如月表直接。
- 只有 task_id/subtask_id 的查询依赖 ID 中的 uid 路由信息。
- 参与群聊列表前期依赖 `resource_members + 批量解析 ID`，量大后可能需要成员索引。

## 推荐落地顺序

1. 新增 hash 分表迁移。
2. 接入 UserScoped ID 版 `allocate_task_id(user_id)` / `allocate_subtask_id(user_id)` 和 shard router。
3. 改造 `task_store`，新任务写 hash 分表，读路径支持 route + legacy fallback。
4. 改造 `subtask_store`，新消息写 hash 分表，读路径支持 route + legacy fallback。
5. 覆盖任务创建、任务详情、任务列表、消息列表、subtask 单查测试。
6. 灰度开启新写入，确认 legacy 查询路径稳定。
