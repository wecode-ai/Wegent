# OpenTelemetry Observability Stack

This folder contains the configuration for the OpenTelemetry observability stack.

## Components

| Service | Port | URL | Purpose |
|---------|------|-----|---------|
| **Jaeger** | 16686 | http://localhost:16686 | Trace visualization & service dependency graph |
| **Kibana** | 5601 | http://localhost:5601 | Query & dashboard visualization |
| **Elasticsearch** | 9200 | http://localhost:9200 | Long-term data storage |
| **OTel Collector** | 4317, 4318 | - | Telemetry data collection |

## Quick Start

### 1. Start the main services first (to create the network)

```bash
# From project root
docker-compose up -d
```

### 2. Start the observability stack

```bash
# From telemetry folder
cd telemetry
docker-compose up -d

# Or from project root
docker-compose -f telemetry/docker-compose.yml up -d
```

### 3. Enable OpenTelemetry in your services

For local development:
```bash
OTEL_ENABLED=true \
OTEL_SERVICE_NAME=wegent-backend \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
./start.sh
```

For Docker services, add to environment:
```yaml
environment:
  OTEL_ENABLED: "true"
  OTEL_SERVICE_NAME: "wegent-backend"
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4317"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Services                      │
│  (wegent-backend, executor-manager, executor)               │
└─────────────────────────┬───────────────────────────────────┘
                          │ OTLP (gRPC/HTTP)
                          ▼
              ┌───────────────────────┐
              │  OpenTelemetry        │
              │  Collector            │
              │  (otel-collector)     │
              └───────────┬───────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
┌─────────────────────┐       ┌─────────────────────┐
│      Jaeger         │       │   Elasticsearch     │
│  (Trace UI)         │       │  (Long-term Store)  │
│  localhost:16686    │       │                     │
└─────────────────────┘       └──────────┬──────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │      Kibana         │
                              │  (Query/Dashboard)  │
                              │  localhost:5601     │
                              └─────────────────────┘
```

## Files

| File | Description |
|------|-------------|
| `docker-compose.yml` | Docker Compose configuration for all observability services |
| `otel-collector-config.yaml` | OpenTelemetry Collector configuration |
| `README.md` | This file |

## Viewing Traces

### Using Jaeger (Recommended for trace visualization)

1. Open http://localhost:16686
2. Select a service from the dropdown
3. Click "Find Traces"
4. Click on a trace to see the full call chain

### Using Kibana (For complex queries)

1. Open http://localhost:5601
2. Go to Stack Management → Data Views
3. Create a data view for `otel-traces*`
4. Go to Discover to query traces

## Stopping the Stack

```bash
cd telemetry
docker-compose down

# To also remove volumes (data)
docker-compose down -v
```

## Troubleshooting

### Check service status
```bash
docker-compose -f telemetry/docker-compose.yml ps
```

### View logs
```bash
docker-compose -f telemetry/docker-compose.yml logs -f otel-collector
```

### Verify Elasticsearch indices
```bash
curl http://localhost:9200/_cat/indices?v | grep otel
```

### Test OTLP endpoint
```bash
curl -v http://localhost:4318/v1/traces
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_ENABLED` | Enable/disable OpenTelemetry | `false` |
| `OTEL_SERVICE_NAME` | Service name for tracing | `wegent-service` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint | `http://otel-collector:4317` |
| `OTEL_TRACES_SAMPLER_ARG` | Sampling ratio (0.0-1.0) | `1.0` |
| `OTEL_METRICS_ENABLED` | Enable metrics export | `false` |

## References

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Elasticsearch Documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html)
- [Kibana Documentation](https://www.elastic.co/guide/en/kibana/current/index.html)