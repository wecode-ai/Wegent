# Backend优雅停机实现分析 (Graceful Shutdown Implementation Analysis)

## 概述 (Overview)

本文档详细分析了Wegent Backend模块的优雅停机(graceful shutdown)实现机制。该实现专为Kubernetes环境设计，确保在服务停止时不会中断正在进行的长时间流式请求。

This document provides a comprehensive analysis of the graceful shutdown implementation in the Wegent Backend module. The implementation is specifically designed for Kubernetes environments to ensure that long-running streaming requests are not interrupted during service termination.

## 核心组件 (Core Components)

### 1. ShutdownManager (`app/core/shutdown.py`)

优雅停机的核心管理器，负责协调整个停机过程。

The core manager for graceful shutdown, responsible for coordinating the entire shutdown process.

**主要功能 (Key Features):**

- **状态追踪 (State Tracking)**: 维护全局停机状态标志
- **流式请求监控 (Stream Monitoring)**: 跟踪所有活跃的流式请求（通过subtask_id）
- **跨Worker通信 (Cross-Worker Communication)**: 通过Redis通知其他Worker进程
- **超时处理 (Timeout Handling)**: 支持超时后强制取消流式请求

**核心方法 (Core Methods):**

```python
class ShutdownManager:
    async def initiate_shutdown(self) -> None:
        """
        启动优雅停机流程:
        1. 设置停机标志 (_shutting_down = True)
        2. 记录停机开始时间
        3. 通过Redis通知其他Worker
        """
    
    async def register_stream(self, subtask_id: int) -> bool:
        """
        注册新的流式请求
        - 如果正在停机，拒绝注册并返回False
        - 否则添加到活跃流列表并返回True
        """
    
    async def unregister_stream(self, subtask_id: int) -> None:
        """
        注销流式请求（完成或取消时调用）
        - 从活跃流列表中移除
        - 如果是最后一个流，触发shutdown_event
        """
    
    async def wait_for_streams(self, timeout: float) -> bool:
        """
        等待所有活跃流完成
        - 返回True: 所有流在超时前完成
        - 返回False: 超时仍有流未完成
        """
    
    async def cancel_all_streams(self) -> int:
        """
        强制取消所有活跃流（超时后调用）
        - 调用session_manager取消每个流
        - 返回成功取消的流数量
        """
```

**状态属性 (State Properties):**

- `is_shutting_down: bool` - 是否正在停机
- `shutdown_duration: float` - 停机持续时间（秒）
- `get_active_stream_count(): int` - 活跃流数量

### 2. Application Lifespan (`app/main.py`)

FastAPI的生命周期管理，处理启动和停机事件。

FastAPI's lifespan management, handling startup and shutdown events.

**停机流程 (Shutdown Process):**

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... startup logic ...
    
    yield  # Application is running
    
    # ==================== SHUTDOWN ====================
    logger.info("Graceful shutdown initiated...")
    
    # Step 1: 标记为停机状态，拒绝新请求
    # Mark as shutting down, reject new requests
    await shutdown_manager.initiate_shutdown()
    
    # Step 2: 等待活跃流完成（最多GRACEFUL_SHUTDOWN_TIMEOUT秒）
    # Wait for active streams to complete (max GRACEFUL_SHUTDOWN_TIMEOUT seconds)
    if shutdown_manager.get_active_stream_count() > 0:
        streams_completed = await shutdown_manager.wait_for_streams(
            timeout=settings.GRACEFUL_SHUTDOWN_TIMEOUT
        )
        
        if not streams_completed:
            # 超时：强制取消剩余流
            # Timeout: Force cancel remaining streams
            cancelled = await shutdown_manager.cancel_all_streams()
            logger.info(f"Cancelled {cancelled} streams")
    
    # Step 3: 关闭HTTP客户端
    # Close HTTP client
    await close_http_client()
    
    # Step 4: 停止后台任务
    # Stop background jobs
    stop_background_jobs(app)
    
    # Step 5: 关闭OpenTelemetry
    # Shutdown OpenTelemetry
    shutdown_telemetry()
    
    logger.info(f"Shutdown completed. Duration: {shutdown_manager.shutdown_duration}s")
```

### 3. Shutdown Middleware (`app/main.py`)

HTTP中间件，在停机期间拒绝新请求。

HTTP middleware that rejects new requests during shutdown.

**工作原理 (How it Works):**

```python
@app.middleware("http")
async def shutdown_middleware(request: Request, call_next):
    """
    停机中间件逻辑:
    1. 始终允许健康检查端点 (/health, /ready, /startup)
    2. 如果正在停机且SHUTDOWN_REJECT_NEW_REQUESTS=True:
       - 返回503 Service Unavailable
       - 包含Retry-After头和活跃流数量
    3. 否则正常处理请求
    """
    # Always allow health check endpoints
    allowed_paths = {"/", "/api/health", "/api/ready", "/api/startup"}
    if request.url.path in allowed_paths:
        return await call_next(request)
    
    # Reject new requests during shutdown
    if shutdown_manager.is_shutting_down and settings.SHUTDOWN_REJECT_NEW_REQUESTS:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Service is shutting down",
                "retry_after": 5,
                "active_streams": shutdown_manager.get_active_stream_count(),
            },
            headers={"Retry-After": "5"}
        )
    
    return await call_next(request)
```

### 4. Health Check Endpoints (`app/api/endpoints/health.py`)

Kubernetes探测端点，与停机流程集成。

Kubernetes probe endpoints integrated with shutdown process.

**端点行为 (Endpoint Behaviors):**

| Endpoint | Purpose | Shutdown Behavior |
|----------|---------|-------------------|
| `/api/health` | Liveness Probe | 返回200 - 应用仍存活 (Returns 200 - app still alive) |
| `/api/ready` | Readiness Probe | 返回503 - 停止接收新流量 (Returns 503 - stop receiving new traffic) |
| `/api/startup` | Startup Probe | 返回200 - 启动已完成 (Returns 200 - startup complete) |

**Readiness检查实现 (Readiness Check Implementation):**

```python
@router.get("/ready")
def readiness_check(response: Response, db: Session = Depends(get_db)):
    """
    就绪探测 - 在停机时返回503，通知K8s停止发送流量
    Readiness probe - Returns 503 during shutdown to stop traffic
    """
    if shutdown_manager.is_shutting_down:
        response.status_code = 503
        return {
            "status": "shutting_down",
            "message": "Service is shutting down, not accepting new traffic",
            "active_streams": shutdown_manager.get_active_stream_count(),
            "shutdown_duration": shutdown_manager.shutdown_duration,
        }
    
    # Normal readiness check logic...
```

### 5. Stream Manager Integration (`app/services/chat/stream_manager.py`)

流式请求管理器与停机系统的集成。

Stream manager integration with the shutdown system.

**注册流程 (Registration Flow):**

```python
async def create_consumer_task(self, state: StreamState, ...) -> asyncio.Task | None:
    """
    创建流式任务前先向shutdown_manager注册
    Register with shutdown_manager before creating stream task
    """
    # 尝试注册流 - 停机时会被拒绝
    # Try to register stream - rejected during shutdown
    if not await shutdown_manager.register_stream(state.subtask_id):
        logger.warning("[STREAM] Rejecting new stream during shutdown")
        return None
    
    task = asyncio.create_task(self._consumer_loop(...))
    return task
```

**取消检测 (Cancellation Detection):**

```python
async def _consumer_loop(self, state: StreamState, ...) -> None:
    """
    流式循环中持续检查停机状态
    Continuously check shutdown state in stream loop
    """
    try:
        async for chunk in stream_generator:
            # 检查是否需要停止：用户取消、会话取消或服务器停机
            # Check if should stop: user cancel, session cancel, or server shutdown
            if (cancel_event.is_set() 
                or await session_manager.is_cancelled(state.subtask_id)
                or shutdown_manager.is_shutting_down):
                
                state.cancelled = True
                if shutdown_manager.is_shutting_down:
                    logger.info("[STREAM] stopping due to server shutdown")
                break
            
            # Process chunk...
    
    finally:
        # 清理：从两个管理器中注销
        # Cleanup: Unregister from both managers
        await session_manager.unregister_stream(state.subtask_id)
        await shutdown_manager.unregister_stream(state.subtask_id)
```

## 配置选项 (Configuration Options)

在 `app/core/config.py` 中定义:

Defined in `app/core/config.py`:

```python
# 优雅停机超时时间（秒）
# Graceful shutdown timeout (seconds)
GRACEFUL_SHUTDOWN_TIMEOUT: int = 600  # Default: 10 minutes

# 是否在停机时拒绝新请求
# Whether to reject new requests during shutdown
SHUTDOWN_REJECT_NEW_REQUESTS: bool = True  # Default: True
```

**环境变量 (Environment Variables):**

- `GRACEFUL_SHUTDOWN_TIMEOUT` - 覆盖停机超时时间
- `SHUTDOWN_REJECT_NEW_REQUESTS` - 设置为`false`允许停机时仍接受新请求

## 完整停机流程图 (Complete Shutdown Flow)

```
1. Kubernetes发送SIGTERM信号
   Kubernetes sends SIGTERM signal
   ↓
2. FastAPI lifespan shutdown开始
   FastAPI lifespan shutdown starts
   ↓
3. shutdown_manager.initiate_shutdown()
   - 设置_shutting_down = True
   - 记录开始时间
   - 通过Redis通知其他Worker
   ↓
4. Middleware开始拒绝新请求 (503)
   Middleware starts rejecting new requests (503)
   ↓
5. /api/ready返回503
   /api/ready returns 503
   - K8s停止向此Pod发送流量
   - K8s stops sending traffic to this Pod
   ↓
6. 等待活跃流完成 (最多GRACEFUL_SHUTDOWN_TIMEOUT秒)
   Wait for active streams to complete (max GRACEFUL_SHUTDOWN_TIMEOUT)
   - 流式任务检测shutdown状态并优雅退出
   - Stream tasks detect shutdown and exit gracefully
   - 完成时自动unregister_stream
   - Auto unregister_stream on completion
   ↓
7. 超时处理 (如果需要)
   Timeout handling (if needed)
   - cancel_all_streams()
   - 通过session_manager取消每个流
   - Cancel each stream via session_manager
   ↓
8. 关闭资源
   Close resources
   - HTTP客户端
   - 后台任务
   - OpenTelemetry
   ↓
9. 进程退出
   Process exits
```

## Kubernetes集成 (Kubernetes Integration)

### 推荐Deployment配置 (Recommended Deployment Configuration)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wegent-backend
spec:
  template:
    spec:
      containers:
      - name: backend
        image: wegent-backend:latest
        env:
        - name: GRACEFUL_SHUTDOWN_TIMEOUT
          value: "600"  # 10 minutes
        - name: SHUTDOWN_REJECT_NEW_REQUESTS
          value: "true"
        
        # 存活探测：应用是否存活
        # Liveness probe: Is the app alive?
        livenessProbe:
          httpGet:
            path: /api/health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        
        # 就绪探测：应用是否准备接收流量
        # Readiness probe: Is the app ready for traffic?
        readinessProbe:
          httpGet:
            path: /api/ready
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
        
        # 启动探测：应用是否已启动
        # Startup probe: Has the app started?
        startupProbe:
          httpGet:
            path: /api/startup
            port: 8000
          initialDelaySeconds: 0
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 30  # 最多等待150秒启动
        
        # 优雅停机配置
        # Graceful shutdown configuration
        lifecycle:
          preStop:
            exec:
              # 给应用时间清理（可选）
              # Give the app time to cleanup (optional)
              command: ["/bin/sh", "-c", "sleep 5"]
        
        # 给Pod足够时间完成停机
        # Give Pod enough time to complete shutdown
        terminationGracePeriodSeconds: 660  # GRACEFUL_SHUTDOWN_TIMEOUT + 60s buffer
```

### 工作原理 (How It Works with K8s)

1. **滚动更新时 (During Rolling Update):**
   ```
   K8s创建新Pod → 启动就绪 → 开始接收流量
   K8s creates new Pod → Becomes ready → Starts receiving traffic
   ↓
   K8s向旧Pod发送SIGTERM
   K8s sends SIGTERM to old Pod
   ↓
   旧Pod标记为停机 → /api/ready返回503
   Old Pod marks as shutting down → /api/ready returns 503
   ↓
   K8s停止向旧Pod发送新请求（但不杀死它）
   K8s stops sending new requests to old Pod (but doesn't kill it)
   ↓
   旧Pod完成现有流式请求
   Old Pod completes existing streaming requests
   ↓
   旧Pod优雅退出
   Old Pod exits gracefully
   ```

2. **探测器作用 (Probe Functions):**
   - **livenessProbe**: 检查Pod是否需要重启（健康检查）
   - **readinessProbe**: 控制Pod是否接收流量（停机时返回503）
   - **startupProbe**: 保护慢启动应用（避免过早liveness失败）

## 关键设计决策 (Key Design Decisions)

### 1. 为什么选择600秒超时？ (Why 600s Timeout?)

```python
GRACEFUL_SHUTDOWN_TIMEOUT: int = 600  # 10 minutes
```

**原因 (Rationale):**
- LLM流式请求可能运行很长时间（特别是复杂任务）
- 10分钟是合理的上限，平衡用户体验和资源占用
- Kubernetes的terminationGracePeriodSeconds应该略大于此值

### 2. 为什么分离livenessProbe和readinessProbe？

**设计原则 (Design Principle):**
- **Liveness**: "应用是否活着？" - 停机时仍返回200（应用还在运行）
- **Readiness**: "应用是否准备好服务？" - 停机时返回503（不再接受新流量）

这样K8s可以：
- 通过readiness停止发送新流量
- 但不会因为liveness失败而强制杀死Pod
- 给予应用完整的terminationGracePeriodSeconds来优雅退出

### 3. 为什么使用Redis通知？

```python
async def _notify_shutdown_via_redis(self) -> None:
    """通过Redis通知其他Worker"""
    await cache_manager.set(
        SHUTDOWN_STATE_KEY,
        {"shutting_down": True, "timestamp": time.time()},
        expire=SHUTDOWN_STATE_TTL,
    )
```

**目的 (Purpose):**
- 在多Worker部署中（如gunicorn -w 4），每个Worker是独立进程
- SIGTERM可能只发送到主进程
- Redis确保所有Worker都知道正在停机
- 避免某些Worker继续接受新请求

### 4. 为什么允许健康检查端点？

```python
allowed_paths = {"/", "/api/health", "/api/ready", "/api/startup"}
if request.url.path in allowed_paths:
    return await call_next(request)  # 不拒绝
```

**原因 (Rationale):**
- K8s需要持续探测Pod状态
- 阻止健康检查会导致K8s误判Pod已死亡
- 这些端点轻量级，不会干扰停机流程

## 测试覆盖 (Test Coverage)

详见 `tests/core/test_shutdown.py`:

See `tests/core/test_shutdown.py` for details:

**测试场景 (Test Scenarios):**
- ✅ 初始状态验证
- ✅ 停机启动和幂等性
- ✅ 流注册和注销
- ✅ 停机时拒绝新流
- ✅ 等待流完成（成功和超时）
- ✅ 强制取消所有流
- ✅ 完整停机流程集成测试

## 最佳实践 (Best Practices)

### 1. 生产环境配置 (Production Configuration)

```python
# .env
GRACEFUL_SHUTDOWN_TIMEOUT=600  # 根据实际任务长度调整
SHUTDOWN_REJECT_NEW_REQUESTS=true  # 生产环境建议启用
```

### 2. 监控指标 (Monitoring Metrics)

建议监控以下指标:
- `shutdown_manager.get_active_stream_count()` - 活跃流数量
- `shutdown_manager.shutdown_duration` - 停机持续时间
- `/api/ready`状态 - 就绪状态

### 3. 日志关键字 (Log Keywords)

搜索以下日志查看停机状态:
```
"Graceful shutdown initiated"
"Active streams: N"
"Waiting for N active streams to complete"
"All streams completed"
"Timeout reached. Cancelling N remaining streams"
"Application shutdown completed"
```

## 已知限制 (Known Limitations)

1. **Redis依赖 (Redis Dependency)**:
   - 跨Worker通知需要Redis
   - Redis不可用时仅影响本Worker，不影响功能

2. **强制终止 (Force Termination)**:
   - 如果Kubernetes的terminationGracePeriodSeconds用尽
   - Pod会被SIGKILL强制杀死
   - 确保terminationGracePeriodSeconds > GRACEFUL_SHUTDOWN_TIMEOUT

3. **并发流取消 (Concurrent Stream Cancellation)**:
   - `cancel_all_streams()`串行取消每个流
   - 大量流时可能较慢，但更可靠

## 相关文件 (Related Files)

```
backend/
├── app/
│   ├── main.py                          # FastAPI应用和停机流程
│   ├── core/
│   │   ├── shutdown.py                  # ShutdownManager核心实现
│   │   └── config.py                    # 停机配置选项
│   ├── api/endpoints/
│   │   └── health.py                    # 健康检查端点
│   └── services/chat/
│       ├── stream_manager.py            # 流管理器集成
│       └── session_manager.py           # 会话管理器
└── tests/core/
    └── test_shutdown.py                 # 停机功能测试
```

## 总结 (Summary)

Wegent Backend的优雅停机实现通过以下机制确保零中断服务更新:

1. **状态管理**: ShutdownManager集中管理停机状态
2. **流追踪**: 监控所有活跃的长时间运行流式请求
3. **拒绝新请求**: 中间件和就绪探测协同阻止新流量
4. **优雅等待**: 给予活跃请求足够时间完成
5. **强制清理**: 超时后安全取消剩余请求
6. **K8s集成**: 完美适配Kubernetes探测和生命周期

这种设计确保即使在高负载滚动更新时，用户的长时间流式任务也不会被意外中断。
