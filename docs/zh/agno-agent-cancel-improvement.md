# AgnoAgent 任务取消机制改进方案

## 问题分析

### 当前问题
从日志可以看到，当任务还没有真正开始执行时（没有 `run_id`），用户点击取消会报错：

```
2025-11-20 15:01:15 - WARNING - No run_id available for session_id: 272, cannot cancel
2025-11-20 15:01:15 - WARNING - [task_id: 272.-1] Failed to cancel Agno task
INFO: 127.0.0.1:56688 - "POST /api/tasks/cancel?task_id=272 HTTP/1.1" 400 Bad Request
```

### 根本原因

1. **run_id 设置时机过晚**
   - `current_run_id` 只在 `run_started` 事件时才会被设置（第484行和第847行）
   - 如果任务在以下阶段被取消，`run_id` 仍然是 None：
     - 初始化阶段（`initialize()`）
     - 预执行阶段（`pre_execute()`）
     - 创建 Team/Agent 阶段（`_create_team()`, `_create_agent()`）
     - MCP 工具初始化阶段
     - 等待进入 streaming 循环之前

2. **缺少状态追踪机制**
   - AgnoAgent 没有使用 TaskStateManager 来追踪任务状态
   - 无法在执行循环中检查取消状态并主动退出

3. **取消逻辑过于严格**
   - `cancel_run()` 方法在 `run_id` 为 None 时直接返回 False
   - 没有考虑早期阶段的取消场景

## 解决方案

### 方案概述

实现一个**多层次、渐进式的取消机制**，支持任务生命周期各个阶段的取消：

```
┌─────────────────────────────────────────────────────────────┐
│                    任务生命周期                              │
├─────────────────────────────────────────────────────────────┤
│ 1. 初始化 → 2. 预执行 → 3. 创建Agent → 4. 执行 → 5. 完成   │
│    ↓           ↓           ↓            ↓         ↓         │
│  可取消      可取消       可取消       可取消    已完成      │
└─────────────────────────────────────────────────────────────┘

取消机制层次：
┌──────────────────────────────────────────────────────────────┐
│ 第1层：TaskStateManager 标记状态为 CANCELLING                │
│ 第2层：执行循环检查状态，主动退出                             │
│ 第3层：如果有 run_id，调用 SDK 的 cancel_run()               │
│ 第4层：清理资源（ResourceManager）                           │
│ 第5层：同步状态到后端（StatusSynchronizer）                  │
└──────────────────────────────────────────────────────────────┘
```

### 具体改进

#### 1. 集成 TaskStateManager

在 `AgnoAgent.__init__()` 中初始化状态管理器：

```python
from executor.tasks.task_state_manager import TaskStateManager, TaskState

def __init__(self, task_data: Dict[str, Any]):
    super().__init__(task_data)
    # ... 现有代码 ...
    
    # 初始化状态管理器
    self.task_state_manager = TaskStateManager()
    self.task_state_manager.set_state(self.task_id, TaskState.RUNNING)
```

#### 2. 在执行循环中添加取消检查点

在关键执行点检查取消状态：

```python
async def _async_execute(self) -> TaskStatus:
    try:
        # 检查点 1：执行开始前
        if self.task_state_manager.is_cancelled(self.task_id):
            logger.info(f"Task {self.task_id} cancelled before execution")
            return TaskStatus.COMPLETED
        
        # ... 创建 team/agent ...
        
        # 检查点 2：创建完成后
        if self.task_state_manager.is_cancelled(self.task_id):
            logger.info(f"Task {self.task_id} cancelled after team creation")
            return TaskStatus.COMPLETED
        
        # ... 执行任务 ...
        
        return result
    except Exception as e:
        return self._handle_execution_error(e, "async execution")
```

在 streaming 循环中检查：

```python
async def _run_agent_streaming_async(self, prompt: str) -> TaskStatus:
    try:
        result_content = ""
        
        async for run_response_event in self.single_agent.arun(...):
            # 检查取消状态
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled during streaming")
                break
            
            result_content = await self._handle_agent_streaming_event(
                run_response_event, result_content
            )
        
        # 如果被取消，返回 COMPLETED 状态
        if self.task_state_manager.is_cancelled(self.task_id):
            return TaskStatus.COMPLETED
        
        return self._handle_execution_result(result_content, "agent streaming execution")
    except Exception as e:
        return self._handle_execution_error(e, "agent streaming execution")
```

#### 3. 增强 cancel_run() 方法

支持早期阶段的取消：

```python
def cancel_run(self) -> bool:
    """
    取消当前运行的任务
    
    支持任务生命周期各个阶段的取消：
    1. 如果任务还未开始（无 run_id），标记状态为 CANCELLING
    2. 如果任务正在执行（有 run_id），调用 SDK 的 cancel_run()
    3. 清理资源并同步状态
    
    Returns:
        bool: True 表示取消成功，False 表示取消失败
    """
    try:
        # 第1层：标记状态为 CANCELLING
        self.task_state_manager.set_state(self.task_id, TaskState.CANCELLING)
        logger.info(f"Marked task {self.task_id} as CANCELLING")
        
        # 第2层：如果有 run_id，调用 SDK 的 cancel_run()
        cancelled = False
        if self.current_run_id is not None:
            if self.team is not None:
                logger.info(f"Cancelling team run with run_id: {self.current_run_id}")
                cancelled = self.team.cancel_run(self.current_run_id)
            elif self.single_agent is not None:
                logger.info(f"Cancelling agent run with run_id: {self.current_run_id}")
                cancelled = self.single_agent.cancel_run(self.current_run_id)
            
            if cancelled:
                logger.info(f"Successfully cancelled run_id: {self.current_run_id}")
                self.current_run_id = None
            else:
                logger.warning(f"Failed to cancel run_id: {self.current_run_id}")
        else:
            # 任务还未开始执行，没有 run_id
            # 但状态已标记为 CANCELLING，执行循环会检查并退出
            logger.info(f"Task {self.task_id} has no run_id yet, will be cancelled at next checkpoint")
            cancelled = True  # 认为取消成功
        
        # 第3层：标记状态为 CANCELLED
        if cancelled:
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            
            # 第4层：报告进度
            self.report_progress(
                100,
                TaskStatus.COMPLETED.value,
                "${{tasks.cancel_task}}",
                result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict(),
            )
        
        return cancelled
        
    except Exception as e:
        logger.exception(f"Error cancelling task {self.task_id}: {str(e)}")
        return False
```

#### 4. 集成 ResourceManager（可选）

如果需要管理资源清理：

```python
from executor.tasks.resource_manager import ResourceManager

def __init__(self, task_data: Dict[str, Any]):
    # ... 现有代码 ...
    self.resource_manager = ResourceManager()

async def _async_execute(self) -> TaskStatus:
    try:
        # 注册资源
        if self.team:
            self.resource_manager.register_resource(
                self.task_id, 
                "team", 
                self.team
            )
        
        # ... 执行任务 ...
        
    finally:
        # 清理资源
        await self.resource_manager.cleanup_task_resources(self.task_id)
```

## 实施步骤

### 阶段 1：基础改进（必需）

1. ✅ 在 `AgnoAgent.__init__()` 中初始化 TaskStateManager
2. ✅ 在 `_async_execute()` 中添加取消检查点
3. ✅ 在 streaming 循环中添加取消检查
4. ✅ 增强 `cancel_run()` 方法支持早期取消

### 阶段 2：资源管理（可选）

5. ⬜ 集成 ResourceManager 管理资源清理
6. ⬜ 在 `cleanup()` 方法中清理所有资源

### 阶段 3：测试验证

7. ⬜ 测试初始化阶段的取消
8. ⬜ 测试预执行阶段的取消
9. ⬜ 测试创建 Agent 阶段的取消
10. ⬜ 测试执行阶段的取消
11. ⬜ 测试 MCP 初始化失败时的取消

## 测试场景

### 场景 1：初始化阶段取消
```
用户操作：创建任务 → 立即点击取消
预期结果：任务成功取消，状态为 COMPLETED
```

### 场景 2：MCP 初始化阶段取消
```
用户操作：创建任务 → MCP 初始化中 → 点击取消
预期结果：任务成功取消，MCP 初始化被中断
```

### 场景 3：执行阶段取消
```
用户操作：创建任务 → 任务执行中 → 点击取消
预期结果：SDK 的 cancel_run() 被调用，任务成功取消
```

## 预期效果

### 改进前
```
❌ 任务未开始时点击取消 → 报错 "No run_id available"
❌ 返回 400 Bad Request
❌ 任务继续执行
```

### 改进后
```
✅ 任务未开始时点击取消 → 标记状态为 CANCELLING
✅ 执行循环检查状态 → 主动退出
✅ 返回 200 OK，任务状态为 COMPLETED
✅ 任务成功取消
```

## 向后兼容性

- ✅ 所有改进都是增量式的，不影响现有功能
- ✅ 如果 TaskStateManager 不可用，仍然可以使用原有的 cancel_run() 逻辑
- ✅ 保持与 ClaudeCodeAgent 的一致性

## 注意事项

1. **状态同步**：确保取消状态及时同步到后端
2. **资源清理**：确保取消时正确清理所有资源
3. **用户体验**：取消操作应该快速响应，不应该等待超时
4. **错误处理**：取消失败时应该有明确的错误信息

## 相关文件

- `executor/agents/agno/agno_agent.py` - AgnoAgent 实现
- `executor/tasks/task_state_manager.py` - 任务状态管理器
- `executor/tasks/resource_manager.py` - 资源管理器
- `executor/services/agent_service.py` - Agent 服务
- `docs/zh/task-cancellation-improvement.md` - 总体取消机制改进文档