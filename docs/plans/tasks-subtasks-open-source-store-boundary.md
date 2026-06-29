# Tasks / Subtasks 开源侧 Store 边界开发计划

## 目标

开源版本保持单表 `tasks` / `subtasks` 实现，不引入分表、Redis ID、BIGINT ID 或 group chat scatter-gather。

本计划只做一件事：把 Task/Subtask 数据访问收口到 Store 层，方便内部版本通过替换 Store 实现分表。

---

## 不做范围

- 不创建 `tasks_00` / `subtasks_00` 等分表。
- 不修改 `tasks.id` / `subtasks.id` 为 BIGINT。
- 不修改 `resource_members.resource_id` / `copied_resource_id` 字段类型。
- 不引入 Redis ID 生成器。
- 不改变现有 REST / WebSocket API 契约。
- 不实现 group chat 分片 scatter-gather。

---

## 开源真正需要改的内容

### 1. TaskResource 查询收口

把业务层直接查询 `TaskResource` 的地方收口到 `task_store` 或 `task_access_store`。

需要检查和改造：

- `backend/app/services/notification/group_chat_summary.py`
- `backend/app/services/notification/unread_notification.py`
- `backend/app/services/adapters/executor_job.py`

保留：

- `backend/app/stores/tasks/sqlalchemy_task_store.py` 内部可以继续直接查 `TaskResource`。
- `backend/app/stores/tasks/sqlalchemy_access_store.py` 内部可以继续直接查 `TaskResource`。

### 2. Subtask 查询收口

把业务层直接查询 `Subtask` 的地方收口到 `subtask_store`。

需要检查和改造：

- `backend/app/services/adapters/executor_job.py`
- `backend/app/services/executor_cleanup_cursor_service.py`
- `backend/app/services/notification/group_chat_summary.py`

保留：

- `backend/app/stores/tasks/sqlalchemy_subtask_store.py` 内部可以继续直接查 `Subtask`。

### 3. 补充带 task_id 的 SubtaskStore 方法

新增方法，给已经持有 `task_id` 的调用点使用：

- `get_by_task_and_id(db, *, task_id: int, subtask_id: int, owner_user_id: Optional[int] = None)`
- `get_basic_by_task_and_id(db, *, task_id: int, subtask_id: int, owner_user_id: Optional[int] = None)`
- `get_by_task_and_id_and_role(db, *, task_id: int, subtask_id: int, role: SubtaskRole, owner_user_id: Optional[int] = None)`
  - 校验某个 subtask 属于 task 且 role 匹配，用于 retry/guide 上下文验证
- `list_by_task_and_role(db, *, task_id: int, role: SubtaskRole, owner_user_id: Optional[int] = None) -> list[Subtask]`
  - 按 task_id + role 查列表，用于批量取角色消息

修改文件：

- `backend/app/stores/tasks/interfaces.py`
- `backend/app/stores/tasks/sqlalchemy_subtask_store.py`
- `backend/tests/stores/tasks/test_sqlalchemy_subtask_store.py`

### 4. 已有 task_id 的调用点优先改用新方法

这些位置已经有 `task_id`，应改用带 `task_id` 的 Store 方法：

- `backend/app/api/ws/chat_namespace.py`
  - `chat:guide`
  - `chat:retry`
  - `_subtask_belongs_to_task`
- `backend/app/api/endpoints/adapter/chat.py`
  - correction 查询和更新
- `backend/app/services/knowledge/knowledge_base_qa_service.py`
- `backend/app/services/turn_file_changes.py`
- `backend/app/services/chat/operations/retry.py`

只拿 `subtask_id` 的旧接口先保留：

- `GET /subtasks/{subtask_id}`
- `PUT /subtasks/{subtask_id}`
- `DELETE /subtasks/{subtask_id}`
- `POST /subtasks/{subtask_id}/edit`
- `chat:cancel`

### 5. Group chat 查询保持单表，但只放 Store 内

开源继续使用单表：

- `resource_members JOIN tasks`
- `tasks` 表直接过滤 `kind` / `is_active` / `namespace`

要求：

- SQL 只放在 `SqlAlchemyTaskStore` / `SqlAlchemyTaskAccessStore`。
- Service/API 不新增手写 `JOIN tasks`。
- 内部版本后续只替换 Store，不改业务层。

重点方法：

- `list_accessible_task_ids`
- `list_group_task_ids_for_accessible_user`
- `list_accessible_active_tasks_for_user`
- `TaskAccessStore.is_member`
- `TaskAccessStore.get_task_owner_id`

### 6. 文档说明内部扩展点

更新或新增开发说明：

- 开源使用单表 Store。
- 内部分表只替换 Store 实现。
- API/service 层禁止写分片路由逻辑。

建议写入：

- `docs/plans/tasks-subtasks-sharding-open-source-impact.md`

---

## 内部扩展点说明

> 此节替代独立文档 `tasks-subtasks-sharding-open-source-impact.md`。

**开源版本**：`tasks` / `subtasks` 单表，Store 对外边界保持稳定，允许增量新增方法；API/service 层不感知内部实现。

**内部分表版本**：
- 替换 `SqlAlchemyTaskStore` / `SqlAlchemySubtaskStore` / `SqlAlchemyTaskAccessStore` 实现。
- `task_id` 改为 63-bit BIGINT（编码时间戳 + uid + seq），内部实现位于 `backend/wecode/task_sharding/task_id.py`。
- 分表路由 `uid % N`，从 `task_id` 直接解出 uid，O(1) 无需额外查询。
- `resource_members.resource_id` 存的是 `task_id`，成员列表查询通过解 uid 精准路由，无需 scatter-gather。

**禁止在 API / service 层写分片路由逻辑**，分表细节只允许出现在 Store 实现内。

---

## 开发步骤

### Phase 1 - 补 Store 接口

- [ ] 修改 `backend/app/stores/tasks/interfaces.py`
  - 增加 `get_by_task_and_id`
  - 增加 `get_basic_by_task_and_id`
  - 增加 `get_by_task_and_id_and_role`
  - 增加 `list_by_task_and_role`
- [ ] 修改 `backend/app/stores/tasks/sqlalchemy_subtask_store.py`
  - 单表实现：`Subtask.task_id == task_id AND Subtask.id == subtask_id`
  - 保持原 `get_by_id` 兼容。
- [ ] 增加 Store 单元测试
  - 增加 `test_get_by_task_and_id_returns_matching_subtask`
  - 增加 `test_get_by_task_and_id_rejects_wrong_task`
  - 增加 `test_get_by_task_and_id_and_role_rejects_wrong_role`
  - 增加 `test_list_by_task_and_role_returns_all_matching`

### Phase 2 - 改已有 task_id 的调用点

- [ ] 改 `backend/app/api/ws/chat_namespace.py`
  - `chat:guide` 使用 `get_by_task_and_id`
  - `chat:retry` 内部 `fetch_retry_context` 优先用带 task_id 的 Store 方法校验 failed AI subtask 属于该 task（`get_by_task_and_id_and_role`）
  - `_subtask_belongs_to_task` 使用 `get_basic_by_task_and_id`
- [ ] 改 `backend/app/api/endpoints/adapter/chat.py`
  - 有 `task_id` 的 correction 查询用 `get_by_task_and_id`
  - 只有 `subtask_id` 的 correction 路由先保留旧逻辑。
- [ ] 改 `backend/app/services/turn_file_changes.py`
  - 已有 task 上下文时用带 task_id 方法。
- [ ] 改 `backend/app/services/knowledge/knowledge_base_qa_service.py`
  - 已有 task_id/message_id 的路径避免只按 subtask_id 查询。

### Phase 3 - 收口直接 ORM 查询

- [ ] 检查 `TaskResource` 直接查询：
  - `rg "db\.query\(TaskResource|select\(TaskResource" backend/app -g "*.py"`
- [ ] 检查 `Subtask` 直接查询：
  - `rg "db\.query\(Subtask|select\(Subtask" backend/app -g "*.py"`
- [ ] 除 Store 和模型文件外，逐个改为调用 Store。
- [ ] 对暂时不能迁移的调用点加注释说明原因，并补测试覆盖。

### Phase 4 - Group chat Store 边界

- [ ] 保留 `SqlAlchemyTaskStore` 内现有 group chat 单表 SQL。
- [ ] 确认 service/API 不直接 join `tasks`。
- [ ] 给 group chat list/member 查询补 Store 层测试。

### Phase 5 - 测试

- [ ] 运行 Store 测试：
  - `cd backend && uv run pytest tests/stores/tasks/test_sqlalchemy_subtask_store.py`
  - `cd backend && uv run pytest tests/stores/tasks/test_sqlalchemy_task_store.py`
- [ ] 运行相关服务测试：
  - `cd backend && uv run pytest tests/services`
  - `cd backend && uv run pytest tests/services/test_executor_cleanup*`
- [ ] 手动回归：
  - 普通任务消息列表。
  - group chat 成员任务列表。
  - group chat 消息发送（chat_namespace.py 改动影响此路径）。
  - retry。
  - cancel。
  - correction。
  - attachment context 绑定。

---

## 验收标准

- 开源版本数据库 schema 不变。
- 开源版本 API 契约不变。
- `TaskResource` / `Subtask` 查询主要通过 Store 访问；`backend/app/services/` 和 `backend/app/api/` 下不再出现 `db.query(TaskResource`、`db.query(Subtask`（Store 文件本身除外）。
- 已有 `task_id` 的 subtask 查询优先用带 `task_id` 的 Store 方法。
- group chat 单表查询仍可用。
- 内部版本后续可以替换 Store 实现分表，而不改 API/service。
