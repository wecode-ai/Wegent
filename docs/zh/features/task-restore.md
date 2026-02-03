# 任务恢复功能

## 概述

本文档描述了任务恢复功能，该功能允许用户在任务过期或执行器容器被清理后继续对话。

## 问题描述

在 Wegent 中，任务使用 Docker 容器（执行器）来处理 AI 对话。这些容器有生命周期：

1. **过期**：Chat 任务在 2 小时不活动后过期，Code 任务在 24 小时后过期
2. **容器清理**：过期任务的容器会被自动删除以释放资源
3. **问题**：当用户尝试向过期/已清理的任务发送消息时，会遇到"容器未找到"错误

## 解决方案

任务恢复功能提供了一个优雅的恢复机制：

1. 当用户向过期或容器已删除的任务发送消息时，后端返回 HTTP 409 和 `TASK_EXPIRED_RESTORABLE` 代码
2. 前端显示恢复对话框，给用户两个选项：
   - **继续对话**：恢复任务并重新发送消息
   - **新建对话**：创建新任务
3. 如果用户选择继续，恢复 API 会重置任务状态并允许创建新容器

## 技术实现

### 后端更改

#### 1. 执行器删除检测 (`executor_kinds.py`)

当 executor_manager 报告"容器未找到"错误时，subtask 被标记为 `executor_deleted_at=True`：

```python
# 当报告容器未找到错误时标记执行器已删除
if subtask_update.status == SubtaskStatus.FAILED and subtask_update.error_message:
    error_msg = subtask_update.error_message.lower()
    if "container" in error_msg and "not found" in error_msg:
        subtask.executor_deleted_at = True
```

#### 2. 追加前检查 (`operations.py`)

在允许消息追加到现有任务之前，检查：
- 最后一个 assistant subtask 的 `executor_deleted_at` 标志
- 任务过期时间

如果满足任一条件，返回 HTTP 409：

```python
if last_assistant_subtask and last_assistant_subtask.executor_deleted_at:
    raise HTTPException(
        status_code=409,
        detail={
            "code": "TASK_EXPIRED_RESTORABLE",
            "task_id": existing_task.id,
            "task_type": task_type,
            ...
        },
    )
```

#### 3. 恢复 API (`task_restore.py`)

新端点 `POST /tasks/{task_id}/restore`：
1. 验证任务存在且用户有访问权限
2. 重置 `updated_at` 时间戳
3. 清除 `executor_deleted_at` 标志
4. 清除所有 assistant subtask 的 `executor_name`（强制创建新容器）

```python
# 重置已标记 subtask 的 executor_deleted_at
db.query(Subtask).filter(
    Subtask.task_id == task_id,
    Subtask.executor_deleted_at.is_(True),
).update({Subtask.executor_deleted_at: False})

# 清除所有 assistant subtask 的 executor_name
# 这防止了旧容器名的继承
db.query(Subtask).filter(
    Subtask.task_id == task_id,
    Subtask.role == SubtaskRole.ASSISTANT,
    Subtask.executor_name.isnot(None),
    Subtask.executor_name != "",
).update({Subtask.executor_name: ""})
```

#### 4. Executor Name 继承修复 (`helpers.py`)

修复了 `_create_standard_subtask` 中的一个 bug，该 bug 会盲目从第一个现有 subtask 继承 `executor_name`，而不检查：
- subtask 是否是 ASSISTANT 角色（USER subtask 的 executor_name 为空）
- executor_name 是否非空

修复前（有 bug）：
```python
if existing_subtasks:
    executor_name = existing_subtasks[0].executor_name
```

修复后：
```python
for s in existing_subtasks:
    if s.role == SubtaskRole.ASSISTANT and s.executor_name:
        executor_name = s.executor_name
        break
```

### 前端更改

#### 1. 错误解析器 (`errorParser.ts`)

添加了对 HTTP 409 响应中 `TASK_EXPIRED_RESTORABLE` 错误代码的解析。

#### 2. 恢复对话框 (`TaskRestoreDialog.tsx`)

新对话框组件显示：
- 过期信息（任务类型、过期时长）
- 继续对话选项（调用恢复 API 然后重发消息）
- 新建对话选项

#### 3. 流处理器 (`useChatStreamHandlers.tsx`)

- 添加恢复对话框可见性状态
- 添加 `handleConfirmRestore` 处理器：
  1. 调用恢复 API
  2. 刷新任务详情
  3. 重发待发送的消息

### API 更改

#### 新端点

```
POST /api/v1/tasks/{task_id}/restore
```

**请求体：**
```json
{
  "message": "恢复后可选发送的消息"
}
```

**响应：**
```json
{
  "success": true,
  "task_id": 123,
  "task_type": "chat",
  "executor_rebuilt": true,
  "message": "Task restored successfully"
}
```

## 流程图

```
用户向过期任务发送消息
         │
         ▼
后端检查过期/executor_deleted_at
         │
         ▼
    ┌────┴────┐
    │ 过期或  │ ──是──► 返回 HTTP 409
    │ 已删除  │         TASK_EXPIRED_RESTORABLE
    └────┬────┘
         │否
         ▼
    正常继续

前端收到 HTTP 409
         │
         ▼
   显示恢复对话框
         │
    ┌────┴────┐
    │  继续   │ ──是──► 调用 POST /tasks/{id}/restore
    │  对话？ │                    │
    └────┬────┘                    ▼
         │否              清除执行器数据
         ▼                重置时间戳
   创建新任务                    │
                                 ▼
                          重发消息
                                 │
                                 ▼
                          创建新容器
```

## 更改的文件

| 文件 | 更改 |
|------|------|
| `backend/app/api/api.py` | 注册 task_restore 路由 |
| `backend/app/api/endpoints/adapter/task_restore.py` | 新的恢复 API 端点 |
| `backend/app/services/adapters/task_restore.py` | 新的恢复服务 |
| `backend/app/services/adapters/executor_kinds.py` | 错误时标记 executor_deleted_at，继承 executor_name |
| `backend/app/services/adapters/task_kinds/operations.py` | 追加前检查 executor_deleted_at |
| `backend/app/services/adapters/task_kinds/helpers.py` | 修复 executor_name 继承 bug |
| `frontend/src/apis/tasks.ts` | 添加 restoreTask API |
| `frontend/src/utils/errorParser.ts` | 解析 TASK_EXPIRED_RESTORABLE 错误 |
| `frontend/src/features/tasks/components/chat/TaskRestoreDialog.tsx` | 新的恢复对话框 |
| `frontend/src/features/tasks/components/chat/useChatStreamHandlers.tsx` | 处理恢复流程 |
| `frontend/src/i18n/locales/*/chat.json` | 添加国际化翻译 |

## 配置

过期时间由环境变量控制：

- `APPEND_CHAT_TASK_EXPIRE_HOURS`：Chat 任务过期小时数（默认：2）
- `APPEND_CODE_TASK_EXPIRE_HOURS`：Code 任务过期小时数（默认：24）
