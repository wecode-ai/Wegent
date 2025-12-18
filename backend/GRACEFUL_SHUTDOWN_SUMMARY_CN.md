# Backend优雅停机实现总结

## 问题回答：这个分支的backend优雅停机是怎么实现的？

### 简短回答

Backend通过 **ShutdownManager** 实现优雅停机，核心机制是：
1. 收到SIGTERM信号后标记停机状态
2. 拒绝新请求（返回503），但允许现有流式请求继续
3. 最多等待600秒让活跃的流式请求完成
4. 超时后强制取消剩余流，然后清理资源退出

### 实现架构

```
核心组件：
├── ShutdownManager (app/core/shutdown.py)         # 停机状态管理器
├── FastAPI Lifespan (app/main.py)                 # 应用生命周期处理
├── Shutdown Middleware (app/main.py)              # 拒绝新请求的中间件
├── Health Endpoints (app/api/endpoints/health.py) # K8s探测集成
└── Stream Manager (app/services/chat/stream_manager.py) # 流式请求追踪
```

### 详细流程

#### 1. 正常运行时
```python
# 流式请求开始时注册
await shutdown_manager.register_stream(subtask_id)
# 活跃流计数 +1

# 流式请求结束时注销
await shutdown_manager.unregister_stream(subtask_id)
# 活跃流计数 -1
```

#### 2. 收到停机信号 (SIGTERM)

**Step 1: 启动停机流程**
```python
# FastAPI lifespan shutdown 触发
await shutdown_manager.initiate_shutdown()

# 效果:
# - _shutting_down = True
# - 记录停机开始时间
# - 通过Redis通知其他Worker进程
```

**Step 2: 阻止新请求**
```python
# Middleware自动拒绝新请求
@app.middleware("http")
async def shutdown_middleware(request: Request, call_next):
    if shutdown_manager.is_shutting_down:
        return JSONResponse(status_code=503, content={
            "detail": "Service is shutting down",
            "retry_after": 5,
            "active_streams": shutdown_manager.get_active_stream_count()
        })
```

**Step 3: K8s停止发送流量**
```python
# /api/ready端点返回503
@router.get("/ready")
def readiness_check(response: Response):
    if shutdown_manager.is_shutting_down:
        response.status_code = 503
        return {"status": "shutting_down"}
    # K8s检测到503后，不再向这个Pod发送新请求
```

**Step 4: 等待活跃流完成**
```python
# 等待所有流式请求自然完成（最多600秒）
if shutdown_manager.get_active_stream_count() > 0:
    streams_completed = await shutdown_manager.wait_for_streams(
        timeout=settings.GRACEFUL_SHUTDOWN_TIMEOUT  # 默认600秒
    )
```

**流式任务如何优雅退出？**
```python
# 在流式处理循环中检查停机状态
async def _consumer_loop(state, stream_generator, ...):
    async for chunk in stream_generator:
        # 检查是否需要停止
        if shutdown_manager.is_shutting_down:
            state.cancelled = True
            logger.info("Stopping due to server shutdown")
            break  # 优雅退出循环
        
        # 处理chunk...
    
    finally:
        # 清理：从停机管理器注销
        await shutdown_manager.unregister_stream(state.subtask_id)
```

**Step 5: 超时处理**
```python
if not streams_completed:
    # 600秒后仍有流未完成，强制取消
    cancelled = await shutdown_manager.cancel_all_streams()
    logger.warning(f"Force cancelled {cancelled} streams")
    
    # cancel_all_streams 内部实现
    for subtask_id in active_streams:
        await session_manager.cancel_stream(subtask_id)
        # 向每个流发送取消信号
```

**Step 6: 清理资源**
```python
# 关闭HTTP客户端
await close_http_client()

# 停止后台任务
stop_background_jobs(app)

# 关闭遥测服务
shutdown_telemetry()

# 进程退出
```

### 关键设计点

#### 1. 为什么要追踪流式请求？

因为Backend主要处理LLM流式响应，这些请求可能运行5-10分钟：
```python
# 流式响应示例
async def stream_chat_response(subtask_id):
    # 1. 注册到停机管理器
    if not await shutdown_manager.register_stream(subtask_id):
        return  # 停机中，拒绝新流
    
    try:
        async for chunk in llm_provider.stream():
            # 2. 持续检查停机状态
            if shutdown_manager.is_shutting_down:
                break
            
            yield chunk
    finally:
        # 3. 完成时注销
        await shutdown_manager.unregister_stream(subtask_id)
```

#### 2. 为什么要600秒超时？

```python
GRACEFUL_SHUTDOWN_TIMEOUT: int = 600  # 10分钟
```

**原因**:
- 复杂的代码生成任务可能需要5-10分钟
- 给足够时间让用户的任务正常完成
- 避免超时过短导致任务频繁被中断

#### 3. 健康检查端点的不同作用

| 端点 | K8s探测 | 正常时 | 停机时 | 作用 |
|------|---------|--------|--------|------|
| `/api/health` | Liveness | 200 | 200 | 判断Pod是否活着（停机时仍活着）|
| `/api/ready` | Readiness | 200 | **503** | 判断是否接收流量（停机时返回503，K8s停止发流量）|
| `/api/startup` | Startup | 200 | 200 | 判断是否启动完成 |

**关键**：`/api/ready`返回503是触发K8s停止发送流量的信号，但Pod不会被杀死。

#### 4. 与Kubernetes的配合

```yaml
spec:
  containers:
  - name: backend
    # K8s会持续调用这个端点
    readinessProbe:
      httpGet:
        path: /api/ready  # 停机时返回503
        port: 8000
      periodSeconds: 5
    
    # 给足够时间让应用优雅停机
    terminationGracePeriodSeconds: 660  # 必须 > GRACEFUL_SHUTDOWN_TIMEOUT
```

**工作流程**:
1. K8s发送SIGTERM给Pod
2. Backend: `shutdown_manager.initiate_shutdown()`
3. `/api/ready`开始返回503
4. K8s检测到503，将Pod从Service负载均衡中移除
5. 新请求不再路由到这个Pod
6. 现有请求继续处理（最多600秒）
7. 完成后Pod退出
8. 如果超过660秒，K8s发送SIGKILL强制杀死

### 配置选项

```bash
# .env 或环境变量
GRACEFUL_SHUTDOWN_TIMEOUT=600        # 停机超时（秒）
SHUTDOWN_REJECT_NEW_REQUESTS=true    # 是否拒绝新请求
```

### 监控和日志

**关键日志**:
```
Graceful shutdown initiated...
✓ Shutdown state set. Active streams: 3
Waiting for 3 active streams to complete (timeout: 600s)...
All streams completed within timeout
✓ Chat service HTTP client closed
✓ Background jobs stopped
✓ OpenTelemetry shutdown completed
Application shutdown completed. Duration: 127.45s
```

**监控指标**:
```python
# 活跃流数量
shutdown_manager.get_active_stream_count()

# 停机持续时间
shutdown_manager.shutdown_duration

# 是否正在停机
shutdown_manager.is_shutting_down
```

### 测试验证

```bash
cd backend
pytest tests/core/test_shutdown.py -v
```

测试覆盖:
- ✅ 停机状态管理
- ✅ 流注册和注销
- ✅ 停机时拒绝新流
- ✅ 等待流完成
- ✅ 超时强制取消
- ✅ 完整流程集成

### 实际场景示例

#### 场景1：滚动更新，无活跃流
```
K8s: 创建新Pod → 发送SIGTERM给旧Pod
Backend: initiate_shutdown() → 检查活跃流 = 0 → 立即退出
时长: < 5秒
```

#### 场景2：滚动更新，有3个活跃流
```
K8s: 创建新Pod → 新Pod就绪 → 发送SIGTERM给旧Pod
Backend: 
  - initiate_shutdown()
  - /api/ready返回503 → K8s停止发送新请求到旧Pod
  - 3个流继续处理，逐个完成
  - 第1个流完成: 活跃流 = 2
  - 第2个流完成: 活跃流 = 1  
  - 第3个流完成: 活跃流 = 0 → 触发shutdown_event
  - 清理资源 → 退出
时长: ~实际流完成时间（如180秒）
```

#### 场景3：超时场景
```
Backend:
  - initiate_shutdown()
  - 等待600秒
  - 仍有2个流未完成
  - cancel_all_streams() 强制取消
  - 清理资源 → 退出
时长: ~600秒（超时时间）
```

### 总结

Backend优雅停机的核心是**保护长时间运行的流式请求**：

1. **状态管理**: ShutdownManager追踪停机状态和活跃流
2. **拒绝新请求**: Middleware + K8s readiness probe 阻止新流量
3. **保护现有请求**: 等待最多600秒让流式请求完成
4. **强制清理**: 超时后安全取消并退出
5. **K8s集成**: 通过探测端点完美配合K8s生命周期

这样在滚动更新时，用户的长时间任务不会被意外中断，实现了真正的零停机更新。

---

## 相关文档

- **详细分析**: `/GRACEFUL_SHUTDOWN_ANALYSIS.md` (554行，包含完整实现细节、K8s配置、最佳实践)
- **快速参考**: `backend/GRACEFUL_SHUTDOWN_README.md` (快速查询指南)
- **核心代码**: `backend/app/core/shutdown.py` (ShutdownManager实现)
- **测试代码**: `backend/tests/core/test_shutdown.py` (功能测试)
