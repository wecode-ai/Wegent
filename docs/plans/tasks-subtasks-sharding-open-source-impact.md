# Tasks / Subtasks 分表内部侧改造影响

> **注意：** 本文档描述的是**内部分表版本**的改造要求，不是开源侧必须完成的内容。
> 开源侧的边界定义和开发计划见 [tasks-subtasks-open-source-store-boundary.md](tasks-subtasks-open-source-store-boundary.md)。

## 结论

以下改造点属于内部分表版本的实现细节，影响内部数据模型、Store 实现和共享权限表结构。开源版本保持单表不变，内部版本通过替换 Store 实现来承载这些变化。

---

## 1. `subtasks.id` 不能继续分表自增

### 问题

`subtasks` 分表后，如果每张 `subtasks_XX` 继续使用本表自增 ID，会出现两个问题：

- 不同 shard 可能生成相同 `subtask_id`。
- 现有很多接口只拿 `subtask_id` 查询，没有 `task_id`，无法判断应该查哪张 shard 表。

典型入口：

- `backend/app/stores/tasks/sqlalchemy_subtask_store.py`
  - `get_by_id`
  - `get_basic_by_id`
  - `get_by_id_and_role`
  - `get_accessible_by_id`
- `backend/app/api/ws/chat_namespace.py`
- `backend/app/api/endpoints/adapter/chat.py`
- `backend/app/api/endpoints/adapter/attachments.py`
- `backend/app/api/endpoints/internal/chat_storage.py`
- `backend/app/services/execution/dispatcher.py`
- `backend/app/services/chat/storage/db.py`
- `backend/app/services/context/context_service.py`

### 内部侧必须修改

规则：

- `generate_subtask_id(owner_uid)` 生成全局 ID。
- `uid_from_subtask_id(subtask_id)` 用于按 `subtask_id` 直接路由 shard。
- 创建 subtask 时 owner uid 从 `task_id` 反解，不能用消息发送者 `user_id`。
- `SubtaskContext.subtask_id`、`Subtask.parent_id`、`Subtask.reply_to_subtask_id` 同步改 `BigInteger`。

不推荐方案：强制所有接口都带 `task_id`。这会改大量 API/WebSocket/回调契约，兼容成本更高。

---

## 2. `resource_members.resource_id/copied_resource_id` 必须记录

### 问题

`resource_members` 是多资源共享表，其中 Task 使用：

- `resource_id` 记录原 Task ID。
- `copied_resource_id` 记录复制后的 Task ID。

Task ID 改为 BIGINT 后，如果这两个字段仍是 `Integer`，会溢出或查询不匹配。

相关模型：

- `backend/app/models/resource_member.py`
- `backend/app/models/share_link.py`

相关业务：

- `backend/app/services/task_member_service.py`
- `backend/app/services/shared_task.py`
- `backend/app/services/share/task_share_service.py`
- `backend/app/services/share/base_service.py`
- `backend/app/stores/tasks/sqlalchemy_access_store.py`
- `backend/app/stores/tasks/sqlalchemy_task_store.py`
- `backend/app/services/adapters/task_kinds/helpers.py`

### 内部侧必须修改

- `ResourceMember.resource_id` 改 `BigInteger`。
- `ResourceMember.copied_resource_id` 改 `BigInteger`。
- `ShareLink.resource_id` 改 `BigInteger`。
- 所有 Task 共享/成员查询不能再直接 join 单表 `tasks`。
- 成员列表逻辑需要先查 `resource_members` 得到 task IDs，再按 task ID 分 shard 查询 Task。

---

## 3. Group chat：开源保留单表，内部定制分片查询

### 问题

普通用户查询自己创建的 Task，可以通过 `user_id % 16` 路由到单 shard。

但 group chat 成员查询不同：

- 当前用户可能不是 task owner。
- `resource_members` 只记录 `resource_id`，不记录 owner uid。
- 需要根据 member task IDs 再查 Task 状态、创建时间、是否删除、是否 group chat 等字段。

因此不能简单把 `_MEMBER_TASK_IDS_SQL` 的 `tasks` 替换为某一张 `tasks_XX`。

### 开源侧建议

开源版本不需要实现分表，也不需要实现 scatter-gather。开源侧更适合保持当前单表查询，重点是把查询入口收口到 Store，给内部版本保留可替换点。

开源侧保留：

- `resource_members JOIN tasks` 的单表实现。
- `SqlAlchemyTaskStore` / `SqlAlchemyTaskAccessStore` 作为统一访问入口。
- Service/API 层不拼 SQL、不直接依赖 `tasks` 表名。

开源侧需要避免：

- 在业务层新增直接 `JOIN tasks` 的 SQL。
- 把 group chat member 查询散落在多个 service 里。
- 把分片路由逻辑写进 API/service 层。

### 内部定制实现

内部版本在 Store 层替换 group chat member 查询实现：

1. 从 `resource_members` 查当前用户可访问的 Task IDs。
2. 按 `uid_from_task_id(task_id) % 16` 将 task IDs 分组。
3. 分别查询 `tasks_XX`。
4. 过滤 `kind='Task'`、`is_active`、`namespace != 'system'` 等条件。
5. 在内存合并、排序、分页。
6. 旧 ID 走原 `tasks` 表 fallback。

内部需要覆盖的方法：

- `list_accessible_task_ids`
- `list_group_task_ids_for_accessible_user`
- `list_accessible_active_tasks_for_user`
- group chat lite/list/detail 相关查询

---

## 必须同步进内部开发计划

内部主计划中需要明确写入：

- `subtasks.id` 全局 ID 是必要项，不是可选项。
- `resource_members.resource_id/copied_resource_id` 和 `share_links.resource_id` 必须改 `BigInteger`。
- group chat member 查询在开源侧保留单表 Store 实现；内部版本通过 Store 定制分 shard 查询并合并。

这些属于开源代码结构和数据库 schema 改造，不应只放在内部部署说明里。
