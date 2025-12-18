# Backend Graceful Shutdown - Quick Reference

> For detailed analysis, see [/GRACEFUL_SHUTDOWN_ANALYSIS.md](../GRACEFUL_SHUTDOWN_ANALYSIS.md)

## TL;DR (太长不看版)

Wegent Backend implements a comprehensive graceful shutdown mechanism to ensure **long-running streaming requests are not interrupted** during service updates or shutdowns in Kubernetes environments.

Backend实现了完整的优雅停机机制，确保在Kubernetes环境的服务更新或停止时**不会中断长时间运行的流式请求**。

## Quick Start

### Environment Variables

```bash
# Maximum time to wait for streams to complete (default: 600 seconds = 10 minutes)
GRACEFUL_SHUTDOWN_TIMEOUT=600

# Reject new requests during shutdown (default: true)
SHUTDOWN_REJECT_NEW_REQUESTS=true
```

### Kubernetes Configuration

```yaml
# Recommended K8s Deployment settings
spec:
  template:
    spec:
      containers:
      - name: backend
        # Readiness probe - returns 503 during shutdown
        readinessProbe:
          httpGet:
            path: /api/ready
            port: 8000
          periodSeconds: 5
        
        # Give Pod enough time to complete graceful shutdown
        terminationGracePeriodSeconds: 660  # GRACEFUL_SHUTDOWN_TIMEOUT + 60s buffer
```

## How It Works (工作原理)

### 1. Normal Operation (正常运行)

```
Client Request → Middleware (Allow) → /api/ready returns 200 → Process Request
```

### 2. During Shutdown (停机期间)

```
K8s sends SIGTERM
    ↓
shutdown_manager.initiate_shutdown()
    ↓
Middleware: Reject new requests (503)
    ↓
/api/ready: Return 503 → K8s stops sending traffic
    ↓
Wait for active streams (max 600s)
    ↓
Timeout? → Force cancel remaining streams
    ↓
Close resources (HTTP client, background jobs, telemetry)
    ↓
Process exits gracefully
```

## Key Components (核心组件)

| Component | File | Purpose |
|-----------|------|---------|
| **ShutdownManager** | `app/core/shutdown.py` | Central coordinator for shutdown process |
| **Lifespan Handler** | `app/main.py` | FastAPI lifecycle with shutdown steps |
| **Shutdown Middleware** | `app/main.py` | Rejects new requests during shutdown (503) |
| **Health Endpoints** | `app/api/endpoints/health.py` | K8s probes integration |
| **Stream Manager** | `app/services/chat/stream_manager.py` | Registers/unregisters active streams |

## Health Check Endpoints (健康检查端点)

| Endpoint | K8s Probe | Normal | During Shutdown |
|----------|-----------|--------|-----------------|
| `/api/health` | Liveness | 200 | 200 (still alive) |
| `/api/ready` | Readiness | 200 | 503 (stop traffic) |
| `/api/startup` | Startup | 200 | 200 (startup done) |

## Shutdown Flow in Code (代码中的停机流程)

```python
# 1. Mark as shutting down
await shutdown_manager.initiate_shutdown()
# Result: is_shutting_down = True, middleware starts rejecting new requests

# 2. Wait for active streams
if shutdown_manager.get_active_stream_count() > 0:
    completed = await shutdown_manager.wait_for_streams(timeout=600)
    # Streams check shutdown_manager.is_shutting_down and exit gracefully
    
# 3. Timeout handling
if not completed:
    cancelled = await shutdown_manager.cancel_all_streams()
    # Force cancel remaining streams via session_manager

# 4. Cleanup
await close_http_client()
stop_background_jobs(app)
shutdown_telemetry()

# 5. Exit
```

## Integration with Streaming (与流式请求的集成)

### Stream Registration

```python
# Before starting a stream
if not await shutdown_manager.register_stream(subtask_id):
    # Rejected - server is shutting down
    return None

# Stream task created and tracked
```

### Stream Detection of Shutdown

```python
# Inside stream loop
async for chunk in stream_generator:
    if shutdown_manager.is_shutting_down:
        # Stop gracefully
        break
    
    # Process chunk...

# Always cleanup
await shutdown_manager.unregister_stream(subtask_id)
```

## Testing (测试)

```bash
cd backend
pytest tests/core/test_shutdown.py -v
```

**Test Coverage**:
- ✅ Shutdown initiation and state tracking
- ✅ Stream registration/unregistration
- ✅ Rejecting streams during shutdown
- ✅ Waiting for streams to complete
- ✅ Timeout and force cancellation
- ✅ Complete shutdown flow integration

## Monitoring (监控)

### Key Metrics to Monitor

```python
# Active streaming requests
shutdown_manager.get_active_stream_count()

# Shutdown duration
shutdown_manager.shutdown_duration

# Readiness status
GET /api/ready  # 200 = ready, 503 = shutting down
```

### Log Keywords

Search logs for:
- `"Graceful shutdown initiated"`
- `"Active streams: N"`
- `"Waiting for N active streams to complete"`
- `"All streams completed"`
- `"Timeout reached. Cancelling N remaining streams"`
- `"Application shutdown completed"`

## Common Scenarios (常见场景)

### Scenario 1: Rolling Update with No Active Streams

```
1. K8s creates new Pod
2. New Pod becomes ready
3. K8s sends SIGTERM to old Pod
4. Old Pod: initiate_shutdown() → no active streams → exit immediately
5. Duration: < 5 seconds
```

### Scenario 2: Rolling Update with Long-Running Streams

```
1. K8s creates new Pod
2. New Pod becomes ready, starts receiving traffic
3. K8s sends SIGTERM to old Pod
4. Old Pod: initiate_shutdown()
   - /api/ready returns 503 → K8s stops sending new traffic
   - Middleware rejects new requests
   - Existing streams continue processing
5. Streams complete within 600s → unregister automatically
6. Old Pod exits gracefully
7. Duration: ~actual stream completion time
```

### Scenario 3: Timeout with Stuck Streams

```
1. K8s sends SIGTERM
2. Old Pod: initiate_shutdown()
3. Wait for streams (600s)
4. Timeout: 2 streams still active
5. Force cancel via cancel_all_streams()
6. Give 1s for cancellation to propagate
7. Old Pod exits
8. Duration: ~600s (timeout)
```

## Design Decisions (设计决策)

### Why 600s Default Timeout?

- LLM streaming requests can run for several minutes
- 10 minutes is a reasonable upper bound
- Balances user experience vs resource holding

### Why Separate Liveness and Readiness?

- **Liveness** (健康检查): "Is the app alive?" → Returns 200 during shutdown
  - Prevents K8s from killing the Pod prematurely
- **Readiness** (就绪检查): "Ready for traffic?" → Returns 503 during shutdown
  - Stops new traffic but allows graceful completion

### Why Allow Health Check Endpoints During Shutdown?

```python
allowed_paths = {"/", "/api/health", "/api/ready", "/api/startup"}
```

- K8s needs continuous probe access
- Blocking probes would cause false "Pod dead" detection
- These endpoints are lightweight and don't interfere with shutdown

### Why Use Redis for Cross-Worker Notification?

- In multi-worker deployments (gunicorn -w 4), each worker is a separate process
- SIGTERM might only reach the master process
- Redis ensures all workers know about shutdown
- Graceful degradation: Works without Redis, just affects single worker only

## Troubleshooting (故障排查)

### Problem: Streams Not Completing

**Check**:
1. Stream code checks `shutdown_manager.is_shutting_down`?
2. Stream properly calls `unregister_stream()` in finally block?
3. Timeout value appropriate for your workload?

**Solution**:
```python
# In stream processing code
async def process_stream():
    try:
        async for chunk in generator:
            if shutdown_manager.is_shutting_down:
                break  # Exit gracefully
            # process chunk
    finally:
        await shutdown_manager.unregister_stream(subtask_id)
```

### Problem: Pods Killed Before Streams Complete

**Check**: `terminationGracePeriodSeconds` in K8s deployment

**Solution**:
```yaml
terminationGracePeriodSeconds: 660  # Must be > GRACEFUL_SHUTDOWN_TIMEOUT
```

### Problem: New Requests Still Accepted During Shutdown

**Check**:
1. `SHUTDOWN_REJECT_NEW_REQUESTS=true` in environment
2. Middleware properly checks `shutdown_manager.is_shutting_down`
3. Path not in `allowed_paths` exception list

## References (参考资料)

- **Detailed Analysis**: [/GRACEFUL_SHUTDOWN_ANALYSIS.md](../GRACEFUL_SHUTDOWN_ANALYSIS.md)
- **Core Implementation**: `backend/app/core/shutdown.py`
- **Tests**: `backend/tests/core/test_shutdown.py`
- **Configuration**: `backend/app/core/config.py`

## Summary (总结)

Wegent Backend的优雅停机确保:

✅ **Zero Downtime**: 滚动更新不中断用户请求  
✅ **Stream Protection**: 长时间流式请求自动保护  
✅ **K8s Native**: 完美集成Kubernetes生命周期  
✅ **Configurable**: 超时和行为可配置  
✅ **Observable**: 完整日志和监控指标  
✅ **Tested**: 全面测试覆盖

Wegent Backend's graceful shutdown ensures:

✅ **Zero Downtime**: Rolling updates don't interrupt user requests  
✅ **Stream Protection**: Long-running streams automatically protected  
✅ **K8s Native**: Perfect integration with Kubernetes lifecycle  
✅ **Configurable**: Timeout and behavior configurable  
✅ **Observable**: Complete logging and monitoring metrics  
✅ **Tested**: Comprehensive test coverage
