# Flow 执行调试指南

本文档介绍如何通过日志排查 Flow 执行问题。

## 日志文件位置

| 文件 | 内容 | 用途 |
|------|------|------|
| `.pids/backend.log` | 后端 API + Celery Worker | Flow 创建、分发、状态变更 |
| `.pids/chat_shell.log` | Chat Shell 服务 | AI 对话执行详情 |
| `.pids/executor_manager.log` | Executor Manager | 执行器类型任务 |
| `.pids/celery_worker.log` | Celery Worker | 任务队列处理 |
| `.pids/celery_beat.log` | Celery Beat | 定时任务调度 |

## 日志关键字速查

### 按 Execution ID 查询

```bash
# 查看某个执行的完整生命周期
grep -E "execution.67|Execution 67|execution_id=67" .pids/backend.log

# 查看执行创建
grep "Created execution 67" .pids/backend.log

# 查看状态变更
grep "Execution 67 status changed" .pids/backend.log
```

### 按 Flow ID 查询

```bash
# 查看某个 Flow 的所有执行
grep "flow_id=4" .pids/backend.log

# 查看 Flow 的调度
grep "flow 4" .pids/backend.log
```

### 按 Task ID 查询

```bash
# 查看 Task 相关日志
grep "task.1420\|task_id=1420\|Task 1420" .pids/backend.log

# 查看 Chat Shell 中的 Task 处理
grep "task=1420" .pids/chat_shell.log
```

### 按状态查询

```bash
# 查看所有失败的执行
grep "status.*FAILED\|-> FAILED" .pids/backend.log

# 查看所有超时的执行
grep "timed out\|timeout" .pids/backend.log

# 查看所有被取消的执行
grep "CANCELLED\|cancelled" .pids/backend.log

# 查看卡住的执行被清理
grep "stale RUNNING\|Cleaned stale" .pids/backend.log
```

## 执行生命周期日志

### 正常执行流程

```
[Flow] Created execution {id}: flow_id={fid}, flow_name={name},
       trigger_type={type}, trigger_reason={reason}, user_id={uid}, status=PENDING

[Flow] Dispatching execution {id} (celery): flow_id={fid},
       timeout={sec}s, retry_count={n}

[flow_tasks] Created task {tid} for flow {fid} execution {id}

[Flow] Execution {id} status changed: PENDING -> RUNNING, flow_id={fid}, task_id={tid}

[FlowEmitter] chat:done task={tid} subtask={sid} execution_id={id}

[Flow] Execution {id} status changed: RUNNING -> COMPLETED,
       flow_id={fid}, task_id={tid}, summary={摘要}
```

### 失败执行流程

```
[Flow] Created execution {id}: ...status=PENDING

[Flow] Dispatching execution {id} (celery): ...

[flow_tasks] Error executing flow {fid}: {错误信息}

[Flow] Execution {id} status changed: RUNNING -> FAILED,
       flow_id={fid}, task_id={tid}, error={错误信息}
```

### 超时清理流程

```
[flow_tasks] Found {n} stale RUNNING executions to cleanup
             (threshold: {hours}h, before {time})

[flow_tasks] Cleaned stale RUNNING execution {id}:
             flow_id={fid}, task_id={tid}, started_at={time},
             running_hours={h}h, reason=exceeded {threshold}h threshold
```

### 用户取消流程

```
[Flow] Execution {id} cancelled by user {uid}:
       flow_id={fid}, task_id={tid}, previous_status={status},
       running_hours={h}h
```

## 常见问题排查

### 1. 执行一直卡在 RUNNING

**查询命令**：
```bash
# 查看该执行的所有日志
grep "execution.{ID}" .pids/backend.log

# 查看是否有错误
grep "execution.{ID}" .pids/backend.log | grep -i "error\|fail\|exception"

# 查看对应的 Task 处理
grep "task={TASK_ID}" .pids/chat_shell.log
```

**可能原因**：
- AI 服务无响应 → 检查 chat_shell.log
- Executor 未回调 → 检查 executor_manager.log
- 网络问题 → 检查错误日志

**解决方案**：
- 等待自动清理（默认 3 小时后标记为 FAILED）
- 手动取消：`POST /api/flows/executions/{id}/cancel`

### 2. 执行立即失败

**查询命令**：
```bash
# 查看失败原因
grep "Execution {ID}.*FAILED" .pids/backend.log

# 查看详细错误
grep "execution.{ID}" .pids/backend.log | grep -i "error"
```

**可能原因**：
- Team 不存在
- Workspace 配置错误
- Prompt 为空

### 3. 定时任务不触发

**查询命令**：
```bash
# 查看 check_due_flows 运行情况
grep "check_due_flows" .pids/backend.log | tail -20

# 查看 Flow 是否被检测到
grep "flow.{ID}.*due\|dispatched" .pids/backend.log
```

**可能原因**：
- Flow 未启用 (enabled=false)
- next_execution_time 未设置
- Celery Beat 未运行

### 4. Webhook 触发失败

**查询命令**：
```bash
# 查看 webhook 请求
grep "webhook" .pids/backend.log | grep "{FLOW_ID}\|{TOKEN}"

# 查看是否创建了执行
grep "trigger_type=webhook" .pids/backend.log
```

### 5. 查看系统健康状态

```bash
# 查看最近的执行统计
grep "check_due_flows completed" .pids/backend.log | tail -5

# 输出示例:
# check_due_flows completed: 3/3 flows dispatched, 0 pending recovered, 1 running cleaned

# 查看是否有大量失败
grep "FAILED" .pids/backend.log | wc -l

# 查看是否有卡住的执行被清理
grep "stale RUNNING" .pids/backend.log | tail -10
```

## 实时监控

```bash
# 实时查看后端日志
tail -f .pids/backend.log

# 实时查看后端日志，只显示 Flow 相关
tail -f .pids/backend.log | grep --line-buffered "\[Flow\]\|\[flow_tasks\]\|\[FlowEmitter\]"

# 实时查看错误
tail -f .pids/backend.log | grep --line-buffered -i "error\|fail\|exception"

# 实时查看特定执行
tail -f .pids/backend.log | grep --line-buffered "execution.67"
```

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `FLOW_STALE_RUNNING_HOURS` | 3 | RUNNING 状态超时阈值（小时） |
| `FLOW_STALE_PENDING_HOURS` | 2 | PENDING 状态超时阈值（小时） |
| `FLOW_DEFAULT_TIMEOUT_SECONDS` | 600 | 单次执行超时（秒） |
| `FLOW_DEFAULT_RETRY_COUNT` | 1 | 失败重试次数 |

## API 辅助查询

```bash
# 查询卡住的执行（需要认证）
curl -H "Authorization: Bearer {TOKEN}" \
  "http://localhost:8000/api/flows/executions/stale?hours=1&status=RUNNING"

# 取消执行
curl -X POST -H "Authorization: Bearer {TOKEN}" \
  "http://localhost:8000/api/flows/executions/{ID}/cancel"
```

## 日志级别说明

| 级别 | 含义 |
|------|------|
| `INFO` | 正常操作（创建、状态变更、完成） |
| `WARNING` | 需要注意（超时清理、无效状态转换） |
| `ERROR` | 执行失败、异常 |
| `DEBUG` | 详细调试信息（需开启 DEBUG 模式） |
