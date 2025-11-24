# 任务取消状态不一致问题分析

## ✅ 问题已修复

**修复时间**: 2025-11-24
**修复方案**: 方案2 - 在 Backend Callback 处理中自动更新 Task 状态
**修复文件**: [`backend/app/services/adapters/executor_kinds.py`](backend/app/services/adapters/executor_kinds.py:496-590)

### 修复内容

在 `_update_task_status_based_on_subtasks()` 方法中添加了对 `CANCELLED` 状态的处理逻辑：

1. **优先级1**: 如果 Task 状态为 `CANCELLING` 且有任何 Subtask 为 `CANCELLED`，自动将 Task 状态更新为 `CANCELLED`
2. **优先级2**: 如果最后一个非 PENDING 的 Subtask 状态为 `CANCELLED`，将 Task 状态更新为 `CANCELLED`
3. **状态保护**: 在更新为 RUNNING 状态前，检查 Task 是否已经处于终态（CANCELLED/COMPLETED/FAILED），避免覆盖终态

### 修复效果

- ✅ 当用户取消任务时，Task 状态会从 `CANCELLING` 正确更新为 `CANCELLED`
- ✅ Subtask 和 Task 的状态保持一致
- ✅ 前端能正确显示任务已取消
- ✅ 不会出现 Subtask 为 CANCELLED 但 Task 为 RUNNING 的情况

---

## 问题描述

当用户取消任务时，出现了一个状态不一致的问题：
- **子任务（Subtask）的最终状态**: `CANCELLED`
- **主任务（Task）的最终状态**: `RUNNING`

这导致前端显示任务仍在运行，但实际上任务已经被取消。

## 问题根源分析

### 1. 取消流程概述

任务取消涉及多个组件的协作：

```
用户点击取消
    ↓
Backend API (/api/tasks/{task_id}/cancel)
    ↓ (更新Task状态为CANCELLING)
Backend 后台任务 (call_executor_cancel)
    ↓
Executor Manager (/api/tasks/cancel)
    ↓
Executor (executor/main.py /api/tasks/cancel)
    ↓
AgentService.cancel_task()
    ↓
Agent.cancel_run() (AgnoAgent/ClaudeCodeAgent)
    ↓ (标记TaskState为CANCELLED)
Executor 后台任务 (send_cancel_callback_async)
    ↓
Backend Callback (/api/callback/progress)
    ↓
更新Subtask状态为CANCELLED
```

### 2. 关键代码路径

#### 2.1 Backend 取消请求处理

**文件**: [`backend/app/api/endpoints/adapter/tasks.py`](backend/app/api/endpoints/adapter/tasks.py:136-181)

```python
@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    # 1. 立即更新Task状态为CANCELLING
    task_kinds_service.update_task(
        db=db,
        task_id=task_id,
        obj_in=TaskUpdate(status="CANCELLING"),  # ← Task状态变为CANCELLING
        user_id=current_user.id
    )
    
    # 2. 在后台调用executor_manager
    background_tasks.add_task(call_executor_cancel, task_id)
    
    return {"message": "Cancel request accepted", "status": "CANCELLING"}
```

**关键点**:
- Task状态立即更新为 `CANCELLING`
- 后续的取消操作在后台异步执行

#### 2.2 Executor 取消处理

**文件**: [`executor/main.py`](executor/main.py:123-143)

```python
@app.post("/api/tasks/cancel")
async def cancel_task(
    task_id: int = Query(...),
    background_tasks: BackgroundTasks = None
):
    # 1. 调用agent_service取消任务
    status, message = agent_service.cancel_task(task_id)
    
    # 2. 在后台发送callback
    if background_tasks:
        background_tasks.add_task(
            agent_service.send_cancel_callback_async,
            task_id
        )
    
    return {"message": message}
```

#### 2.3 Agent 取消实现

**文件**: [`executor/agents/agno/agno_agent.py`](executor/agents/agno/agno_agent.py:1070-1119)

```python
def cancel_run(self) -> bool:
    # Layer 1: 立即标记状态为CANCELLED（不是CANCELLING）
    self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
    
    # Layer 2: 如果有run_id，调用SDK的cancel_run()
    if self.current_run_id is not None:
        if self.team is not None:
            cancelled = self.team.cancel_run(self.current_run_id)
        elif self.single_agent is not None:
            cancelled = self.single_agent.cancel_run(self.current_run_id)
    else:
        # 任务还未开始执行，没有run_id
        cancelled = True
    
    # 注意：不再在这里发送callback
    # callback将由main.py中的后台任务异步发送
    
    return cancelled
```

#### 2.4 Callback 发送

**文件**: [`executor/services/agent_service.py`](executor/services/agent_service.py:199-240)

```python
async def send_cancel_callback_async(self, task_id: int) -> None:
    # 发送CANCELLED状态的callback
    result = send_status_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        task_title=task_title,
        subtask_title=subtask_title,
        status=TaskStatus.CANCELLED.value,  # ← 发送CANCELLED状态
        message="${{tasks.cancel_task}}",
        progress=100
    )
```

**关键点**:
- Callback 只更新 **Subtask** 的状态为 `CANCELLED`
- **没有更新 Task 的状态**

#### 2.5 Backend 状态更新保护

**文件**: [`backend/app/services/adapters/task_kinds.py`](backend/app/services/adapters/task_kinds.py:508-538)

```python
def update_task(self, db: Session, *, task_id: int, obj_in: TaskUpdate, user_id: int):
    # 状态转换保护
    final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]
    non_final_states = ["PENDING", "RUNNING", "CANCELLING"]
    
    # 如果当前是CANCELLING状态，只允许转换到CANCELLED或FAILED
    if current_status == "CANCELLING":
        if new_status not in ["CANCELLED", "FAILED"]:
            logger.warning(
                f"Task {task_id}: Ignoring status update from CANCELLING to {new_status}"
            )
            # 不更新状态 ← 这里阻止了状态更新
        else:
            task_crd.status.status = new_status
```

**关键点**:
- 当Task状态为 `CANCELLING` 时，只接受 `CANCELLED` 或 `FAILED` 状态
- 拒绝从 `CANCELLING` 转换到 `RUNNING` 等非终态

### 3. 问题场景重现

#### 场景1：正常取消流程

```
时间线：
T0: Task状态=RUNNING, Subtask状态=RUNNING
T1: 用户点击取消
T2: Backend更新Task状态=CANCELLING
T3: Executor收到取消请求，Agent标记TaskState=CANCELLED
T4: Executor发送callback，Subtask状态=CANCELLED
T5: ✅ 预期：Task状态应该=CANCELLED
    ❌ 实际：Task状态=CANCELLING（没有被更新）
```

#### 场景2：任务执行中的状态更新

```
时间线：
T0: Task状态=RUNNING, Subtask状态=RUNNING
T1: 用户点击取消
T2: Backend更新Task状态=CANCELLING
T3: Agent执行循环仍在运行，发送进度更新
T4: Backend收到进度更新，尝试将Task状态更新为RUNNING
T5: ✅ Backend拒绝更新（状态保护机制生效）
T6: Executor发送cancel callback，Subtask状态=CANCELLED
T7: ❌ Task状态仍然=CANCELLING（没有最终状态）
```

### 4. 根本原因

**核心问题**: Callback 只更新了 Subtask 的状态，没有更新 Task 的状态

1. **Callback 设计缺陷**:
   - [`send_status_callback`](executor/services/agent_service.py:224-232) 只发送 subtask 的状态更新
   - Backend 的 callback 接口只更新 Subtask 表
   - Task 的状态需要单独更新，但没有相应的逻辑

2. **状态同步不完整**:
   - Backend 将 Task 状态设置为 `CANCELLING`
   - Executor 将 Subtask 状态设置为 `CANCELLED`
   - 但 Task 状态没有从 `CANCELLING` 更新到 `CANCELLED`

3. **缺少最终状态同步**:
   - 取消完成后，应该有一个机制将 Task 状态从 `CANCELLING` 更新为 `CANCELLED`
   - 当前实现中缺少这个步骤

## 解决方案

### 方案1：在 Callback 中同时更新 Task 状态（推荐）

**优点**:
- 一次性解决问题
- 保持状态一致性
- 符合现有架构

**实现**:

1. 修改 [`send_cancel_callback_async`](executor/services/agent_service.py:199-240):

```python
async def send_cancel_callback_async(self, task_id: int) -> None:
    # 1. 发送Subtask的CANCELLED状态
    result = send_status_callback(
        task_id=task_id,
        subtask_id=subtask_id,
        status=TaskStatus.CANCELLED.value,
        ...
    )
    
    # 2. 同时更新Task状态为CANCELLED
    # 调用backend API更新Task状态
    await self._update_task_status(task_id, TaskStatus.CANCELLED.value)
```

2. 在 Backend 添加内部 API 或直接在 callback 处理中更新 Task 状态

### 方案2：在 Backend Callback 处理中自动更新 Task 状态

**优点**:
- 集中处理逻辑
- 不需要修改 Executor

**实现**:

修改 Backend 的 callback 处理逻辑，当收到 Subtask 的 `CANCELLED` 状态时：

```python
def handle_progress_callback(task_id, subtask_id, status, ...):
    # 1. 更新Subtask状态
    update_subtask(subtask_id, status)
    
    # 2. 如果Subtask状态为CANCELLED，同时更新Task状态
    if status == "CANCELLED":
        task = get_task(task_id)
        if task.status == "CANCELLING":
            update_task(task_id, status="CANCELLED")
```

### 方案3：添加定时任务检查并修复不一致状态

**优点**:
- 作为兜底方案
- 可以修复历史数据

**实现**:

```python
async def fix_inconsistent_task_status():
    # 查找状态为CANCELLING但所有Subtask都已CANCELLED的Task
    tasks = db.query(Task).filter(
        Task.status == "CANCELLING"
    ).all()
    
    for task in tasks:
        subtasks = get_subtasks(task.id)
        if all(s.status == "CANCELLED" for s in subtasks):
            update_task(task.id, status="CANCELLED")
```

## 推荐实施步骤

1. **短期修复**（方案2）:
   - 在 Backend callback 处理中添加 Task 状态同步逻辑
   - 最小化改动，快速修复问题

2. **中期优化**（方案1）:
   - 重构 callback 机制，明确 Task 和 Subtask 的状态同步责任
   - 添加完整的状态转换测试

3. **长期保障**（方案3）:
   - 添加定时任务作为兜底
   - 添加监控告警，及时发现状态不一致

## 相关文件

- [`backend/app/api/endpoints/adapter/tasks.py`](backend/app/api/endpoints/adapter/tasks.py) - Backend 取消 API
- [`backend/app/services/adapters/task_kinds.py`](backend/app/services/adapters/task_kinds.py) - Task 状态更新逻辑
- [`executor/main.py`](executor/main.py) - Executor 取消 API
- [`executor/services/agent_service.py`](executor/services/agent_service.py) - Agent 服务和 Callback 发送
- [`executor/agents/agno/agno_agent.py`](executor/agents/agno/agno_agent.py) - AgnoAgent 取消实现
- [`executor/agents/claude_code/claude_code_agent.py`](executor/agents/claude_code/claude_code_agent.py) - ClaudeCodeAgent 取消实现
- [`executor/tasks/task_state_manager.py`](executor/tasks/task_state_manager.py) - 任务状态管理器
- [`shared/status.py`](shared/status.py) - 状态定义

## 测试建议

1. **单元测试**:
   - 测试 Task 状态从 `CANCELLING` 到 `CANCELLED` 的转换
   - 测试 Subtask 和 Task 状态的同步

2. **集成测试**:
   - 测试完整的取消流程
   - 验证最终状态一致性

3. **边界测试**:
   - 测试任务未开始时取消
   - 测试任务执行中取消
   - 测试任务即将完成时取消