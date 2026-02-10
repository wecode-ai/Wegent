# 老代码清理迁移计划

> 基于 `task_dispatch_refactor_v8.md` 重构计划，清理遗留的老代码

---

## 1. 问题分析

### 1.1 当前状态

新架构已经实现：
- `TaskExecutionRequest` - 统一的执行请求格式
- `ExecutionDispatcher` - 统一的任务分发器
- `TaskRequestBuilder` - 请求构建器
- `trigger_ai_response_unified` - 统一的 AI 触发入口

但以下老代码仍在使用：
- `ChatConfigBuilder` - 被 OpenAPI 使用
- `HTTPAdapter` + `ChatRequest` - 被 OpenAPI 和 BackgroundChatExecutor 使用
- `should_use_direct_chat` - 被 public_teams 过滤使用
- `route_task_to_device` - 被 IM Channel 使用

### 1.2 核心问题

`ExecutionDispatcher` 是异步的（通过 WebSocket 事件返回结果），但 OpenAPI 和 BackgroundChatExecutor 需要同步等待响应。

---

## 2. 迁移策略

### 2.1 扩展 ExecutionDispatcher

在 `ExecutionDispatcher` 中添加同步 SSE 调用方法，支持：
1. 流式返回（用于 OpenAPI streaming）
2. 同步等待完整响应（用于 BackgroundChatExecutor 和 OpenAPI sync）

```python
# backend/app/services/execution/dispatcher.py

async def dispatch_sse_stream(
    self,
    request: TaskExecutionRequest,
) -> AsyncIterator[ExecutionEvent]:
    """Dispatch task via SSE and yield events.
    
    For OpenAPI streaming responses.
    """
    ...

async def dispatch_sse_sync(
    self,
    request: TaskExecutionRequest,
) -> str:
    """Dispatch task via SSE and wait for complete response.
    
    For BackgroundChatExecutor and OpenAPI sync responses.
    """
    ...
```

### 2.2 迁移 OpenAPI

1. 修改 `chat_session.py`：
   - 移除 `ChatConfigBuilder` 依赖
   - 使用 `TaskRequestBuilder` 构建请求

2. 修改 `chat_response.py`：
   - 移除 `HTTPAdapter` + `ChatRequest` 依赖
   - 使用 `ExecutionDispatcher.dispatch_sse_stream/sync`

### 2.3 迁移 BackgroundChatExecutor

- 移除 `HTTPAdapter` + `ChatRequest` 依赖
- 使用 `ExecutionDispatcher.dispatch_sse_sync`

### 2.4 清理其他老代码

1. `should_use_direct_chat` - 在新架构中不再需要，所有 Team 都通过 `ExecutionDispatcher` 路由
2. `route_task_to_device` - 已经使用 `ExecutionDispatcher`，可以简化

---

## 3. 实施步骤

### Phase 1: 扩展 ExecutionDispatcher

```
backend/app/services/execution/dispatcher.py
  - 添加 dispatch_sse_stream() 方法
  - 添加 dispatch_sse_sync() 方法
```

### Phase 2: 迁移 OpenAPI

```
backend/app/services/openapi/chat_session.py
  - 移除 ChatConfigBuilder 导入
  - 使用 TaskRequestBuilder

backend/app/services/openapi/chat_response.py
  - 移除 HTTPAdapter, ChatRequest 导入
  - 使用 ExecutionDispatcher
```

### Phase 3: 迁移 BackgroundChatExecutor

```
backend/app/services/background_chat_executor.py
  - 移除 HTTPAdapter, ChatRequest 导入
  - 使用 ExecutionDispatcher.dispatch_sse_sync()
```

### Phase 4: 清理老代码

```
删除文件:
  - backend/app/services/chat/config/chat_config.py
  - backend/app/services/chat/adapters/interface.py
  - backend/app/services/chat/adapters/http.py
  - backend/app/services/chat/adapters/proxy.py

清理函数:
  - backend/app/services/chat/config/shell_checker.py: should_use_direct_chat
  - backend/app/api/endpoints/admin/public_teams.py: 移除 should_use_direct_chat 过滤
```

### Phase 5: 更新测试

```
backend/tests/services/flow/test_create_chat_task.py
backend/tests/api/test_openapi_responses.py
backend/tests/services/chat/test_adapters.py
```

---

## 4. 详细设计

### 4.1 ExecutionDispatcher 扩展

```python
# backend/app/services/execution/dispatcher.py

from typing import AsyncIterator

class ExecutionDispatcher:
    
    async def dispatch_sse_stream(
        self,
        request: TaskExecutionRequest,
    ) -> AsyncIterator[ExecutionEvent]:
        """Dispatch task via SSE and yield events.
        
        Used for OpenAPI streaming responses.
        
        Args:
            request: Task execution request
            
        Yields:
            ExecutionEvent for each SSE event
        """
        target = self.router.route(request, device_id=None)
        
        if target.mode != CommunicationMode.SSE:
            raise ValueError(f"dispatch_sse_stream only supports SSE mode, got {target.mode}")
        
        url = f"{target.url}{target.endpoint}"
        
        async with self.http_client.stream(
            "POST",
            url,
            json=request.to_dict(),
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        continue
                    try:
                        data = json.loads(data_str)
                        yield self._parse_sse_event(request, data)
                    except json.JSONDecodeError:
                        pass
    
    async def dispatch_sse_sync(
        self,
        request: TaskExecutionRequest,
    ) -> tuple[str, ExecutionEvent]:
        """Dispatch task via SSE and wait for complete response.
        
        Used for BackgroundChatExecutor and OpenAPI sync responses.
        
        Args:
            request: Task execution request
            
        Returns:
            Tuple of (accumulated_content, final_event)
        """
        accumulated_content = ""
        final_event = None
        
        async for event in self.dispatch_sse_stream(request):
            if event.type == EventType.CHUNK:
                accumulated_content += event.content or ""
            elif event.type == EventType.DONE:
                final_event = event
            elif event.type == EventType.ERROR:
                raise Exception(event.error or "Unknown error")
        
        return accumulated_content, final_event
```

### 4.2 OpenAPI chat_session.py 迁移

```python
# backend/app/services/openapi/chat_session.py

# 移除:
# from app.services.chat.config import ChatConfigBuilder

# 添加:
from app.services.execution import TaskRequestBuilder

def setup_chat_session(...) -> ChatSessionSetup:
    # 使用 TaskRequestBuilder 替代 ChatConfigBuilder
    builder = TaskRequestBuilder(db)
    
    # 构建请求获取配置
    # ... 实现细节
```

### 4.3 OpenAPI chat_response.py 迁移

```python
# backend/app/services/openapi/chat_response.py

# 移除:
# from app.services.chat.adapters.http import HTTPAdapter
# from app.services.chat.adapters.interface import ChatEventType, ChatRequest

# 添加:
from app.services.execution import execution_dispatcher
from shared.models import EventType, TaskExecutionRequest

async def _create_streaming_response_http(...):
    # 使用 execution_dispatcher.dispatch_sse_stream()
    async for event in execution_dispatcher.dispatch_sse_stream(request):
        if event.type == EventType.CHUNK:
            yield event.content
        elif event.type == EventType.ERROR:
            raise Exception(event.error)

async def _create_sync_response_http(...):
    # 使用 execution_dispatcher.dispatch_sse_sync()
    content, _ = await execution_dispatcher.dispatch_sse_sync(request)
    return content
```

---

## 5. 风险评估

### 5.1 兼容性风险

- Chat Shell 接口格式：`TaskExecutionRequest` 需要与 Chat Shell 的 `ChatRequest` 兼容
- 事件类型映射：`EventType` 需要与 `ChatEventType` 对应

### 5.2 缓解措施

1. Chat Shell 已经支持 `TaskExecutionRequest` 格式（通过 `/v1/execute` 接口）
2. 事件类型已经在 `shared/models/execution_events.py` 中定义，与 Chat Shell 兼容

---

## 6. 测试计划

1. 单元测试：
   - `ExecutionDispatcher.dispatch_sse_stream()` 测试
   - `ExecutionDispatcher.dispatch_sse_sync()` 测试

2. 集成测试：
   - OpenAPI streaming 响应测试
   - OpenAPI sync 响应测试
   - BackgroundChatExecutor 测试

3. E2E 测试：
   - 完整的 OpenAPI 调用流程测试
