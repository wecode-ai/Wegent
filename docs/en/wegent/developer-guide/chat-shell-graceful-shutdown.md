---
sidebar_position: 22
---

# Chat Shell Graceful Shutdown

Chat Shell's `/v1/responses` endpoint is a long-lived streaming API. When Kubernetes terminates a Pod, the service must stop accepting new traffic before waiting for existing streams to finish. Otherwise users can see interrupted SSE responses.

## Shutdown Flow

Use `/shutdown/wait` from the `preStop` hook:

1. `/shutdown/wait` marks the service as `shutting_down`.
2. `/ready` returns `503`, so Kubernetes stops routing regular new traffic to the Pod.
3. `/v1/responses` returns `503` while `shutting_down`, covering load balancer endpoint propagation delays.
4. Existing streams keep running until the active stream count reaches zero.
5. If the wait exceeds `GRACEFUL_SHUTDOWN_TIMEOUT`, Chat Shell cancels the remaining streams and returns a timeout result.

## Kubernetes Configuration

`terminationGracePeriodSeconds` must be greater than `GRACEFUL_SHUTDOWN_TIMEOUT` so the `preStop` hook and process shutdown have enough time.

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

If `GRACEFUL_SHUTDOWN_TIMEOUT=300`, set `terminationGracePeriodSeconds` to at least `330`.

## Endpoints

- `GET /health`: liveness probe. It still returns `200` during shutdown and includes `shutting_down` and `active_streams`.
- `GET /ready`: readiness probe. It returns `503` during shutdown.
- `POST /shutdown/initiate`: manually enter shutdown state.
- `POST /shutdown/wait`: enter shutdown state and wait for active streams to finish; intended for Kubernetes `preStop`.
- `GET /v1/streams/active-count`: return the active `/v1/responses` stream count for debugging and monitoring.

## Design Constraints

- `shutdown_manager` is the single source of truth for active stream counts, keeping `/health`, `/v1/health`, and shutdown waiting consistent.
- `/v1/responses` rejects only new streaming requests; already registered streams continue.
- Timeout cancellation uses the cancel event registered by each stream instead of module-level temporary state.
