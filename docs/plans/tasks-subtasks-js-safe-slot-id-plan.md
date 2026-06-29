# Task / Subtask JS Safe ID 调整计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将内部 `task_id` / `subtask_id` 发号方案调整为 JS `number` 安全，同时支持长期运行、分表路由和未来扩表迁移。

**Architecture:** ID 从旧的 `timestamp + uid + seq` 改为 `timestamp + slot + seq`。ID 内保存稳定逻辑槽 `slot`，物理表通过 `slot % WECODE_TASK_SHARD_COUNT` 映射，避免扩表时重生成历史 ID。

**Tech Stack:** Python, FastAPI, SQLAlchemy, Alembic, Redis, MySQL, pytest.

---

## 背景问题

当前内部发号方案是：

```text
timestamp 21 bits | uid 23 bits | seq 19 bits = 63 bits
```

存在两个问题：

- `timestamp 21 bits` 按秒只能支持约 24.3 天，不能长期运行。
- 63-bit ID 会超过 JS `Number.MAX_SAFE_INTEGER = 2^53 - 1`，前端 `number` 会丢精度，导致创建成功后详情、runtime-check 等接口可能 404。

本计划替代旧计划中的 63-bit ID 布局。

---

## 新 ID 格式

采用 53-bit 布局：

```text
timestamp 31 bits | slot 10 bits | seq 12 bits = 53 bits
```

容量：

- `timestamp`：秒级，`2^31 - 1` 秒，约 68 年。
- `slot`：固定逻辑槽，`0..1023`。
- `seq`：每 slot 每秒 4096 个 ID。
- 成对申请：每 slot 每秒约 2048 组。
- 最大 ID 不超过 JS `Number.MAX_SAFE_INTEGER`。

编码时 `timestamp` 必须使用相对业务纪元的秒级偏移，不是 Unix timestamp：

```text
timestamp_delta = current_second - EPOCH
id = (timestamp_delta << 22) | (slot << 12) | seq
```

解析：

```text
seq = id & 4095
slot = (id >> 12) & 1023
timestamp = (id >> 22) + EPOCH
```

生成后必须校验：

```text
id <= Number.MAX_SAFE_INTEGER = 9007199254740991
```

---

## Slot 与物理分片

ID 中保存的是稳定 `slot`，不是物理分片号。

```text
slot = user_id % 1024
physical_shard = slot % WECODE_TASK_SHARD_COUNT
```

创建时：

```text
user_id -> slot -> physical_shard -> tasks_XX / subtasks_XX
```

按 ID 查询时：

```text
task_id/subtask_id -> slot -> physical_shard -> tasks_XX / subtasks_XX
```

配置约束：

```text
WECODE_TASK_SHARD_COUNT 必须是 1..1024 之间的 2 的幂
```

本地开发：

```text
WECODE_TASK_SHARD_COUNT=2
```

线上可选：

```text
16 / 64 / 256 / 1024
```

不建议使用非 2 的幂分片数。虽然 `slot % shard_count` 技术上可运行，但会带来 slot 分布偏差，并让扩表迁移规则更难验证。

---

## 扩表规则

不能只改 `WECODE_TASK_SHARD_COUNT`。

扩表流程：

```text
1. 创建新分片表。
2. 按 slot % new_shard_count 迁移旧数据。
3. 验证迁移后行数和抽样 ID 路由。
4. 切换 WECODE_TASK_SHARD_COUNT。
5. 重启服务或刷新配置。
```

历史 ID 不需要重生成，因为 ID 内保存的是稳定 `slot`。

---

## Redis Sequence

Redis key 维度从 `uid` 改为 `slot`：

```text
task_seq:{slot}:{second}
subtask_seq:{slot}:{second}
```

批量发号使用 `INCRBY count`。

约束：

- `seq` 范围是 `0..4095`。
- 如果 `INCRBY` 后超过 `4095`，不能继续生成 ID。
- 超限策略：等待下一秒后重试，重试仍超限则返回 503。
- task 和 subtask sequence 命名空间继续分开。

---

## 实施任务

### Task 1: 更新 ID 编码与解析

**Files:**

- Modify: `backend/wecode/task_sharding/task_id.py`
- Test: `backend/wecode/tests/task_sharding/test_task_id.py`

- [x] 修改 bit 常量：

```python
TIMESTAMP_BITS = 31
SLOT_BITS = 10
SEQ_BITS = 12

SLOT_COUNT = 1 << SLOT_BITS
SLOT_MASK = SLOT_COUNT - 1
SEQ_MASK = (1 << SEQ_BITS) - 1
MAX_JS_SAFE_INTEGER = (1 << 53) - 1
```

- [x] 将 `uid` 语义改为 `slot`，不再保留 `uid_from_*` 兼容函数名。

```python
def slot_for_user_id(user_id: int) -> int:
    return validate_user_id(user_id) % SLOT_COUNT

def slot_from_task_id(task_id: int) -> int:
    return decode_task_id(task_id).slot

def slot_from_subtask_id(subtask_id: int) -> int:
    return decode_task_id(subtask_id).slot
```

- [x] 删除 `uid_from_task_id()` / `uid_from_subtask_id()`，避免后续把 slot 误当 owner user_id。

- [x] 删除所有“从 ID 反推真实 user_id”的语义。ID 只负责路由，权限和 owner 校验必须来自 DB 字段。

- [x] 生成 ID 后断言：

```python
if generated_id > MAX_JS_SAFE_INTEGER:
    raise ValueError("generated id exceeds JavaScript safe integer")
```

- [x] 测试覆盖：
  - ID 小于等于 `2^53 - 1`。
  - 能解析出 `timestamp/slot/seq`。
  - `slot_for_user_id(user_id)` 固定为 `user_id % 1024`。
  - `seq=4095` 可用，`seq=4096` 拒绝。

### Task 2: 更新分片路由

**Files:**

- Modify: `backend/wecode/task_sharding/shard.py`
- Test: `backend/wecode/tests/task_sharding/test_shard.py`

- [x] 新增逻辑槽到物理分片映射：

```python
def physical_shard_for_slot(slot: int) -> int:
    return validate_slot(slot) % SHARD_COUNT
```

- [x] 创建路径用：

```python
slot = slot_for_user_id(user_id)
table = f"tasks_{physical_shard_for_slot(slot):04d}"
```

- [x] 查询路径用：

```python
slot = slot_from_task_id(task_id)
table = f"tasks_{physical_shard_for_slot(slot):04d}"
```

- [x] subtask 查询同理从 `task_id/subtask_id` 解析 slot。

- [x] `is_new_task_id()` 只识别当前 53-bit slot 布局；旧 63-bit 开发数据已清理，不做兼容。

- [x] 测试覆盖：
  - `WECODE_TASK_SHARD_COUNT=2` 时 slot `0/2/4` 路由到 `00`，slot `1/3/5` 路由到 `01`。
  - `WECODE_TASK_SHARD_COUNT=16` 时 slot `17` 路由到 `01`。
  - 同一个 ID 在不同 shard_count 下物理表可预测，用于扩表迁移验证。

### Task 3: 更新 Redis 发号

**Files:**

- Modify: `backend/wecode/task_sharding/task_id.py`
- Modify: `backend/wecode/task_sharding/redis_sequence.py`
- Test: `backend/wecode/tests/task_sharding/test_task_id.py`
- Test: `backend/wecode/tests/task_sharding/test_redis_sequence.py` if present, otherwise extend existing task id tests.

- [x] Redis sequence key 参数从 `uid` 改为 `slot`。

```python
provider.next_sequences(namespace, slot, second, count)
```

- [x] 批量申请后校验最后一个 seq：

```python
if start + count - 1 > SEQ_MASK:
    raise SequenceExhaustedError(...)
```

- [x] 生成 task/workspace 成对 ID 时只调用一次 `INCRBY 2`。

- [x] 生成 user/assistant subtask 成对 ID 时只调用一次 `INCRBY 2`。

- [x] 测试覆盖：
  - `count=2` 返回连续 ID。
  - `seq` 超过 `4095` 时失败或等待下一秒。
  - task/subtask namespace 互不影响。

### Task 4: 更新配置校验

**Files:**

- Modify: `backend/app/core/config.py`
- Test: `backend/tests/core/test_config.py`

- [x] 修改 shard count 校验：

```python
if v < 1 or v > 1024 or v & (v - 1) != 0:
    raise ValueError("WECODE_TASK_SHARD_COUNT must be a power of two between 1 and 1024")
```

- [x] 测试覆盖：
  - 默认值仍为 `16`。
  - `2` 合法。
  - `1024` 合法。
  - `0`、`3`、`1025` 非法。

### Task 5: 更新 Store 创建与查询语义

**Files:**

- Modify: `backend/wecode/task_sharding/task_store.py`
- Modify: `backend/wecode/task_sharding/subtask_store.py`
- Test: `backend/wecode/tests/task_sharding/test_task_store.py`
- Test: `backend/wecode/tests/task_sharding/test_subtask_store.py`
- Test: `backend/wecode/tests/task_sharding/test_task_service_preallocation.py`

- [x] 创建 task/workspace 时根据 `user_id` 算 slot。
- [x] 创建 subtask 时根据所属 task 的 slot 发号，不使用消息发送者 user_id。
- [x] 按 task_id 查询时从 ID 解析 slot。
- [x] 按 subtask_id 查询时从 ID 解析 slot。
- [x] 删除内部 Store 中用 `uid_from_task_id(task_id) == owner_user_id` 或 `uid_from_subtask_id(subtask_id) == owner_user_id` 的判断。
- [x] `owner_user_id` 过滤必须通过 DB 字段完成：
  - Task/Workspace：查目标 shard 表并过滤 `model.user_id == owner_user_id`。
  - Subtask 按 task_id 查询：先按 task_id 路由到 subtask shard，再通过 task owner 或 task_id 所属 task 校验 owner。
  - Subtask 按 subtask_id 查询：先按 subtask_id 路由到 subtask shard，必要时再查对应 task 校验 owner。
- [x] 测试覆盖：
  - task/workspace 成对创建落到同一个 slot 对应物理表。
  - user/assistant subtask 成对创建落到同一个 slot 对应物理表。
  - 不同 user_id 但同 slot 的用户不能互相通过 owner 校验。
  - `WECODE_TASK_SHARD_COUNT=2` 本地模式能创建并查询。

### Task 6: 更新迁移与建表文档

**Files:**

- Modify: `backend/alembic/versions/20260612_d5e6f7a8b9c0_add_task_subtask_bigint_shards.py`
- Modify: `docs/plans/tasks-subtasks-sharding.md`
- Test: `backend/tests/models/test_task_sharding_schema.py`

- [x] 保持表数量由 `WECODE_TASK_SHARD_COUNT` 控制。
- [x] 表名统一使用四位后缀，支持 `0000..1023`，不再保留两位后缀：

```text
tasks_0000
subtasks_0000
```

- [x] 测试覆盖：
  - `WECODE_TASK_SHARD_COUNT=2` 创建 `tasks_0000/0001`。
  - `WECODE_TASK_SHARD_COUNT=1024` 生成表名范围到 `tasks_1023`。

### Task 7: 本地验收

**Files:**

- No new source files.

- [ ] 清理本地分表测试库，设置：

```bash
export WECODE_INTERNAL_EXTENSIONS_ENABLED=true
export WECODE_TASK_SHARDING_ENABLED=true
export WECODE_TASK_SHARD_COUNT=2
```

- [x] 执行：

```bash
cd backend
uv run alembic upgrade head
uv run pytest -n0 wecode/tests/task_sharding tests/core/test_config.py tests/models/test_task_sharding_schema.py -q
```

- [ ] 手工验证：
  - 创建新任务。
  - `task_id <= 9007199254740991`。
  - 前端 URL 中 task_id 不丢精度。
  - `GET /api/tasks/{task_id}` 正常。
  - `GET /api/tasks/{task_id}/runtime-check` 正常。

---

## 注意事项

- 现有开发库里已生成的 63-bit ID 已清理，本实现不做 63-bit 兼容。
- 前端暂不做 string ID 改造；若以后改为 string，应作为独立计划处理。
- 扩表必须配套数据迁移，不能只改 `WECODE_TASK_SHARD_COUNT`。
