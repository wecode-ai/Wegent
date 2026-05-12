"""Prometheus metrics for the knowledge_doc_converter service.

Defines and exposes metrics for monitoring document conversion operations.
A lightweight HTTP server runs on a configurable port to serve the /metrics
endpoint for Prometheus scraping.

Supports Celery prefork mode via prometheus_client multiprocess directory:
each worker child process writes metrics to a shared directory, and the
metrics HTTP server in the main process aggregates all files on each scrape.

Metrics:
    - Conversion requests (total, by result status)
    - Conversion duration (histogram)
    - Document size (histogram, input bytes)
    - Markdown output size (histogram, output bytes)
    - File type distribution (counter by extension)
    - Active conversions (gauge)
    - Lock acquisition results (counter)
    - Backend callback results (counter)
"""

import logging
import os
import shutil
import tempfile
import threading
from typing import Optional
from wsgiref.simple_server import make_server

logger = logging.getLogger(__name__)

# ---- Multiprocess Support ----
# When running under Celery prefork, each child process has its own memory.
# prometheus_client multiprocess mode writes metrics to a shared directory
# so the HTTP server in the main process can aggregate across all workers.
#
# CRITICAL: PROMETHEUS_MULTIPROC_DIR must be set BEFORE importing
# prometheus_client, because prometheus_client.values checks this env var
# at import time to decide whether to use file-backed (multiprocess) or
# in-process (single-process) metric storage.
_MULTIPROC_DIR = None


def _ensure_multiproc_dir() -> str:
    """Create (if needed) and return the multiprocess metrics directory.

    Sets PROMETHEUS_MULTIPROC_DIR env var so that prometheus_client
    automatically uses file-backed metric storage instead of in-process
    memory. Must be called before any prometheus_client imports.
    """
    global _MULTIPROC_DIR
    if _MULTIPROC_DIR:
        return _MULTIPROC_DIR

    # If already set externally, use it
    existing = os.environ.get("PROMETHEUS_MULTIPROC_DIR")
    if existing:
        _MULTIPROC_DIR = existing
        return _MULTIPROC_DIR

    # Create a temp directory for this worker session
    _MULTIPROC_DIR = tempfile.mkdtemp(prefix="converter_metrics_")
    os.environ["PROMETHEUS_MULTIPROC_DIR"] = _MULTIPROC_DIR
    logger.info(f"Prometheus multiprocess dir: {_MULTIPROC_DIR}")
    return _MULTIPROC_DIR


def cleanup_multiproc_dir() -> None:
    """Remove the multiprocess metrics directory (call on worker shutdown)."""
    global _MULTIPROC_DIR
    if _MULTIPROC_DIR and os.path.isdir(_MULTIPROC_DIR):
        shutil.rmtree(_MULTIPROC_DIR, ignore_errors=True)
        logger.info(f"Cleaned up multiprocess dir: {_MULTIPROC_DIR}")
        _MULTIPROC_DIR = None


# Initialize multiprocess dir BEFORE any prometheus_client import
_ensure_multiproc_dir()

# Import prometheus_client AFTER PROMETHEUS_MULTIPROC_DIR is set,
# so that prometheus_client.values picks up multiprocess file-backed storage.
from prometheus_client import Counter, Gauge, Histogram  # noqa: E402

# ---- Metric Definitions ----

# Total conversion requests
CONVERSION_REQUESTS_TOTAL = Counter(
    "converter_conversion_requests_total",
    "Total number of document conversion requests",
    ["status"],  # status: started, succeeded, failed, skipped
)

# Conversion processing duration in seconds
CONVERSION_DURATION_SECONDS = Histogram(
    "converter_conversion_duration_seconds",
    "Time spent converting a document to Markdown",
    ["file_extension"],
    buckets=(5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600),
)

# Input document size in bytes
CONVERSION_INPUT_SIZE_BYTES = Histogram(
    "converter_conversion_input_size_bytes",
    "Size of input document in bytes",
    ["file_extension"],
    buckets=(
        100 * 1024,  # 100 KB
        500 * 1024,  # 500 KB
        1 * 1024 * 1024,  # 1 MB
        5 * 1024 * 1024,  # 5 MB
        10 * 1024 * 1024,  # 10 MB
        50 * 1024 * 1024,  # 50 MB
        100 * 1024 * 1024,  # 100 MB
    ),
)

# Output markdown size in bytes
CONVERSION_OUTPUT_SIZE_BYTES = Histogram(
    "converter_conversion_output_size_bytes",
    "Size of output Markdown in bytes",
    ["file_extension"],
    buckets=(
        10 * 1024,  # 10 KB
        50 * 1024,  # 50 KB
        100 * 1024,  # 100 KB
        500 * 1024,  # 500 KB
        1 * 1024 * 1024,  # 1 MB
        5 * 1024 * 1024,  # 5 MB
    ),
)

# File type distribution
CONVERSION_FILE_TYPES_TOTAL = Counter(
    "converter_file_types_total",
    "Total number of conversions by file type",
    ["file_extension"],
)

# Currently active conversions
# multiprocess_mode="livesum" ensures correct aggregation across processes:
# inc() in child + dec() in child = net sum visible to main process
CONVERSION_ACTIVE = Gauge(
    "converter_conversion_active",
    "Number of conversions currently in progress",
    multiprocess_mode="livesum",
)

# Lock acquisition results
CONVERSION_LOCK_RESULTS_TOTAL = Counter(
    "converter_lock_results_total",
    "Distributed lock acquisition results",
    ["result"],  # result: acquired, retry, exhausted
)

# Backend callback results
CALLBACK_RESULTS_TOTAL = Counter(
    "converter_callback_results_total",
    "Backend HTTP callback results",
    [
        "callback_type",
        "status",
    ],  # callback_type: started/completed/failed/download, status: success/failed
)


# ---- Metrics Server ----

_server_started = False
_server_lock = threading.Lock()


def start_metrics_server(port: int, path: str = "/metrics") -> None:
    """Start the Prometheus metrics HTTP server.

    Uses prometheus_client multiprocess WSGI app so that metrics from
    all Celery worker child processes are aggregated on each scrape.

    Starts a background thread serving the configured path on the given port.
    Safe to call multiple times — only starts once.

    Args:
        port: Port number for the metrics HTTP server.
        path: URL path for the metrics endpoint (default: /metrics).
    """
    global _server_started
    with _server_lock:
        if _server_started:
            logger.info(f"Metrics server already running on port {port}")
            return
        try:
            from prometheus_client import CollectorRegistry, make_wsgi_app
            from prometheus_client.multiprocess import MultiProcessCollector

            registry = CollectorRegistry()
            MultiProcessCollector(registry)
            metrics_app = make_wsgi_app(registry=registry)

            # Normalize path: ensure leading slash, no trailing slash
            if not path.startswith("/"):
                path = "/" + path
            path = path.rstrip("/")
            metrics_path = path

            def app(environ, start_response):
                if environ.get("PATH_INFO", "") == metrics_path:
                    return metrics_app(environ, start_response)
                start_response("404 Not Found", [("Content-Type", "text/plain")])
                return [b"Not Found"]

            httpd = make_server("0.0.0.0", port, app)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            _server_started = True
            logger.info(
                f"Prometheus metrics server started on port {port}, "
                f"path={metrics_path} (multiprocess mode)"
            )
        except OSError as e:
            logger.error(f"Failed to start metrics server on port {port}: {e}")
        except Exception as e:
            logger.error(f"Unexpected error starting metrics server: {e}")


def is_server_started() -> bool:
    """Check if the metrics server has been started."""
    return _server_started


# ---- Convenience Recording Functions ----


def record_conversion_started():
    """Record a conversion request start."""
    CONVERSION_REQUESTS_TOTAL.labels(status="started").inc()
    CONVERSION_ACTIVE.inc()


def record_conversion_succeeded(
    file_extension: str, duration_seconds: float, input_size: int, output_size: int
):
    """Record a successful conversion.

    Args:
        file_extension: File extension (e.g., "pdf", "pptx").
        duration_seconds: Time spent converting.
        input_size: Input document size in bytes.
        output_size: Output Markdown size in bytes.
    """
    CONVERSION_REQUESTS_TOTAL.labels(status="succeeded").inc()
    CONVERSION_DURATION_SECONDS.labels(file_extension=file_extension).observe(
        duration_seconds
    )
    CONVERSION_INPUT_SIZE_BYTES.labels(file_extension=file_extension).observe(
        input_size
    )
    CONVERSION_OUTPUT_SIZE_BYTES.labels(file_extension=file_extension).observe(
        output_size
    )
    CONVERSION_FILE_TYPES_TOTAL.labels(file_extension=file_extension).inc()
    CONVERSION_ACTIVE.dec()


def record_conversion_failed(
    file_extension: str, duration_seconds: float, input_size: int = 0
):
    """Record a failed conversion.

    Args:
        file_extension: File extension (e.g., "pdf", "pptx").
        duration_seconds: Time spent before failure.
        input_size: Input document size in bytes (0 if not fetched yet).
    """
    CONVERSION_REQUESTS_TOTAL.labels(status="failed").inc()
    if duration_seconds > 0:
        CONVERSION_DURATION_SECONDS.labels(file_extension=file_extension).observe(
            duration_seconds
        )
    if input_size > 0:
        CONVERSION_INPUT_SIZE_BYTES.labels(file_extension=file_extension).observe(
            input_size
        )
    CONVERSION_ACTIVE.dec()


def record_conversion_skipped(reason: str):
    """Record a skipped conversion.

    Args:
        reason: Skip reason (e.g., "not_exists_or_stale", "document_deleted",
                 "stale_conversion", "lock_retry_exhausted").
    """
    CONVERSION_REQUESTS_TOTAL.labels(status="skipped").inc()


def record_lock_acquired():
    """Record a successful lock acquisition."""
    CONVERSION_LOCK_RESULTS_TOTAL.labels(result="acquired").inc()


def record_lock_retry():
    """Record a lock acquisition retry."""
    CONVERSION_LOCK_RESULTS_TOTAL.labels(result="retry").inc()


def record_lock_exhausted():
    """Record a lock acquisition exhaustion (all retries failed)."""
    CONVERSION_LOCK_RESULTS_TOTAL.labels(result="exhausted").inc()


def record_callback_success(callback_type: str):
    """Record a successful backend callback.

    Args:
        callback_type: Type of callback ("started", "completed", "failed", "download").
    """
    CALLBACK_RESULTS_TOTAL.labels(callback_type=callback_type, status="success").inc()


def record_callback_failed(callback_type: str):
    """Record a failed backend callback.

    Args:
        callback_type: Type of callback ("started", "completed", "failed", "download").
    """
    CALLBACK_RESULTS_TOTAL.labels(callback_type=callback_type, status="failed").inc()
