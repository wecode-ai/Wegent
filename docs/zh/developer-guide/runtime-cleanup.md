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
  "inactive_hours": 24,
  "targets": ["task_executors", "sandboxes"],
  "dry_run": false
}
```

字段说明：

| 字段 | 描述 | 默认值 |
|------|------|--------|
| `inactive_hours` | 无更新或无活动达到多少小时后才允许删除 | `24` |
| `targets` | 清理目标，可选 `task_executors`、`sandboxes` | 两者都清理 |
| `dry_run` | 只返回将执行的结果，不实际删除 | `false` |

## 清理规则

`task_executors` 清理 Wegent task executor Pod：

- 使用 Task 和 Subtask 的最近更新时间判断是否过期。
- 未达到 `inactive_hours` 时不会删除，返回 `reason: "not_stale"`。
- 设置了 `preserveExecutor=true` 的任务不会删除。
- device executor 不会通过该接口删除。
- 删除成功后会标记相关 Subtask 的 `executor_deleted_at=true`。

`sandboxes` 清理 sandbox Pod：

- 使用 sandbox 的 `last_activity_at` 判断是否过期。
- 未达到 `inactive_hours` 时不会删除，返回 `reason: "not_stale"`。
- 删除由 Executor Manager 执行。

## 返回示例

```json
{
  "inactive_hours": 24,
  "dry_run": false,
  "results": {
    "task_executors": {
      "target": "task_executors",
      "deleted": [],
      "skipped": [
        {
          "task_id": 123,
          "executor_name": "executor-recent",
          "executor_namespace": "default",
          "reason": "not_stale",
          "last_updated_at": "2026-05-18T10:30:00",
          "eligible_after": "2026-05-19T10:30:00"
        }
      ],
      "failed": []
    }
  }
}
```
