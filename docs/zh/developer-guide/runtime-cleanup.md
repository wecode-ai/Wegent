---
sidebar_position: 17
---

# 运行时清理

运行时清理接口用于手动清理长时间无更新的执行环境。它只删除运行时 Pod/容器，不删除 Backend 中的 Task 记录和历史消息。

## 接口

```http
POST /api/admin/runtime-cleanup/stale
```

该接口仅管理员可用。

请求体：

```json
{
  "task_id": 123,
  "inactive_hours": 24,
  "dry_run": false,
  "archive_before_delete": true
}
```

该接口只支持按 Task ID 清理单个任务的运行时，不提供全量清理能力。

使用 `curl` 调用时必须声明 JSON Content-Type：

```bash
curl "https://<host>/api/admin/runtime-cleanup/stale" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"task_id":123,"inactive_hours":24,"dry_run":false,"archive_before_delete":true}'
```

字段说明：

| 字段 | 描述 | 默认值 |
|------|------|--------|
| `task_id` | 要清理运行时的 Task ID，必填 | - |
| `inactive_hours` | 无更新或无活动达到多少小时后才允许删除 | `24` |
| `dry_run` | 只返回将执行的结果，不实际删除 | `false` |
| `archive_before_delete` | 删除 sandbox 前是否先归档工作区 | `true` |

## 清理规则

接口只处理指定任务：

- 如果存在同 ID 的 sandbox，则按 sandbox 的 `last_activity_at` 判断是否过期。
- 如果不存在 sandbox，则按 Task/Subtask 的更新时间判断 task executor 是否过期。
- 未达到 `inactive_hours` 时不会删除，返回 `reason: "not_stale"`。
- 设置了 `preserveExecutor=true` 的任务不会删除。
- device executor 不会通过该接口删除。
- executor 删除成功后会标记相关 Subtask 的 `executor_deleted_at=true`。
- sandbox 删除由 Executor Manager 执行，默认会先归档工作区再删除。

## 返回示例

```json
{
  "task_id": 123,
  "inactive_hours": 24,
  "dry_run": false,
  "archive_before_delete": true,
  "results": {
    "task_executor": {
      "task_id": 123,
      "deleted": false,
      "skipped": true,
      "reason": "not_stale",
      "executors": [],
      "last_updated_at": "2026-05-18T10:30:00",
      "eligible_after": "2026-05-19T10:30:00"
    }
  }
}
```
