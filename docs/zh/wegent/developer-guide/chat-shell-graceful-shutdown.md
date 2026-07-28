---
sidebar_position: 22
---

# Chat Shell 优雅退出

Chat Shell 的 `/v1/responses` 是长连接流式接口。Kubernetes 终止 Pod 时，必须先停止新流量，再等待已有流结束，否则用户会看到中断的 SSE 响应。

## 退出流程

推荐使用 `preStop` 调用 `/shutdown/wait`：

1. `/shutdown/wait` 将服务标记为 `shutting_down`。
2. `/ready` 返回 `503`，Kubernetes 不再把常规新流量转发到该 Pod。
3. `/v1/responses` 在 `shutting_down` 状态下直接返回 `503`，兜底处理负载均衡摘除延迟。
4. 已经建立的流继续执行，直到所有 active streams 归零。
5. 如果等待超过 `GRACEFUL_SHUTDOWN_TIMEOUT`，Chat Shell 会取消剩余流并返回 timeout 结果。

## Kubernetes 配置

`terminationGracePeriodSeconds` 必须大于 `GRACEFUL_SHUTDOWN_TIMEOUT`，给 `preStop` 和进程退出留出余量。

```yaml
spec:
  terminationGracePeriodSeconds: 330
  containers:
    - name: chat-shell
      lifecycle:
        preStop:
          httpGet:
            path: /shutdown/wait
            port: 8001
      readinessProbe:
        httpGet:
          path: /ready
          port: 8001
      livenessProbe:
        httpGet:
          path: /health
          port: 8001
```

如果 `GRACEFUL_SHUTDOWN_TIMEOUT=300`，建议 `terminationGracePeriodSeconds` 至少设置为 `330`。

## 相关接口

- `GET /health`：存活探针。即使正在退出也返回 `200`，并包含 `shutting_down` 和 `active_streams`。
- `GET /ready`：就绪探针。退出期间返回 `503`。
- `POST /shutdown/initiate`：手动进入退出状态。
- `POST /shutdown/wait`：进入退出状态并等待活跃流结束，适合 Kubernetes `preStop`。
- `GET /v1/streams/active-count`：返回当前 `/v1/responses` 活跃流数量，适合调试和监控。

## 设计约束

- 活跃流数量以 `shutdown_manager` 为单一来源，避免 `/health`、`/v1/health` 和 shutdown 等待逻辑不一致。
- `/v1/responses` 只拒绝新的流式请求；已经注册的流会继续完成。
- timeout 后的取消通过每个流注册的取消事件触发，避免依赖模块级临时变量。
