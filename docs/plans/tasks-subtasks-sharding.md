# Tasks / Subtasks 分表开发计划

## 目标

对 `tasks` / `subtasks` 做按用户 hash 分表，解决单表增长问题，同时保持现有 Task / Workspace 共用 `TaskResource` 表模型不变。

> ID 发号方案已调整：旧的 `timestamp 21 | uid 23 | seq 19` 63-bit 方案存在 JS 精度和 timestamp 生命周期问题，后续实现以 `docs/plans/tasks-subtasks-js-safe-slot-id-plan.md` 为准。

开源侧必须同步改造的关键影响点见 `docs/plans/tasks-subtasks-sharding-open-source-impact.md`。

核心原则：

- `tasks` 和 `workspaces` 继续在同一类表中存储，和当前 `tasks` 表一致，通过 `kind` 区分。
- 新 Task / Workspace ID 使用可反解 `uid` 的 63-bit BIGINT。
- `subtasks` 按所属 `task_id` 的 owner uid 路由。
- 旧自增 INT ID 继续可读，新写入只写分表。
- 查询、创建、更新优先收口到 `backend/app/stores/tasks/`，避免业务层感知分片细节。
- 内部分表、Redis 发号器、动态 shard model、内部 Store 实现统一放在 `backend/wecode/`，开源路径只保留边界和接口。
- 内部适配过程中如果发现开源 Store 边界不完整、不合适或已有改造遗漏，可以同步调整开源路径；但必须保持改动可拆分，不能把内部专属逻辑写进开源路径。

---

## 执行协作方式

本计划后续按子 agent 分项开发，主 agent 负责验收。

规则：

- 子 agent 每次只领取一个未完成 checkbox 项，按 TDD 开发并运行该项对应测试。
- 子 agent 完成后必须回报：改动文件、测试命令、测试结果、遗留风险。
- 主 agent 验收内容：是否符合本计划、内部逻辑是否留在 `backend/wecode/`、开源边界调整是否可独立拆出、测试是否覆盖关键行为、是否存在直接 ORM 绕过 Store。
- checkbox 只在主 agent 验收通过后标记完成。
- 若子 agent 发现计划不准确，先回报阻塞点，不直接扩大范围。

### 开源边界迭代规则

开源版本已经做过一轮 Store 边界改造，但不要求一次完美。内部版本适配时，最容易暴露边界遗漏，因此允许边做内部实现边修正开源相关代码。

允许同步调整的内容：

- 给 `backend/app/stores/tasks/interfaces.py` 增加内部实现确实需要的抽象方法。
- 把 API/service 层遗漏的 `TaskResource` / `Subtask` 直接查询继续收口到 Store。
- 调整 Store 方法签名，使调用点能传入 `task_id`、`owner_user_id` 等路由所需信息。
- 补充开源单表 Store 测试，保证默认实现行为不变。

禁止放进开源路径的内容：

- Redis 发号器。
- `tasks_XX` / `subtasks_XX` 分表 model 或动态 mapped class。
- `uid_from_task_id(...) % 16` 这类内部路由逻辑。
- 内部环境配置、灰度开关、patch 注册逻辑。

拆分要求：

- 开源边界修正和内部实现尽量分不同 commit。
- 如果同一个任务必须同时改开源边界和内部实现，子 agent 回报时必须单独列出“开源可拆部分”和“内部专属部分”。
- 主 agent 验收时确认开源可拆部分在没有 `backend/wecode/task_sharding` 的情况下仍可运行。

### 本地开发模式

本地开发必须通过环境变量显式选择运行模式，避免内部 patch 导入后意外切换到分表 Store。

| 模式 | `WECODE_INTERNAL_EXTENSIONS_ENABLED` | `WECODE_TASK_SHARDING_ENABLED` | 数据表 |
| --- | --- | --- | --- |
| 开源模式 | `false` | `false` | `tasks` / `subtasks` |
| 内部单表模式 | `true` | `false` | `tasks` / `subtasks` |
| 内部分表模式 | `true` | `true` | 新数据写 `tasks_XX` / `subtasks_XX`，旧 ID 仍读单表 |

规则：

- 默认值保持开源安全模式：两个开关均为 `false`。
- 分片数由 `WECODE_TASK_SHARD_COUNT` 控制，默认 `16`；本地新库可设为 `2`，只创建 `tasks_00/01` 和 `subtasks_00/01`。
- 内部普通业务开发优先使用内部单表模式，只有分表专项开发和验收才启用 `WECODE_TASK_SHARDING_ENABLED=true`。
- 三种模式不要共用同一个本地数据库；建议分别使用 `wegent_open`、`wegent_internal_single`、`wegent_internal_shard`。
- 开源单表仍需要把 task/subtask 相关 ID 字段升级为 `BIGINT`，否则无法兼容内部 BIGINT ID 被引用、分享、转发或回流的场景。

---

## 当前使用面

### 核心 Store

主要改造入口：

- `backend/app/stores/tasks/interfaces.py`
- `backend/app/stores/tasks/sqlalchemy_task_store.py`
- `backend/app/stores/tasks/sqlalchemy_subtask_store.py`
- `backend/app/stores/tasks/sqlalchemy_access_store.py`
- `backend/app/stores/tasks/__init__.py`

### TaskResource 直接查询

这些地方直接使用 `TaskResource`，需要迁到 Store 或使用分片 helper：

- `backend/app/services/notification/group_chat_summary.py`
- `backend/app/services/notification/unread_notification.py`
- `backend/app/services/adapters/executor_job.py`
- `backend/app/stores/tasks/sqlalchemy_task_store.py`
- `backend/app/stores/tasks/sqlalchemy_access_store.py`
- `backend/app/stores/tasks/sqlalchemy_subtask_store.py`

### Subtask / SubtaskContext 直接查询

这些地方会受 `subtasks` 分表或 `subtask_id` BIGINT 影响：

- `backend/app/stores/tasks/sqlalchemy_subtask_store.py`
- `backend/app/services/adapters/executor_job.py`
- `backend/app/services/executor_cleanup_cursor_service.py`
- `backend/app/services/context/context_service.py`
- `backend/app/services/chat/preprocessing/contexts.py`
- `backend/app/api/endpoints/internal/chat_storage.py`
- `backend/app/api/endpoints/internal/attachments.py`
- `backend/app/services/shared_task.py`
- `backend/app/services/knowledge/knowledge_base_qa_service.py`
- `backend/app/services/knowledge/indexing.py`
- `backend/app/services/knowledge/orchestrator.py`
- `backend/app/services/knowledge/summary_service.py`
- `backend/app/services/knowledge/document_read_service.py`
- `backend/app/services/rag/local_data_plane/indexing.py`
- `backend/app/services/work_queue_service.py`

### 关联字段

必须同步改为 `BigInteger`：

- `backend/app/models/task.py`
  - `TaskResource.id`
- `shared/models/db/subtask.py`
  - `Subtask.id`
  - `Subtask.task_id`
  - `Subtask.parent_id`
  - `Subtask.reply_to_subtask_id`
- `shared/models/db/subtask_context.py`
  - `SubtaskContext.subtask_id`
- `backend/app/models/resource_member.py`
  - `ResourceMember.resource_id`
  - `ResourceMember.copied_resource_id`
- `backend/app/models/share_link.py`
  - `ShareLink.resource_id`
- `backend/app/models/subscription.py`
  - `Subscription.task_id`
- `backend/app/models/wiki.py`
  - `WikiPage.task_id`
- `shared/models/db/work_queue.py`
  - `WorkQueue.source_task_id`
  - `WorkQueue.process_task_id`

---

## ID 设计

### Task / Workspace ID

`logs/task_id.py` 是原型实现，正式内部实现移入 `backend/wecode/task_sharding/task_id.py`。

内部专属代码统一放在 `backend/wecode/` 下，开源路径只保留 Store 边界和接口，不引入 Redis 发号器、分片 model 或内部路由逻辑。

```
63-bit BIGINT:
[62..42] 21 bits = seconds since EPOCH=2026-06-01
[41..19] 23 bits = uid
[18..0]  19 bits = sequence / random
```

规则：

- `uid` 超过 23 bits 时直接报错，不能 `uid & UID_MASK` 静默截断。
- 新 ID 最小值大于 `2^42`，旧 INT ID 小于 `2^31`，可用 `is_new_task_id()` 区分。
- `uid_from_task_id(task_id)` 用于从新 ID 直接路由到 shard。
- Task 和 Workspace 都使用同一个 ID 生成逻辑。

### Subtask ID

推荐同时把 `subtasks.id` 改为可反解 uid 的 BIGINT。

原因：

- 当前很多接口只传 `subtask_id`，例如消息更新、附件关联、流式状态、执行器回调。
- 如果 `subtasks.id` 继续分片自增，不同 shard 会产生重复 ID，单独按 `subtask_id` 查询无法路由。

规则：

- `generate_subtask_id(owner_uid)` 使用同样 bit layout。
- Redis key 和 Task ID 分开：`task_seq:{uid}:{second}`、`subtask_seq:{uid}:{second}`。
- `uid_from_subtask_id(subtask_id)` 用于单独 `subtask_id` 查询路由。
- 创建 subtask 时 owner uid 从 `task_id` 反解或从 task owner 获取，不能用发送消息用户的 `user_id`。

---

## Redis Sequence 与降级

正常路径：

```
key: task_seq:{uid}:{second}
key: subtask_seq:{uid}:{second}
cmd: Lua(INCRBY + EXPIRE 3)
ttl: 3 seconds
```

Redis Lua 返回 sequence 从 `0` 开始：

```lua
local v = redis.call("INCRBY", KEYS[1], ARGV[2])
local count = tonumber(ARGV[2])
if v == count then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return v - count
```

### Task / Subtask sequence 命名空间

`task_id` 和 `subtask_id` 使用同一个 bit layout，但 sequence 命名空间分开：

- Task / Workspace：`task_seq:{uid}:{second}`
- Subtask：`subtask_seq:{uid}:{second}`

使用同一个 sequence technically 可行，因为 `tasks` 和 `subtasks` 是不同表，跨表不要求 ID 唯一，且 uid 反解不依赖 sequence 是否独立。

但正式内部实现选择分开，原因：

- 和 Redis key 设计一致，task/subtask 发号压力互不影响。
- subtask 高并发不会消耗 task sequence 容量。
- 排查更清楚，可以单独观察 task 或 subtask 发号压力。
- 本地 fallback 与 Redis 行为保持一致，避免环境差异。

Redis 故障降级：

- 可以本地随机生成 sequence。
- 不能只生成后直接返回，因为多实例仍有碰撞风险。
- 降级 ID 必须落库唯一校验：
  - 创建 Task / Workspace：写入目标 shard，遇到 duplicate key 重试。
  - 创建 Subtask：写入目标 shard，遇到 duplicate key 重试。
  - 单纯 `/tasks` 预分配 ID：若不写 reservation 行，Redis 故障时返回 503；若需要可用性，则保留 reservation 行机制。
- 本地随机重试上限 3 次，失败返回 503。
- Redis 故障和本地随机降级必须打 error log 和 metric。

---

## 分表设计

| 项 | 设计 |
|---|---|
| 分表数量 | `WECODE_TASK_SHARD_COUNT`，默认 16 |
| Task / Workspace 表 | `tasks_00` ~ `tasks_{WECODE_TASK_SHARD_COUNT-1}` |
| Subtask 表 | `subtasks_00` ~ `subtasks_{WECODE_TASK_SHARD_COUNT-1}` |
| Task / Workspace 路由键 | owner `user_id % WECODE_TASK_SHARD_COUNT` |
| Subtask 路由键 | `uid_from_task_id(task_id) % WECODE_TASK_SHARD_COUNT` |
| 旧 ID 路由 | 原 `tasks` / `subtasks` 表 |
| group chat | task owner uid 决定 shard，成员通过 `resource_members` 查 task_id 后分组路由 |

`tasks_XX` 结构与当前 `tasks` 完全一致，仍保存 `kind='Task'` 和 `kind='Workspace'`。

`subtasks_XX` 结构与当前 `subtasks` 完全一致，但 `id/task_id/parent_id/reply_to_subtask_id` 使用 `BIGINT`。

---

## 开发计划

### Phase 0 - 内部 ID 基础设施

- [x] 新建 `backend/wecode/task_sharding/task_id.py`
  - 从 `logs/task_id.py` 迁移编码、解码、阈值判断逻辑。
  - 增加 `validate_uid(uid)`，uid 不合法直接抛 `ValueError`。
  - 暴露 `generate_task_id(uid, sequence_provider)`、`generate_subtask_id(uid, sequence_provider)`、`uid_from_task_id(id)`、`uid_from_subtask_id(id)`、`decode_task_id(id)`、`decode_subtask_id(id)`、`is_new_task_id(id)`。
  - 本地 fallback state 也按 task/subtask 分开，和 Redis key 语义一致。
- [x] 新建 `backend/wecode/task_sharding/redis_sequence.py`
  - Redis client 由 `backend/wecode` 注入，不在开源 `shared` 包中读取配置。
  - 使用 async Redis client；同步 Store 通过后台事件循环适配器调用 async Redis，避免阻塞服务主事件循环。
  - 使用 Lua 保证 `INCRBY` 和 `EXPIRE` 原子执行。
  - 支持批量申请连续 sequence：Redis 使用 `INCRBY` 原子获取一段连续 seq，常见 task/workspace、user/assistant 成对创建可一次申请 2 个 ID。
  - Redis key 按 ID 类型分开，避免 task/subtask 争用同一个 seq。
  - sequence 溢出时等待下一秒。
- [x] 实现 Redis 故障降级
  - 新增本地随机 sequence 生成。
  - Store 创建时做 DB 唯一约束重试。
  - 预分配 ID 接口在 Redis 故障且无 reservation 时返回 503。
- [x] 增加 `backend/wecode/tests/task_sharding/test_task_id.py`
  - uid 编码/解码。
  - uid 越界报错。
  - Redis seq 唯一。
  - Redis 故障随机降级生成合法 ID。

### Phase 1 - Schema 与模型

- [x] 新增 Alembic migration：把引用列改为 `BIGINT`
  - `tasks.id`
  - `subtasks.id`
  - `subtasks.task_id`
  - `subtasks.parent_id`
  - `subtasks.reply_to_subtask_id`
  - `subtask_contexts.subtask_id`
  - `resource_members.resource_id`
  - `resource_members.copied_resource_id`
  - `share_links.resource_id`
  - `subscriptions.task_id`
  - `wiki_pages.task_id`
  - `work_queue.source_task_id`
  - `work_queue.process_task_id`
- [x] 新增 Alembic migration：创建分表
  - `tasks_00` ~ `tasks_{WECODE_TASK_SHARD_COUNT-1}`
  - `subtasks_00` ~ `subtasks_{WECODE_TASK_SHARD_COUNT-1}`
  - 索引与原表保持一致。
- [x] 更新 SQLAlchemy models
  - `TaskResource.id` 改 `BigInteger`。
  - `Subtask` 相关 ID 改 `BigInteger`。
  - `SubtaskContext.subtask_id` 改 `BigInteger`。
  - `ResourceMember` / `ShareLink` / `Subscription` / `WikiPage` / `WorkQueue` 相关字段改 `BigInteger`。

### Phase 2 - 内部分片路由基础模块

- [x] 新建 `backend/wecode/task_sharding/shard.py`
  - `SHARD_COUNT = settings.WECODE_TASK_SHARD_COUNT`
  - `shard_index(uid: int) -> int`
  - `task_table_name(uid: int) -> str`
  - `subtask_table_name_by_task_id(task_id: int) -> str`
  - `task_model_for_user(uid: int)`
  - `task_model_for_task_id(task_id: int)`
  - `subtask_model_for_task_id(task_id: int)`
  - `subtask_model_for_subtask_id(subtask_id: int)`
  - `group_task_ids_by_shard(task_ids: Sequence[int])`
- [x] 动态 mapped class 做缓存
  - 避免每次查询重复创建 SQLAlchemy model。
  - shard model 保持和 `TaskResource` / `Subtask` 字段一致。
- [x] 增加 `backend/wecode/tests/task_sharding/test_shard.py`
  - uid 路由。
  - task_id 路由。
  - subtask_id 路由。
  - 旧 ID fallback。

### Phase 3 - TaskStore 改造

- [x] 新建内部 TaskStore 实现与注册入口
  - 内部实现放 `backend/wecode/task_sharding/task_store.py` 或同级拆分模块。
  - 不把分片 SQL、Redis 发号、动态 shard model 写进 `backend/app/stores/tasks/`。
  - 通过 `backend/wecode` 启动 patch / factory 注入替换默认 Store。
- [x] 改造创建路径
  - `create_placeholder_task_id` 改为调用 `generate_task_id(user_id)`。
  - Redis 正常时可只返回 ID。
  - Redis 故障时若接口只预分配 ID，返回 503；若创建真实 Task/Workspace，则写 shard 并重试。
  - `create_pending_task_shell` 生成新 ID 后写 `tasks_XX`。
  - `create_workspace` 生成新 ID 后写 `tasks_XX`。
  - `create_pending_task_shell_with_workspace` 在开源 Store 中保持组合默认实现，内部 Store 用 `generate_task_ids(..., 2)` 一次申请 task/workspace 两个 ID。
  - `create_task` 按传入 `task_id` 路由写 `tasks_XX`。
- [x] 改造单 ID 查询
  - `get_by_id`
  - `get_active_task`
  - `get_non_deleted_task`
  - `get_regular_active_task`
  - `get_task_by_states`
  - `get_active_workspace_by_id`
  - `list_by_ids`
  - `list_by_ids_ordered`
- [x] 改造 owner 查询
  - `get_owned_task_by_name`
  - `get_workspace_by_ref`
  - `list_active_workspaces_by_user`
  - `list_regular_active_tasks`
  - `list_archived_tasks`
  - `list_archivable_active_tasks`
  - `count_active_project_tasks`
  - `clear_project_for_owned_tasks`
- [x] 改造列表 SQL
  - owned / personal 查询走单 shard。
  - 开源侧保留单表 accessible/group chat 查询。
  - 内部定制版将 accessible 查询拆为 owned 单 shard + member task ids 分 shard 批量查。
  - 内部定制版 group chat member 查询从 `resource_members` 取 task_id 后按 shard 分组补 task 数据。
- [x] 保留旧 ID fallback
  - `is_new_task_id(id) == False` 时读旧 `tasks` 表。
  - 新写入不写旧表。

### Phase 4 - SubtaskStore 改造

- [x] 新建内部 SubtaskStore 实现与注册入口
  - 内部实现放 `backend/wecode/task_sharding/subtask_store.py` 或同级拆分模块。
  - 不把分片 SQL、Redis 发号、动态 shard model 写进 `backend/app/stores/tasks/`。
  - 通过 `backend/wecode` 启动 patch / factory 注入替换默认 Store。
- [x] 改造创建路径
  - `create_user_subtask`
  - `create_assistant_subtask`
  - `create_user_and_assistant_subtasks` 在开源 Store 中保持组合默认实现，内部 Store 用 `generate_subtask_ids(..., 2)` 一次申请 user/assistant 两个 subtask ID。
  - `create_subtask`
  - 创建时用 `uid_from_task_id(task_id)` 生成 `subtask.id`，写入 `subtasks_XX`。
- [x] 改造按 task_id 查询
  - `list_by_task`
  - `count_by_task_for_user`
  - `list_latest_by_task`
  - `list_new_messages_since`
  - `get_next_message_id`
  - `list_by_task_ordered`
  - `list_by_task_status`
  - `mark_task_subtasks_deleted`
  - `mark_task_messages_status`
  - `delete_after_message_id`
  - `delete_from_message_id`
- [x] 改造按 subtask_id 查询
  - `get_by_id`
  - `get_basic_by_id`
  - `get_by_id_and_role`
  - `get_accessible_by_id`
  - 使用 `uid_from_subtask_id(subtask_id)` 路由。
- [x] 改造批量 task_id 查询
  - `list_recent_by_task_ids`
  - `search_task_ids_by_content`
  - task_ids 按 shard 分组查询，结果内存合并。
- [x] 改造后台扫描类查询
  - `list_running_device_subtasks`
  - `list_running_by_executor_name`
  - `list_by_executor_ref`
  - `list_running`
  - `list_session_task_ids`
  - `mark_executor_deleted`
  - 这些查询需要扫 16 个 `subtasks_XX`，合并结果。
- [x] 处理 `SubtaskContext`
  - `Subtask.contexts` 关系继续通过 `Subtask.id == SubtaskContext.subtask_id`。
  - 删除/解绑 subtask 时同步更新 `SubtaskContext.subtask_id`。
  - 直接使用 `SubtaskContext.subtask_id` 的服务保持 `BigInteger`。

### Phase 5 - Access / Share 关联改造

- [x] 改造 `SqlAlchemyTaskAccessStore`
  - `get_task`
  - `get_task_owner_id`
  - `is_task_owner`
  - `is_member`
  - `is_group_chat`
  - `list_member_task_ids`
- [x] 改造 `resource_members` 相关业务
  - `task_member_service.py`
  - `shared_task.py`
  - `share/task_share_service.py`
  - `share/base_service.py`
  - `services/adapters/task_kinds/helpers.py`
  - `services/adapters/task_kinds/running_tasks.py`
- [x] 改造 `share_links`
  - `ShareLink.resource_id` 使用 `BigInteger`。
  - Task 分享查询通过 task_id 分片加载 Task。

### Phase 6 - Service/API 收口

- [x] 改造 `/tasks` ID 预分配
  - `backend/app/api/endpoints/adapter/tasks.py`
  - `backend/app/services/adapters/task_kinds/operations.py`
  - 去掉对 Placeholder 行存在性的强依赖。
- [x] 改造 WebSocket 创建与追加
  - `backend/app/api/ws/chat_namespace.py`
  - `backend/app/services/chat/storage/task_manager.py`
  - 新 task/workspace/subtask 全部走 Store。
- [x] 改造执行器回调与后台任务
  - `backend/app/services/execution/schedule_helper.py`
  - `backend/app/services/execution/dispatcher.py`
  - `backend/app/services/adapters/executor_job.py`
  - `backend/app/api/endpoints/internal/callback.py`
  - 禁止直接 `select(TaskResource)` / `select(Subtask)` 绕过 Store。
- [x] 改造知识库、附件、导出
  - `backend/app/services/context/context_service.py`
  - `backend/app/services/chat/preprocessing/contexts.py`
  - `backend/app/api/endpoints/adapter/attachments.py`
  - `backend/app/services/export/docx_generator.py`
  - `backend/app/services/knowledge/*`
- [x] 主 agent 验收补漏（2026-06-13）
  - `notification/group_chat_summary.py`、`notification/unread_notification.py` 收口到 Store。
  - `executor_cleanup_cursor_service.py` 收口到 SubtaskStore，默认 cursor 可读 legacy + shard。
  - `backend/wecode/service/cloud_device_provider.py`、`evaluation/grading_base.py`、`evaluation/grading_monitor.py` 收口到 Store。
  - 补齐生产启动入口：`wecode.api` 导入时安装内部 `ShardedTaskStore` / `ShardedSubtaskStore` / `ShardedTaskAccessStore`。
  - 补齐 `ShardedTaskStore` 继承旧表实现的缺口：TaskResource/KindResource 创建、kind/workspace/project/archive 查询、批量 ID 查询、archive 状态更新。
  - 补齐 `ShardedSubtaskStore.list_assistant_by_task`，避免内部 monitor 直接或间接只查旧表。
  - 补齐 `ShardedSubtaskStore` runtime 缺口：`get_first_by_task`、`get_latest_assistant_for_user_by_statuses`、`list_after_message_id`、`list_by_task_for_user_ordered`、`mark_task_subtasks_by_statuses`。
  - 接入成对创建批量发号：新任务创建走 `create_pending_task_shell_with_workspace`，AI 回复创建走 `create_user_and_assistant_subtasks`；开源默认 Store 只做组合封装，内部 Store 才用 Redis `INCRBY count=2`。
  - 补齐 adapter/API 创建路径：`create_task_or_append(task_id=None)` 直接走 task/workspace 成对创建；标准和 pipeline subtask 创建统一走 user/assistant 成对创建。
  - adapter task_kinds operations/helpers 改为运行时从 `app.stores.tasks` registry 取 Store，避免内部安装 sharded Store 后模块级旧引用继续写旧表。
  - 静态扫描非 Store / 非测试运行代码中直接 `TaskResource` / `Subtask` 查询，剩余命中仅为文档示例和模型注释。

### Phase 7 - 数据迁移与灰度

- [x] 发布兼容 schema
  - 先改 `BigInteger`。
  - 创建分表。
  - 不改变读写逻辑。
- [x] 发布双读单写
  - 新 ID 写 shard。
  - 新 ID 读 shard。
  - 旧 ID 读旧表。
  - 不做双写，避免一致性复杂度。
- [x] 存量迁移策略
  - 本轮内部版本不强制搬迁存量数据，旧表继续作为 legacy fallback。
  - 旧 `tasks` / `subtasks` 可以先保留，不强制搬迁。
  - 如果需要迁移，按 `user_id % 16` 搬 `tasks`，按 `task_id -> task.user_id % 16` 搬 `subtasks`。
  - 迁移后仍保留旧 ID fallback 一个版本周期。
- [ ] 清理旧逻辑（灰度后跟踪项）
  - 确认旧 ID 请求量归零后再移除旧表 fallback。
  - 归档旧 `tasks` / `subtasks`。

### Phase 8 - 测试

- [x] ID 单元测试
  - `cd backend && uv run pytest wecode/tests/task_sharding/test_task_id.py`
- [x] Store 单元测试
  - `cd backend && uv run pytest wecode/tests/task_sharding/test_shard.py`
  - `cd backend && uv run pytest tests/stores/tasks/test_sqlalchemy_task_store.py`
  - `cd backend && uv run pytest tests/stores/tasks/test_sqlalchemy_subtask_store.py`
- [x] 集成测试
  - 创建 Task。
  - 创建 Workspace。
  - 创建 user/assistant subtask。
  - task 列表。
  - group chat 成员查询。
  - attachment context 绑定 subtask。
  - executor callback 更新 subtask。
- [x] 并发测试
  - Redis 正常：并发生成 ID 无重复，依赖 Redis `INCRBY` 原子性保证跨进程一致。
  - Redis 故障：本地随机 + DB duplicate retry 无重复。
  - seq 溢出：等待下一秒。

---

## 风险与处理

| 风险 | 处理 |
|---|---|
| `subtask_id` 只按自增会跨 shard 冲突 | `subtasks.id` 改全局 BIGINT，并可反解 uid |
| Redis 故障导致重复 ID | 本地随机只作为候选，必须经过 DB 唯一约束和重试 |
| group chat 成员列表内部无法单表 join | 开源保留单表 Store 实现；内部定制 Store 先查 `resource_members`，再按 task_id 分 shard 查询 Task |
| 后台扫描类查询会扫 16 张表 | 先接受 16 shard scatter，后续如压力大再加运行态索引 |
| Task / Workspace 共表路由复杂 | Task 和 Workspace 都使用 owner uid 路由，保持现有 `kind` 模型 |
| 旧 ID 无法反解 uid | 旧 ID 只读旧表，新 ID 才进入 shard |
| 直接 ORM 查询绕过 Store | Phase 6 收口，新增测试防回归 |
