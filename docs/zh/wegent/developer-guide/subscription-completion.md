---
sidebar_position: 45
---

# 订阅完成回调

Rust 执行完成链路在持久化 Task 和助手结果后，将最终结果、错误和终态传给订阅完成处理器。Task 完成与订阅执行完成是两项状态更新；只更新 Task 会导致自动化时间线停留在 `RUNNING`，随后被超时清理误判为失败。

回调还保留 assistant subtask ID。处理器锁定 Task 和最新助手轮次，确认回调属于当前轮次，再按 Task 的 execution 标签精确读取执行记录；不会用旧回调终结同一 Task 的最新活跃执行。状态提交后的运行时清理会再次校验轮次。Task 级流式状态只在其 subtask ID 与回调一致时原子删除。

## 状态与幂等

处理器从主库事务中查找并锁定对应的 `background_executions`，检查状态转换，再以状态和版本作为更新条件。执行终态、UTC 完成时间、结果摘要、错误、订阅统计和收件箱结果一起提交。终态重复回调和版本冲突不会再次更新统计、发送实时事件或派发通知。

静默完成写为 `COMPLETED_SILENT`，不发送通知；普通订阅不累加静默执行的统计，Code Wiki 定时检查保留执行计数。取消执行不通知，并将对应收件箱消息恢复为未读，清空处理订阅引用为模型规定的 `0`。

## 完成后的副作用

事务提交后发送 `background:execution_update`。成功或静默成功的订阅复用执行器管理客户端，删除沙箱或执行器。执行器删除接口必须返回已删除或已不存在的业务结果（`success` / `not_found`），才能标记对应子任务的 `executor_deleted_at`；HTTP 200 中的 `failed`、无效响应和网络错误不会被当作删除成功。运行时清理失败会记录完整异常链，不回滚执行终态。

执行器管理客户端显式配置套接字读取超时，避免继承 Breeze SDK 默认的 400ms。读取上限使用最长操作的既有预算，各接口仍受原有的 30 / 60 / 120 / 180 秒请求总超时约束。这样 Kubernetes 删除操作在请求预算内稍慢时，不会出现 Pod 已删除、客户端提前超时且删除标记未回写的状态。

保留历史的订阅继续复用 Task，但统一派发入口会检查仍被数据库标记为可用的旧执行器。只有 Manager 明确确认 Pod 不存在，才回写删除标记并复用已有工作区恢复流程，再派发当前助手轮次；设备执行器不参与 Pod 检查，网络错误或无法确认的结果不会触发重建。

Manager 队列消费者同时检查提交结果的 `status=success` 和执行器名称。失败结果即使携带旧执行器名称，也会进入现有重试流程，耗尽重试后通过错误回调终结当前助手轮次和订阅执行，避免一直停留在 `RUNNING`。

成功和失败通知通过现有 Celery 协议派发 `app.tasks.subscription_completion_tasks.notify_execution`。worker 从已提交的执行记录读取结果，复用订阅通知分发器的关注者设置、渠道和 webhook；不会重放状态更新或执行器清理。静默、取消和 Code Wiki 定时更新不派发普通订阅通知。

生产者使用 `CELERY_BROKER_URL`，未单独设置时使用应用 Redis；队列为 `CELERY_TASK_DEFAULT_QUEUE`（默认 `wegent_online`）。显式 broker 按需建立并保留 SDK 连接，初始化失败时保留配置，后续新通知可重新连接，不改投缓存 Redis。通知沿用现有尽力发送语义，不补发先前失败的消息，未增加事务 outbox 或恰好一次投递保证。

## 发布与排查

先更新并启动 Backend Celery worker，使其注册新的通知任务，再启用 Rust 完成回调路由。仅更新 Rust 进程不足以提供通知消费能力。

运行时检查需要更新 Python Backend，提交失败回调修复需要更新 Executor Manager；只更新 Backend 镜像不会修正 Manager 的队列消费者。

使用 execution ID 和 Task ID 关联以下记录：Task/助手终态、`background_executions.status`、订阅统计、收件箱处理结果、子任务清理标记，以及 `subscription execution finalized`、清理和通知派发日志。`subscription notification enqueue failed` 表示派发失败，不能将回调 HTTP 200 当作通知已送达的证明。

此流程不会自动改写历史误判记录，也不会重新执行已经完成的 Task。
