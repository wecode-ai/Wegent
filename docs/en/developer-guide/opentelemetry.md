# OpenTelemetry Setup Guide

This guide explains how to set up and configure OpenTelemetry for distributed tracing and metrics in Wegent.

## Overview

Wegent uses OpenTelemetry to collect and export telemetry data (traces, metrics, and logs) for observability. The default setup uses:

- **OpenTelemetry Collector**: Receives telemetry data via OTLP protocol
- **Jaeger**: Visualizes trace call chains and service dependencies
- **Elasticsearch**: Stores traces, metrics, and logs for long-term storage
- **Kibana**: Visualizes and queries the collected data

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  wegent-backend │     │ executor-manager│     │    executor     │
│   (OTEL SDK)    │     │   (OTEL SDK)    │     │   (OTEL SDK)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │         OTLP (gRPC)   │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  OpenTelemetry Collector│
                    │    (otel-collector)    │
                    └────────────┬───────────┘
                                 │
                    ┌────────────┴───────────┐
                    │                        │
                    ▼                        ▼
       ┌────────────────────┐   ┌────────────────────────┐
       │       Jaeger       │   │     Elasticsearch      │
       │  (Trace UI/链路图)  │   │  (Long-term Storage)   │
       │  localhost:16686   │   │                        │
       └────────────────────┘   └────────────┬───────────┘
                                             │
                                             ▼
                                ┌────────────────────────┐
                                │        Kibana          │
                                │   (Query & Dashboard)  │
                                │    localhost:5601      │
                                └────────────────────────┘
```

## Quick Start

### 1. Start the Observability Services

The OpenTelemetry stack is in a separate folder `telemetry/` to keep it independent from business services.

First, make sure the main services are running (to create the network):

```bash
docker-compose up -d
```

Then start the observability stack:

```bash
# Option 1: From telemetry folder
cd telemetry
docker-compose up -d

# Option 2: From project root
docker-compose -f telemetry/docker-compose.yml up -d
```

Wait for Elasticsearch to be healthy:

```bash
docker-compose -f telemetry/docker-compose.yml logs -f elasticsearch
# Wait until you see "started" message
```

### 2. Enable OpenTelemetry in Services

#### For Docker Services

Uncomment the OpenTelemetry configuration in `docker-compose.yml`:

```yaml
backend:
  environment:
    OTEL_ENABLED: "true"
    OTEL_SERVICE_NAME: "wegent-backend"
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317"
    OTEL_TRACES_SAMPLER_ARG: "1.0"
```

```yaml
executor_manager:
  environment:
    - OTEL_ENABLED=true
    - OTEL_SERVICE_NAME=wegent-executor-manager
    - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
    - OTEL_TRACES_SAMPLER_ARG=1.0
```

#### For Local Development

When running services locally (not in Docker), use `localhost`:

```bash
OTEL_ENABLED=true \
OTEL_SERVICE_NAME=wegent-backend \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
OTEL_TRACES_SAMPLER_ARG=1.0 \
./start.sh
```

### 3. Restart Services

```bash
docker-compose restart backend executor_manager
```

### 4. Access the UIs

- **Jaeger UI** (Trace Visualization): http://localhost:16686
- **Kibana** (Query & Dashboard): http://localhost:5601

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_ENABLED` | Enable/disable OpenTelemetry | `false` |
| `OTEL_SERVICE_NAME` | Service name for tracing | `wegent-service` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC endpoint | `http://otel-collector:4317` |
| `OTEL_TRACES_SAMPLER_ARG` | Sampling ratio (0.0-1.0) | `1.0` |
| `OTEL_METRICS_ENABLED` | Enable/disable metrics export | `false` |
| `OTEL_EXCLUDED_URLS` | Comma-separated URL patterns to exclude (blacklist) | See below |
| `OTEL_INCLUDED_URLS` | Comma-separated URL patterns to include (whitelist) | Empty (all) |
| `OTEL_DISABLE_SEND_RECEIVE_SPANS` | Disable internal http.send/http.receive spans | `true` |

**Note:** Metrics export is disabled by default because Elasticsearch exporter has limited support for certain metric types. If you see `StatusCode.UNIMPLEMENTED` errors, keep metrics disabled.

### SSE/Streaming Endpoint Optimization

By default, OpenTelemetry ASGI instrumentation creates internal spans for each `http.send` and `http.receive` event. For SSE (Server-Sent Events) or streaming endpoints like `/api/chat/stream`, this creates excessive noise as **each chunk generates a separate span**.

#### Industry Standard Solution

The `OTEL_DISABLE_SEND_RECEIVE_SPANS` environment variable (default: `true`) disables these internal spans. This is the **industry standard approach** recommended by OpenTelemetry for streaming endpoints.

**How it works:**
- Uses the `exclude_spans` parameter in `FastAPIInstrumentor.instrument_app()`
- Passes `exclude_spans="send,receive"` to exclude both send and receive internal spans
- This is the official API provided by `opentelemetry-instrumentation-fastapi`

**What it does:**
- Prevents creation of internal spans with `asgi.event.type = http.response.body`
- Reduces trace noise significantly for streaming responses
- Maintains the parent HTTP span for the overall request

**Example trace comparison:**

Without optimization (noisy):
```
POST /api/chat/stream (parent span)
├── http send (chunk 1)
├── http send (chunk 2)
├── http send (chunk 3)
├── ... (hundreds of spans for each SSE chunk)
└── http send (chunk N)
```

With optimization (clean):
```
POST /api/chat/stream (single span with full duration)
```

#### Configuration

```yaml
# Default: streaming-friendly mode (recommended)
environment:
  OTEL_ENABLED: "true"
  OTEL_DISABLE_SEND_RECEIVE_SPANS: "true"  # Default, can be omitted

# If you need to debug streaming internals (not recommended for production)
environment:
  OTEL_ENABLED: "true"
  OTEL_DISABLE_SEND_RECEIVE_SPANS: "false"
```

#### Requirements

This feature uses the `exclude_spans` parameter which is available in `opentelemetry-instrumentation-fastapi`. The project uses `>= 0.48b0` which fully supports this feature.

#### References

- [OpenTelemetry FastAPI Instrumentation](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/main/instrumentation/opentelemetry-instrumentation-fastapi) - Official FastAPI instrumentation with `exclude_spans` parameter
- [OpenTelemetry ASGI Instrumentation](https://opentelemetry-python-contrib.readthedocs.io/en/latest/instrumentation/asgi/asgi.html)
- [HTTP Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/http/) - OpenTelemetry standards for HTTP tracing

### URL Filtering (Blacklist/Whitelist)

You can filter which API endpoints are traced using blacklist or whitelist mode.

#### Default Excluded URLs (Blacklist)

By default, the following URLs are excluded from tracing:

- `/health`, `/healthz`, `/ready`, `/readyz`, `/livez` - Health check endpoints
- `/metrics` - Prometheus metrics endpoint
- `/api/docs`, `/api/openapi.json` - API documentation
- `/favicon.ico` - Browser favicon

#### Blacklist Mode (Default)

Exclude specific URLs from tracing:

```bash
# Exclude additional endpoints
OTEL_EXCLUDED_URLS="/health,/metrics,/api/docs,/api/internal/*,/api/v1/ping"
```

#### Whitelist Mode

Only trace specific URLs (useful for debugging specific endpoints):

```bash
# Only trace these endpoints
OTEL_INCLUDED_URLS="/api/tasks/*,/api/chat/*,/api/teams/*"
```

**Note:** When `OTEL_INCLUDED_URLS` is set, `OTEL_EXCLUDED_URLS` is ignored.

#### Pattern Syntax

| Pattern | Description | Example |
|---------|-------------|---------|
| `/api/health` | Exact match | Matches only `/api/health` |
| `/api/*` | Prefix wildcard | Matches `/api/users`, `/api/tasks/123`, etc. |
| `^/api/v[0-9]+/.*` | Regex (starts with `^`) | Matches `/api/v1/users`, `/api/v2/tasks` |

#### Example Configurations

**Exclude noisy internal endpoints:**
```yaml
environment:
  OTEL_ENABLED: "true"
  OTEL_EXCLUDED_URLS: "/health,/metrics,/api/docs,/api/internal/*,/api/v1/heartbeat"
```

**Debug specific feature only:**
```yaml
environment:
  OTEL_ENABLED: "true"
  OTEL_INCLUDED_URLS: "/api/chat/*,/api/tasks/*"
```

**Clear default exclusions (trace everything):**
```yaml
environment:
  OTEL_ENABLED: "true"
  OTEL_EXCLUDED_URLS: ""  # Empty string clears defaults
```

### OpenTelemetry Collector Configuration

The collector configuration is in `otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 10s
    send_batch_size: 1024

exporters:
  elasticsearch/traces:
    endpoints: ["http://elasticsearch:9200"]
    traces_index: "otel-traces"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [elasticsearch/traces]
```

### Elasticsearch Indices

The following indices are created automatically:

| Index | Description |
|-------|-------------|
| `otel-traces` | Distributed traces |
| `otel-metrics` | Application metrics |
| `otel-logs` | Application logs |

## Viewing Traces in Jaeger

Jaeger provides the best experience for viewing trace call chains and service dependencies.

### Access Jaeger UI

Open http://localhost:16686 in your browser.

### Search Traces

1. Select a **Service** from the dropdown (e.g., `wegent-backend`)
2. Optionally set **Operation**, **Tags**, or **Time Range**
3. Click **Find Traces**

### View Trace Details

1. Click on a trace to see the full call chain
2. Each span shows:
   - Operation name
   - Duration
   - Tags and logs
   - Parent-child relationships

### Service Dependency Graph

1. Click **System Architecture** in the top menu
2. View the service dependency graph showing how services communicate

### Compare Traces

1. Select multiple traces from the search results
2. Click **Compare** to see differences between traces

## Viewing Data in Kibana

Kibana is useful for complex queries and creating dashboards.

### Create Index Patterns

1. Go to **Stack Management** → **Index Patterns**
2. Create patterns for:
   - `otel-traces*`
   - `otel-metrics*`
   - `otel-logs*`

### Discover Traces

1. Go to **Discover**
2. Select the `otel-traces*` index pattern
3. Use KQL to filter traces:
   ```
   service.name: "wegent-backend" AND name: "HTTP*"
   ```

### Create Dashboards

1. Go to **Dashboard** → **Create dashboard**
2. Add visualizations for:
   - Request latency histogram
   - Error rate over time
   - Service call counts

## Fault Tolerance (Collector Unavailability)

**Important:** The OpenTelemetry SDK is configured with fail-safe settings to ensure that if the Collector is unavailable, your main services will **NOT** be affected.

### How It Works

When the Collector is down or unreachable:

1. **Traces are buffered** in memory (up to 2048 spans)
2. **Export attempts timeout quickly** (5 seconds for connection, 10 seconds for export)
3. **Spans are dropped** (not blocking) when the buffer is full
4. **Your application continues to function normally**

### Configuration Details

The SDK uses `BatchSpanProcessor` with these fail-safe settings:

| Setting | Value | Description |
|---------|-------|-------------|
| `max_queue_size` | 2048 | Maximum spans to buffer before dropping |
| `schedule_delay_millis` | 5000 | Export batch every 5 seconds |
| `max_export_batch_size` | 512 | Maximum spans per export batch |
| `export_timeout_millis` | 10000 | 10 second timeout per export attempt |
| `exporter.timeout` | 5 | 5 second connection timeout |

### What Happens When Collector is Down

```
┌─────────────────────────────────────────────────────────────────┐
│  Collector DOWN                                                  │
├─────────────────────────────────────────────────────────────────┤
│  1. Service continues to handle requests normally               │
│  2. Spans are queued in memory (up to 2048)                     │
│  3. Export attempts fail with timeout (5-10 seconds)            │
│  4. Warning logs appear: "Failed to export spans"               │
│  5. When queue is full, oldest spans are dropped                │
│  6. NO impact on request latency or service availability        │
├─────────────────────────────────────────────────────────────────┤
│  Collector RECOVERS                                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Queued spans are exported                                   │
│  2. New spans continue to be collected                          │
│  3. Normal operation resumes automatically                      │
└─────────────────────────────────────────────────────────────────┘
```

### Monitoring Collector Health

To monitor if the Collector is healthy:

```bash
# Check collector status
docker-compose -f telemetry/docker-compose.yml ps otel-collector

# Check collector logs for errors
docker-compose -f telemetry/docker-compose.yml logs otel-collector | tail -50

# Check collector metrics
curl http://localhost:8888/metrics | grep otelcol_exporter
```

### Best Practices

1. **Always set `OTEL_ENABLED=false` in critical production environments** if you're not actively using tracing
2. **Monitor collector health** with alerting on the collector's `/metrics` endpoint
3. **Use sampling** (`OTEL_TRACES_SAMPLER_ARG=0.1`) to reduce load
4. **Deploy collector with high availability** (multiple replicas) in production

## Production Recommendations

### 1. Enable Elasticsearch Security

```yaml
elasticsearch:
  environment:
    - xpack.security.enabled=true
    - ELASTIC_PASSWORD=your-strong-password
```

Update the collector configuration:

```yaml
exporters:
  elasticsearch/traces:
    endpoints: ["http://elasticsearch:9200"]
    auth:
      authenticator: basicauth/client

extensions:
  basicauth/client:
    client_auth:
      username: elastic
      password: your-strong-password
```

### 2. Adjust Sampling Rate

For high-traffic production environments, reduce the sampling rate:

```yaml
OTEL_TRACES_SAMPLER_ARG: "0.1"  # Sample 10% of traces
```

### 3. Configure Data Retention

Set up Index Lifecycle Management (ILM) in Elasticsearch:

```json
PUT _ilm/policy/otel-policy
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {
            "max_size": "50GB",
            "max_age": "7d"
          }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

### 4. Resource Allocation

For production, increase Elasticsearch memory:

```yaml
elasticsearch:
  environment:
    - "ES_JAVA_OPTS=-Xms2g -Xmx2g"
```

## Troubleshooting

### Common Issues

#### 1. "StatusCode.UNAVAILABLE" Error

**Cause**: OpenTelemetry Collector is not running or not reachable.

**Solution**:
```bash
# Check if collector is running
docker-compose ps otel-collector

# Check collector logs
docker-compose logs otel-collector
```

#### 2. "StatusCode.UNIMPLEMENTED" Error

**Cause**: The OTLP endpoint doesn't support the requested operation (e.g., Jaeger doesn't support metrics).

**Solution**: Use OpenTelemetry Collector instead of Jaeger for full support.

#### 3. No Data in Kibana

**Cause**: Index patterns not created or data not being exported.

**Solution**:
```bash
# Check if indices exist
curl http://localhost:9200/_cat/indices?v

# Check collector logs for export errors
docker-compose logs otel-collector | grep -i error
```

### Verify Data Flow

```bash
# Check Elasticsearch indices
curl http://localhost:9200/_cat/indices?v | grep otel

# Query traces
curl http://localhost:9200/otel-traces/_search?pretty -H "Content-Type: application/json" -d '{"size": 1}'

# Check collector metrics
curl http://localhost:8888/metrics
```

## Disabling OpenTelemetry

To disable OpenTelemetry and stop the error messages:

1. Set `OTEL_ENABLED=false` in your environment
2. Or comment out the OTEL configuration in `docker-compose.yml`
3. Restart the affected services

```bash
docker-compose restart backend executor_manager
```

## Service Ports Summary

| Service | Port | URL | Purpose |
|---------|------|-----|---------|
| Jaeger UI | 16686 | http://localhost:16686 | Trace visualization |
| Kibana | 5601 | http://localhost:5601 | Query & Dashboard |
| Elasticsearch | 9200 | http://localhost:9200 | Data storage API |
| OTLP gRPC | 4317 | - | Telemetry data ingestion |
| OTLP HTTP | 4318 | - | Telemetry data ingestion |
| Collector Metrics | 8888 | http://localhost:8888/metrics | Collector self-metrics |

## References

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Elasticsearch Exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/elasticsearchexporter)
- [Kibana Documentation](https://www.elastic.co/guide/en/kibana/current/index.html)