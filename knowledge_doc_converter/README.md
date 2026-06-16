# Knowledge Doc Converter

Standalone Celery worker that converts PDF/PPTX documents to Markdown via MinerU OCR, then uploads results to S3 and notifies the Backend via internal HTTP callbacks.

## Architecture

```
Backend (orchestrator)
  │
  ├─ Sets document status to PENDING_CONVERSION
  ├─ Dispatches Celery task to `knowledge_conversion` queue
  │
  ▼
Knowledge Doc Converter (Celery worker)
  │
  ├─ Acquires distributed lock (Redis)
  ├─ Downloads attachment via Backend API
  ├─ Sends document to MinerU for OCR conversion
  ├─ Collects Markdown + images output
  ├─ Uploads result to S3 (if enabled)
  ├─ Notifies Backend via callback
  │
  ▼
Backend (state machine)
  │
  ├─ PENDING_CONVERSION → CONVERTING → QUEUED → INDEXING → SUCCESS
  └─ Or → FAILED on error
```

## Configuration

See `.env.example` for all available options. Key settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `BACKEND_BASE_URL` | Backend API base URL | `http://backend:8000` |
| `BACKEND_INTERNAL_TOKEN` | Token for Backend internal API auth | (required) |
| `CELERY_BROKER_URL` | Redis broker URL | `redis://redis:6379/0` |
| `MINERU_API_BASE_URL` | MinerU service URL | `http://mineru:8888` |
| `WORKER_CONVERSION_S3_ENABLED` | Enable S3 upload for results | `false` |
| `PROMETHEUS_ENABLED` | Enable Prometheus metrics server | `false` |
| `PROMETHEUS_PORT` | Metrics server port | `9090` |

## Running Locally

```bash
# Install dependencies
uv sync

# Run Celery worker
celery -A knowledge_doc_converter.celery_app:celery_app worker \
  --loglevel=info \
  --queues=knowledge_conversion \
  --concurrency=2
```

## Docker Deployment

The service is configured in `docker-compose.yml` under the `knowledge_doc_converter` service and starts with the RAG profile:

```bash
docker compose --profile rag up -d
```

Set `KNOWLEDGE_CONVERSION_ENABLED=true` in Backend to enable conversion dispatch.

## Prometheus Metrics

When `PROMETHEUS_ENABLED=true`, the worker exposes metrics at the configured port/path. Uses `prometheus_client` multiprocess mode for correct aggregation across Celery prefork child processes.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `converter_conversion_requests_total` | Counter | Total conversion requests by status |
| `converter_conversion_duration_seconds` | Histogram | Conversion processing time |
| `converter_conversion_input_size_bytes` | Histogram | Input document size |
| `converter_conversion_output_size_bytes` | Histogram | Output Markdown size |
| `converter_conversion_active` | Gauge | Currently active conversions |
| `converter_lock_results_total` | Counter | Lock acquisition results |
| `converter_callback_results_total` | Counter | Backend callback results |

## Backend Integration

The converter communicates with Backend via two internal endpoints:

- `GET /api/internal/attachments/{id}/download` — Download attachment binary
- `POST /api/internal/conversion/callback/{status|completed|failed}` — Report conversion result

Both endpoints require `INTERNAL_SERVICE_TOKEN` authentication.
