# Kubernetes Graceful Shutdown Guide

This guide explains how to configure Wegent backend for graceful shutdown in Kubernetes deployments.

## Overview

When Kubernetes performs a rolling update or scales down pods, it sends a SIGTERM signal to the container. Without proper handling, this can interrupt active streaming requests (SSE connections), causing poor user experience.

Wegent backend implements graceful shutdown to:
1. Stop accepting new requests during shutdown
2. Wait for active streaming requests to complete
3. Save partial responses to database before termination
4. Properly clean up resources

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    K8s Rolling Update Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. K8s marks pod as "Terminating"                              │
│     ↓                                                            │
│  2. preStop hook executes (sleep 5s)                            │
│     - Allows time for endpoints to be removed from Service      │
│     ↓                                                            │
│  3. SIGTERM sent to container                                   │
│     ↓                                                            │
│  4. Uvicorn receives SIGTERM, triggers lifespan shutdown        │
│     ↓                                                            │
│  5. ShutdownManager.initiate_shutdown()                         │
│     - Sets shutting_down flag                                   │
│     - Readiness probe returns 503                               │
│     - New requests rejected with 503                            │
│     ↓                                                            │
│  6. Wait for active streams (up to GRACEFUL_SHUTDOWN_TIMEOUT)   │
│     - Streams check shutdown flag and complete gracefully       │
│     - Partial content saved to database                         │
│     ↓                                                            │
│  7. If timeout reached, cancel remaining streams                │
│     ↓                                                            │
│  8. Close HTTP clients, stop background jobs                    │
│     ↓                                                            │
│  9. Container exits                                              │
│                                                                  │
│  Total time: terminationGracePeriodSeconds (default: 620s)      │
│  = preStop (5s) + shutdown timeout (600s) + cleanup (15s buffer)│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRACEFUL_SHUTDOWN_TIMEOUT` | `600` | Seconds to wait for active streams to complete (10 minutes) |
| `SHUTDOWN_REJECT_NEW_REQUESTS` | `true` | Whether to reject new requests during shutdown |

### Kubernetes Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wegent-backend
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Ensure zero downtime
  template:
    # Total time K8s waits before force killing the container
    # Should be > preStop + GRACEFUL_SHUTDOWN_TIMEOUT
    # 620s = 5s (preStop) + 600s (shutdown timeout) + 15s (buffer)
    terminationGracePeriodSeconds: 620
    
    containers:
    - name: backend
      image: wegent-backend:latest
      
      env:
      - name: GRACEFUL_SHUTDOWN_TIMEOUT
        value: "600"  # 10 minutes for long-running streaming requests
          value: "30"
        - name: SHUTDOWN_REJECT_NEW_REQUESTS
          value: "true"
        
        ports:
        - containerPort: 8000
        
        # Liveness probe - Is the app alive?
        # Returns 200 even during shutdown (app is still alive)
        livenessProbe:
          httpGet:
            path: /api/health
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        
        # Readiness probe - Should we send traffic?
        # Returns 503 during shutdown to stop new traffic
        readinessProbe:
          httpGet:
            path: /api/ready
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 1  # Fail fast to stop traffic quickly
        
        # Startup probe - Has the app started?
        # Prevents liveness/readiness checks during startup
        startupProbe:
          httpGet:
            path: /api/startup
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 5
          failureThreshold: 30  # Allow up to 150s for startup
        
        lifecycle:
          preStop:
            exec:
              # Sleep to allow K8s to remove pod from Service endpoints
              # This prevents new requests from being routed to this pod
              command: ["sh", "-c", "sleep 5"]
        
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
```

### Service Configuration

```yaml
apiVersion: v1
kind: Service
metadata:
  name: wegent-backend
spec:
  selector:
    app: wegent-backend
  ports:
  - port: 8000
    targetPort: 8000
  # Use ClusterIP for internal services
  type: ClusterIP
```

### Ingress Configuration (for SSE/Streaming)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wegent-backend
  annotations:
    # Nginx Ingress Controller settings for SSE
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    # Disable request buffering for streaming
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: wegent-backend
            port:
              number: 8000
```

## Health Check Endpoints

| Endpoint | Purpose | During Shutdown |
|----------|---------|-----------------|
| `/api/health` | Liveness probe | Returns 200 (app is alive) |
| `/api/ready` | Readiness probe | Returns 503 (stop traffic) |
| `/api/startup` | Startup probe | Returns 200 (startup complete) |

### Response Examples

**Normal Operation:**
```json
// GET /api/ready
{
  "status": "ready",
  "database": "initialized",
  "user_count": 10
}
```

**During Shutdown:**
```json
// GET /api/ready (503)
{
  "status": "shutting_down",
  "message": "Service is shutting down, not accepting new traffic",
  "active_streams": 3,
  "shutdown_duration": 5.2
}
```

## Streaming Request Handling

During graceful shutdown:

1. **New streaming requests** are rejected with 503:
   ```json
   {
     "detail": "Service is shutting down",
     "retry_after": 5,
     "active_streams": 3
   }
   ```

2. **Active streaming requests** continue until:
   - Natural completion
   - Timeout reached (GRACEFUL_SHUTDOWN_TIMEOUT)
   - Cancellation requested

3. **Partial content** is saved to database with metadata:
   ```json
   {
     "value": "partial response content...",
     "incomplete": true,
     "reason": "server_shutdown"
   }
   ```

## Testing Graceful Shutdown

### Local Testing

```bash
# Start the backend
cd backend && ./start.sh

# In another terminal, start a streaming request
curl -N "http://localhost:8000/api/chat/stream?task_id=1"

# In another terminal, send SIGTERM
kill -SIGTERM $(pgrep -f "uvicorn app.main:app")

# Observe:
# 1. Streaming request continues
# 2. New requests return 503
# 3. After timeout, app exits gracefully
```

### Kubernetes Testing

```bash
# Watch pod status
kubectl get pods -w

# Trigger rolling update
kubectl rollout restart deployment/wegent-backend

# Check logs during shutdown
kubectl logs -f <pod-name>

# Verify zero downtime
while true; do curl -s http://api.example.com/api/health; sleep 1; done
```

## Troubleshooting

### Requests Still Being Interrupted

1. **Check terminationGracePeriodSeconds**: Should be > preStop + GRACEFUL_SHUTDOWN_TIMEOUT
2. **Check preStop hook**: Ensure it's configured and sleeping long enough
3. **Check readiness probe**: Should fail quickly (failureThreshold: 1)

### Shutdown Taking Too Long

1. **Reduce GRACEFUL_SHUTDOWN_TIMEOUT**: Lower the timeout value
2. **Check active streams**: Monitor `/api/ready` for active_streams count
3. **Force cancel**: Streams are cancelled after timeout

### Partial Content Not Saved

1. **Check database connection**: Ensure DB is accessible during shutdown
2. **Check Redis connection**: Streaming content is cached in Redis
3. **Check logs**: Look for errors in shutdown sequence

## Best Practices

1. **Set appropriate timeouts**: Balance between user experience and deployment speed
2. **Monitor active streams**: Use metrics to track streaming request duration
3. **Test rolling updates**: Regularly test graceful shutdown in staging
4. **Use PodDisruptionBudget**: Prevent too many pods from being terminated at once

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: wegent-backend-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: wegent-backend
```

## Related Documentation

- [Kubernetes Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Container Lifecycle Hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- [Uvicorn Deployment](https://www.uvicorn.org/deployment/)
