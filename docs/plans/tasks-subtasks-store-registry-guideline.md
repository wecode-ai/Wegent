---
sidebar_position: 100
---

# Tasks / Subtasks Store Registry 维护规则

## 背景

开源版本使用单表 `tasks` / `subtasks` Store。

内部版本在启用分表后，会在启动阶段把 `app.stores.tasks` 模块上的全局 Store 替换为内部分表实现：

- `task_stores.task_store`
- `task_stores.subtask_store`
- `task_stores.task_access_store`

如果业务代码使用提前绑定的导入：

```python
from app.stores.tasks import subtask_store
```

模块加载顺序不合适时，变量可能仍指向开源单表 Store，内部替换后的分表 Store 不一定生效。

## 统一规则

业务层代码统一使用模块级 registry 访问 Store：

```python
import app.stores.tasks as task_stores

task_stores.subtask_store.get_by_id(...)
task_stores.task_store.get_regular_active_task(...)
task_stores.task_access_store.is_member(...)
```

不要在 API / service / websocket / task job 等业务层新增下面这种提前绑定：

```python
from app.stores.tasks import task_store, subtask_store, task_access_store
```

## 是否同步开源

这类改动可以同步开源。

原因：

- 开源环境下 `task_stores.subtask_store` 仍然是单表 Store，行为不变。
- 内部环境下 registry 可以被替换为分表 Store，业务层不用感知分表。
- 保持开源和内部共享代码一致，避免维护两套写法。

## 边界

允许同步到开源路径：

- 把提前绑定 Store 导入改为 `import app.stores.tasks as task_stores`。
- 补齐 Store interface 中业务层确实需要的方法。
- 单表 Store 默认实现和测试。

禁止同步到开源路径：

- 分表路由、slot 解析、动态 shard model。
- Redis 发号器。
- `tasks_0000` / `subtasks_0000` 等内部物理表实现。
- `WECODE_TASK_SHARDING_ENABLED` 分支逻辑散落在业务层。

## 当前例子

`backend/app/api/ws/chat_namespace.py` 中按 `subtask_id` 查询消息时，应使用：

```python
subtask = task_stores.subtask_store.get_by_id(db, subtask_id=payload.subtask_id)
```

分表模式下 `ShardedSubtaskStore.get_by_id` 可以通过 `subtask_id` 解析 slot 并路由到正确分表；如果误用提前绑定的单表 Store，则可能查不到内部新 ID 对应的消息。

## TODO

- [ ] `backend/app/stores/tasks/interfaces.py`
  - 该文件是开源同步的核心 Store 合同，必须同步。
  - 需要同步 `TaskIdAllocationError`、`TaskStore.create_pending_task_shell_with_workspace`、`TaskStore.list_by_ids`、`TaskStore.list_recent_group_chat_tasks`。
  - 需要同步 `SubtaskStore.create_user_and_assistant_subtasks`、`list_ids_by_task`、cleanup cursor / runtime cleanup 扫描方法、`list_cleanup_subtasks_for_task`、`mark_executor_deleted_by_ids`。
  - 这些接口本身不包含内部分表实现，开源只需要提供单表默认实现。
  - 不带入 Redis 发号、slot/shard 路由、动态分表模型或内部环境开关。
- [ ] `backend/app/stores/tasks/sqlalchemy_subtask_store.py`
  - 该文件是开源 `SubtaskStore` 的单表默认实现，必须随 interface 同步。
  - 需要同步 `create_user_and_assistant_subtasks`、`list_ids_by_task`、cleanup cursor / runtime cleanup 扫描方法、`list_cleanup_subtasks_for_task`、`mark_executor_deleted_by_ids`。
  - 这些实现只访问单表 `subtasks`，可直接同步开源。
  - 同步时需要覆盖成对创建、附件归属校验、executor cleanup、cleanup cursor 和群聊摘要消息查询相关测试。
  - 不带入内部分表 Store、slot/shard 路由、Redis 发号或内部开关逻辑。
- [ ] `backend/app/stores/tasks/sqlalchemy_task_store.py`
  - 该文件是开源 `TaskStore` 的单表默认实现，必须随 interface 同步。
  - 需要同步 `create_pending_task_shell_with_workspace`，用于 Task 和 Workspace 成对创建的 Store 边界。
  - 需要同步 `list_recent_group_chat_tasks` 和 `_is_group_chat_task`，用于群聊摘要查询。
  - `list_by_ids` 已作为多个通知、cleanup、访问边界的公共查询能力，需要确认开源默认实现完整。
  - 这些实现只访问单表 `tasks`，可直接同步开源。
  - 不带入内部分表 Store、slot/shard 路由、Redis 发号或内部开关逻辑。
- [ ] `backend/alembic/versions/20260612_d5e6f7a8b9c0_add_task_subtask_bigint_shards.py`
  - 该迁移不能原样同步开源，因为当前文件同时包含 BIGINT 字段迁移和内部 shard 表创建。
  - 开源只需要同步 BIGINT 字段迁移：`tasks`、`subtasks`、`resource_members`、`share_links`、`background_executions`、`wiki_generations`、`subtask_contexts`、`queue_messages`。
  - 内部 shard 表创建、`settings.WECODE_TASK_SHARD_COUNT`、`tasks_0000` / `subtasks_0000` 等逻辑应保留内部。
  - 同步开源时建议拆成纯 BIGINT 迁移，避免开源执行后创建内部分表。
- [ ] `backend/app/api/ws/chat_namespace.py`
  - 当前内部适配已改为通过 `task_stores` registry 访问 Store。
  - 该改动属于开源/内部共享代码边界清理，可同步开源。
  - 同步时确认只改 Store 访问方式，不带入分表路由、Redis 发号或内部开关逻辑。
- [ ] `backend/app/models/resource_member.py`
  - `resource_members.resource_id` 和 `resource_members.copied_resource_id` 会保存 Task ID。
  - 开源如果把 `tasks.id` 升级为 BIGINT，这两个字段也必须同步升级为 BIGINT。
  - 同步时只带模型字段类型和 Alembic BIGINT 迁移，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `backend/app/models/share_link.py`
  - `share_links.resource_id` 会保存 Task 分享链接对应的 Task ID。
  - 开源如果把 `tasks.id` 升级为 BIGINT，该字段也必须同步升级为 BIGINT。
  - 同步时只带模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `backend/app/models/subscription.py`
  - `background_executions.task_id` 会保存后台执行创建的 Task ID。
  - 开源如果把 `tasks.id` 升级为 BIGINT，该字段也必须同步升级为 BIGINT。
  - 同步时只带模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `backend/app/models/task.py`
  - `tasks.id` 是 Task / Workspace 主键，开源需要升级为 BIGINT。
  - 同步时保持 `autoincrement=True`，确保开源单表模式仍可自增创建 Task / Workspace。
  - 同步时只带模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `backend/app/models/wiki.py`
  - `wiki_generations.task_id` 会保存 Wiki 生成流程对应的 Task ID。
  - 开源如果把 `tasks.id` 升级为 BIGINT，该字段也必须同步升级为 BIGINT。
  - 同步时只带模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `shared/models/db/types.py`
  - 该文件提供 `big_integer_id_type()`，是共享模型升级 BIGINT ID 的公共类型适配。
  - 需要同步开源，用于 MySQL 使用 BIGINT，同时保持 SQLite 测试环境的 INTEGER autoincrement 兼容。
  - 同步时只带公共类型工具和对应模型引用，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `shared/models/db/subtask.py`
  - `subtasks.id` 是 Subtask 主键，开源需要升级为 BIGINT。
  - `subtasks.task_id` 会保存 Task ID，必须跟随 `tasks.id` 升级为 BIGINT。
  - `subtasks.parent_id` 和 `subtasks.reply_to_subtask_id` 会保存 Subtask 关联 ID，也必须升级为 BIGINT。
  - 同步时只带共享模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `shared/models/db/subtask_context.py`
  - `subtask_contexts.subtask_id` 会保存 Subtask ID。
  - 开源如果把 `subtasks.id` 升级为 BIGINT，该字段也必须同步升级为 BIGINT。
  - 同步时只带共享模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `shared/models/db/work_queue.py`
  - `queue_messages.source_task_id` 会保存来源 Task ID。
  - `queue_messages.process_task_id` 会保存处理流程创建的 Task ID。
  - 开源如果把 `tasks.id` 升级为 BIGINT，这两个字段也必须同步升级为 BIGINT。
  - `source_subtask_ids` 当前是 JSON 列表，不需要字段类型迁移，但测试要覆盖大 Subtask ID 序列化。
  - 同步时只带共享模型字段类型、Alembic BIGINT 迁移和类型测试，不带入内部分表表结构或 shard 路由逻辑。
- [ ] `backend/app/services/executor_cleanup_cursor_service.py`
  - 当前内部适配已把 cleanup cursor 的直接 `Subtask` 查询改为通过 `task_stores.subtask_store` 获取扫描起点。
  - 该改动属于 Store 边界清理，可同步开源；开源默认 Store 行为不变。
  - 同步时确认只带 Store interface / 单表 Store 默认实现 / 测试，不带入分表扫描、shard 路由或内部开关逻辑。
- [ ] `backend/app/services/task_member_service.py`
  - 当前内部适配已把 `is_member` / `is_group_chat` 中的直接 `TaskResource` / `ResourceMember` 查询收口到 `task_access_store`。
  - 该改动属于 Store 边界清理，可同步开源；开源默认 AccessStore 行为不变。
  - 同步时需要一起带 `TaskAccessStore` interface 和 `SqlAlchemyTaskAccessStore` 默认实现中的对应方法。
  - 后续可继续把本文件的提前绑定 `from app.stores.tasks import task_access_store` 统一为 `import app.stores.tasks as task_stores`。
- [ ] `backend/app/services/adapters/executor_job.py`
  - 当前内部适配已把 executor cleanup / stale cleanup 中的直接 `Subtask` / `TaskResource` 查询收口到 `task_stores.subtask_store` / `task_stores.task_store`。
  - 该改动属于 Store 边界清理，可同步开源；开源默认 Store 行为不变。
  - 同步时需要一起带 Store interface、单表 Store 默认实现、cleanup cursor 和 executor cleanup 相关测试。
  - 不带入分表扫描、shard 路由、Redis 发号或内部开关逻辑。
- [ ] `backend/app/services/adapters/collaboration_strategy.py`
  - 当前变更在 pipeline auto-advance 前校验完成 subtask 所属 stage 是否仍等于 `task.spec.currentStage`。
  - 该改动属于通用 pipeline 正确性修复，可同步开源；它避免过期完成回调重复推进后续 stage。
  - 同步时只带 currentStage 防重推进逻辑和测试，不带入分表、Redis 发号或内部开关逻辑。
- [ ] `backend/app/services/adapters/pipeline_stage.py`
  - 当前变更在 pipeline confirmation 判断前校验 subtask stage 是否仍等于 `task.spec.currentStage`。
  - 该改动属于通用 pipeline 正确性修复，可同步开源；它避免过期 subtask 触发错误确认状态。
  - 同步时只带 currentStage 防过期判断和测试，不带入分表、Redis 发号或内部开关逻辑。
- [ ] `backend/app/services/adapters/task_kinds/helpers.py`
  - 当前内部适配已把 `create_subtasks` 中用户消息和 AI 回复消息的创建收口到 `subtask_store.create_user_and_assistant_subtasks`。
  - 该改动属于共享 Store 边界，可同步开源；开源默认 Store 可继续按单表自增逐条创建，行为不变。
  - `_batch_query_workspaces` / `_add_group_chat_info` 中的 Store 访问也应同步为 `task_stores.task_store` / `task_stores.task_access_store`。
  - 同步时需要一起带 Store interface、单表 Store 默认实现和 subtask 成对创建测试。
  - 不带入内部分表路由、Redis 批量发号或内部开关逻辑。
- [ ] `backend/app/services/adapters/task_kinds/operations.py`
  - 当前内部适配已把 Task CRUD / archive / delete / cancel / pipeline 查询中的 Store 访问统一为 `task_stores.task_store`、`task_stores.subtask_store`、`task_stores.task_access_store`。
  - 新建任务路径已拆出 `create_pending_task_shell_with_workspace`，把 Task 和 Workspace 成对创建收口到 Store 边界；该接口需要同步开源，开源默认实现可继续使用单表自增。
  - `create_task_id` / `validate_task_id` 需要同步 Store interface 和默认实现；开源仍可通过 placeholder task 校验 ID。
  - `delete_task` 中通过 `subtask_store.list_by_task_unfiltered`、`mark_task_subtasks_deleted` 和 `task_store.soft_delete_task` 访问 Store 的改动可同步；新增运行时清理日志属于辅助排查，可同步但不是分表必需。
  - 同步时不带入 Redis 发号、slot/shard 路由、动态分表模型或内部环境开关。
- [ ] `backend/app/services/chat/preprocessing/contexts.py`
  - 当前内部适配已把附件跨 subtask 校验中的直接 `Subtask` 子查询改为通过 `subtask_store.list_ids_by_task` 获取同任务下的 subtask id。
  - 该改动属于 Store 边界清理，可同步开源；开源默认 Store 仍查单表，行为不变。
  - 同步时应改成 `import app.stores.tasks as task_stores` 后使用 `task_stores.subtask_store.list_ids_by_task`，不要保留提前绑定的 `from app.stores.tasks import subtask_store`。
  - 需要一起带 `SubtaskStore.list_ids_by_task` interface、单表 Store 默认实现和附件归属校验测试。
  - 不带入内部分表路由、slot 解析、Redis 发号或内部开关逻辑。
- [ ] `backend/app/services/chat/storage/db.py`
  - 当前变更让 task 状态更新携带 `changed_subtask_id`，pipeline auto-advance 基于刚完成的 subtask，而不是简单使用最后一条 assistant subtask。
  - `_auto_advance_pipeline` 已增加相同 parent message 下的下一 stage subtask 幂等检查，避免重复完成回调创建重复 stage。
  - 该改动属于通用 pipeline 正确性修复，可同步开源。
  - 同步时建议顺手把本文件提前绑定的 `from app.stores.tasks import subtask_store, task_store` 统一为 `import app.stores.tasks as task_stores`。
  - 不带入分表、Redis 发号、slot/shard 路由或内部开关逻辑。
- [ ] `backend/app/services/chat/storage/task_manager.py`
  - 当前内部适配已把 Chat Shell 创建任务路径改为 `task_store.create_pending_task_shell_with_workspace`，把 Task 和 Workspace 成对创建收口到 Store 边界。
  - 该改动需要同步开源；开源默认实现可继续单表自增创建 Task，再创建 Workspace。
  - 本文件中的 `get_task_with_access_check`、subtask 创建、消息 id 查询、任务时间更新已统一通过 `task_stores.task_store` / `task_stores.subtask_store` / `task_stores.task_access_store`，属于共享 Store 边界。
  - 同步时需要一起带 Store interface、单表 Store 默认实现和 Chat Shell 新建任务 / 续聊 subtask 创建测试。
  - 不带入 Redis 发号、slot/shard 路由、动态分表模型或内部环境开关。
- [ ] `backend/app/services/chat/trigger/lifecycle.py`
  - 当前内部适配已把执行生命周期中的 Task JSON 更新、subtask 查询、subtask 结果读取统一通过 `task_stores.task_store` / `task_stores.subtask_store`。
  - AI 触发路径已把用户消息和 AI 回复消息改为 `subtask_store.create_user_and_assistant_subtasks` 成对创建；该 Store 边界需要同步开源。
  - 开源默认实现可继续在单表内顺序创建 user subtask 和 assistant subtask，行为不变。
  - 同步时需要一起带 Store interface、单表 Store 默认实现和 chat trigger 新建/续聊测试。
  - 不带入 Redis 发号、slot/shard 路由、动态分表模型或内部环境开关。
- [ ] `backend/app/services/notification/group_chat_summary.py`
  - 当前内部适配已把群聊摘要里的最近群聊 Task 查询、指定 Task 查询和最近消息查询收口到 `task_stores.task_store` / `task_stores.subtask_store`。
  - 该改动属于 Store 边界清理，可同步开源；开源默认 Store 仍查单表，行为不变。
  - `list_recent_group_chat_tasks`、`list_new_messages_since` 需要同步 Store interface、单表 Store 默认实现和群聊摘要查询测试。
  - `_is_group_chat_task` 同时兼容 `TaskResource.is_group_chat` 字段和 CRD JSON，可同步开源。
  - 不带入内部分表路由、slot 解析、Redis 发号或内部开关逻辑。
- [ ] `backend/app/services/notification/unread_notification.py`
  - 当前内部适配已把未读通知中的任务标题批量查询从直接 `TaskResource` 查询改为 `task_stores.task_store.list_by_ids`。
  - 该改动属于 Store 边界清理，可同步开源；开源默认 Store 仍查单表，行为不变。
  - 同步时需要确认 `TaskStore.list_by_ids` interface 和单表默认实现已随其他改动一起带上。
  - 不带入内部分表路由、slot 解析、Redis 发号或内部开关逻辑。
- [ ] `backend/app/services/share/task_share_service.py`
  - 当前内部适配已把任务分享资源访问校验从 `task_member_service.is_member` 改为 `task_access_store.is_member`。
  - 该改动属于共享访问边界，可同步开源；开源默认 AccessStore 行为不变。
  - 同步时应改成 `import app.stores.tasks as task_stores` 后使用 `task_stores.task_store` / `task_stores.task_access_store`，不要保留提前绑定的 `from app.stores.tasks import task_store, task_access_store`。
  - 需要一起带 `TaskAccessStore.is_member` interface 和单表默认实现。
  - 不带入内部分表路由、slot 解析、Redis 发号或内部开关逻辑。
- [ ] `backend/tests/api/ws/test_chat_namespace_retry.py`
  - 该测试需要随 `chat_namespace.py` 的 Store registry 改动同步开源。
  - 同步时 patch 目标应改为 `app.stores.tasks.task_store` / `app.stores.tasks.subtask_store` / `app.stores.tasks.task_access_store`。
- [ ] `backend/tests/services/adapters/test_collaboration_strategy.py`
  - pipeline auto-advance stale stage 防护测试需要随 `collaboration_strategy.py` 同步开源。
  - 同步时只覆盖 currentStage 防重推进行为，不带入内部分表测试。
- [ ] `backend/tests/models/test_task_sharding_schema.py`
  - 该测试不能原样同步开源，因为当前文件同时覆盖 BIGINT 字段和内部分表迁移。
  - 开源只需要保留 BIGINT 字段类型、Task/Subtask autoincrement、纯 BIGINT 迁移字段清单测试。
  - shard 表数量、`WECODE_TASK_SHARD_COUNT`、内部分表迁移断言应保留内部。
  - 当前测试仍引用已删除的 `20260615_e6f7a8b9c0d1_restore_bigint_autoincrement.py`，后续需要清理。
- [ ] `backend/tests/services/adapters/test_task_id_allocation.py`
  - `TaskIdAllocationError` 到 HTTP 503 的测试需要随 Store interface 同步开源。
  - 开源默认实现仍可单表 placeholder 发号；该测试保证发号不可用时错误语义稳定。
- [ ] `backend/tests/services/test_executor_cleanup_progress.py`
  - cleanup cursor 通过 `task_stores.subtask_store` 获取扫描起点的测试需要同步开源。
  - 同步时只验证 Store 边界，不带入分表扫描实现。
- [ ] `backend/tests/services/test_preserve_executor.py`
  - `_mark_executor_deleted` 通过 `subtask_store.mark_executor_deleted_by_ids` 更新的测试需要同步开源。
  - 同步时只验证 Store 边界和单表默认实现，不带入分表逻辑。
- [ ] `backend/tests/services/chat/storage/test_task_manager.py`
  - pipeline auto-advance 使用 `changed_subtask_id` 和重复 stage 幂等检查的测试需要同步开源。
  - 同步时只覆盖通用 pipeline 正确性，不带入内部分表测试。
- [ ] `backend/tests/stores/tasks/test_sqlalchemy_subtask_store.py`
  - `SqlAlchemySubtaskStore` 新增 cleanup cursor / cleanup 查询 / 成对创建等单表默认实现测试需要同步开源。
  - 同步时只覆盖单表 Store 行为，不带入内部分表 Store 测试。
