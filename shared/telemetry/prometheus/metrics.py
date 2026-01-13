# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Prometheus metrics definitions.

Provides pre-defined HTTP request metrics and an extensible interface
for custom business metrics.

Metrics included (compatible with prometheus-fastapi-instrumentator):
- http_requests_total: Counter of HTTP requests by method, path, and status
- http_request_duration_seconds: Histogram of request durations
- http_request_duration_highr_seconds: High-resolution histogram of request durations
- http_request_size_bytes: Summary of request body sizes
- http_response_size_bytes: Summary of response body sizes
- http_requests_in_progress: Gauge of currently active requests
"""

import logging
from typing import Any, Dict, List, Optional

from prometheus_client import (REGISTRY, CollectorRegistry, Counter, Gauge,
                               Histogram, Summary)

from shared.telemetry.prometheus.config import (PrometheusConfig,
                                                get_prometheus_config)

logger = logging.getLogger(__name__)


# Default histogram buckets for request duration (in seconds)
# These buckets cover a range from 5ms to 30s, suitable for most API endpoints
DEFAULT_DURATION_BUCKETS = (
    0.005,  # 5ms
    0.01,  # 10ms
    0.025,  # 25ms
    0.05,  # 50ms
    0.075,  # 75ms
    0.1,  # 100ms
    0.25,  # 250ms
    0.5,  # 500ms
    0.75,  # 750ms
    1.0,  # 1s
    2.5,  # 2.5s
    5.0,  # 5s
    7.5,  # 7.5s
    10.0,  # 10s
    30.0,  # 30s
)

# High-resolution histogram buckets for request duration
# Compatible with prometheus-fastapi-instrumentator's default buckets
# Provides finer granularity for performance analysis
HIGHR_DURATION_BUCKETS = (
    0.01,
    0.025,
    0.05,
    0.075,
    0.1,
    0.25,
    0.5,
    0.75,
    1.0,
    1.5,
    2.0,
    2.5,
    3.0,
    3.5,
    4.0,
    4.5,
    5.0,
    7.5,
    10.0,
    15.0,
    20.0,
    25.0,
    30.0,
)


class PrometheusMetrics:
    """
    Prometheus metrics container for HTTP request tracking.

    This class manages the lifecycle of Prometheus metrics and provides
    a clean interface for recording HTTP request data. Compatible with
    prometheus-fastapi-instrumentator output format.

    Attributes:
        config: PrometheusConfig instance
        registry: CollectorRegistry for metrics registration
        http_requests_total: Counter for total HTTP requests
        http_request_duration_seconds: Histogram for request duration
        http_request_duration_highr_seconds: High-resolution histogram for duration
        http_request_size_bytes: Summary for request body sizes
        http_response_size_bytes: Summary for response body sizes
        http_requests_in_progress: Gauge for active requests
    """

    def __init__(
        self,
        config: Optional[PrometheusConfig] = None,
        registry: Optional[CollectorRegistry] = None,
        duration_buckets: tuple = DEFAULT_DURATION_BUCKETS,
        highr_buckets: tuple = HIGHR_DURATION_BUCKETS,
    ):
        """
        Initialize Prometheus metrics.

        Args:
            config: PrometheusConfig instance. If None, uses get_prometheus_config()
            registry: CollectorRegistry to use. If None, uses the default REGISTRY
            duration_buckets: Histogram bucket boundaries for request duration
            highr_buckets: High-resolution histogram buckets for detailed analysis
        """
        self.config = config or get_prometheus_config()
        self.registry = registry or REGISTRY
        self._duration_buckets = duration_buckets
        self._highr_buckets = highr_buckets

        # Metric name prefix from config
        prefix = self.config.metrics_prefix

        # Initialize HTTP request metrics with service label
        self.http_requests_total = Counter(
            f"{prefix}http_requests_total",
            "Total number of HTTP requests",
            labelnames=["service", "method", "path", "status_code"],
            registry=self.registry,
        )

        self.http_request_duration_seconds = Histogram(
            f"{prefix}http_request_duration_seconds",
            "HTTP request duration in seconds",
            labelnames=["service", "method", "path"],
            buckets=self._duration_buckets,
            registry=self.registry,
        )

        # High-resolution duration histogram (compatible with instrumentator)
        self.http_request_duration_highr_seconds = Histogram(
            f"{prefix}http_request_duration_highr_seconds",
            "HTTP request duration in seconds (high resolution)",
            labelnames=["service", "method"],
            buckets=self._highr_buckets,
            registry=self.registry,
        )

        # Request/Response size summaries (compatible with instrumentator)
        self.http_request_size_bytes = Summary(
            f"{prefix}http_request_size_bytes",
            "HTTP request body size in bytes",
            labelnames=["service", "handler"],
            registry=self.registry,
        )

        self.http_response_size_bytes = Summary(
            f"{prefix}http_response_size_bytes",
            "HTTP response body size in bytes",
            labelnames=["service", "handler"],
            registry=self.registry,
        )

        self.http_requests_in_progress = Gauge(
            f"{prefix}http_requests_in_progress",
            "Number of HTTP requests currently being processed",
            labelnames=["service", "method", "path"],
            registry=self.registry,
        )

        # Custom metrics registry for extensibility
        self._custom_metrics: Dict[str, Any] = {}

    def record_request_start(self, method: str, path: str) -> None:
        """
        Record the start of an HTTP request.

        Args:
            method: HTTP method (GET, POST, etc.)
            path: Request path
        """
        self.http_requests_in_progress.labels(
            service=self.config.service_name,
            method=method,
            path=path,
        ).inc()

    def record_request_end(
        self,
        method: str,
        path: str,
        status_code: int,
        duration: float,
        request_size: int = 0,
        response_size: int = 0,
    ) -> None:
        """
        Record the end of an HTTP request.

        Args:
            method: HTTP method (GET, POST, etc.)
            path: Request path
            status_code: HTTP response status code
            duration: Request duration in seconds
            request_size: Request body size in bytes (optional)
            response_size: Response body size in bytes (optional)
        """
        service = self.config.service_name

        # Decrement in-progress counter
        self.http_requests_in_progress.labels(
            service=service,
            method=method,
            path=path,
        ).dec()

        # Increment total requests counter
        self.http_requests_total.labels(
            service=service,
            method=method,
            path=path,
            status_code=str(status_code),
        ).inc()

        # Record duration in histogram
        self.http_request_duration_seconds.labels(
            service=service,
            method=method,
            path=path,
        ).observe(duration)

        # Record high-resolution duration (without path to reduce cardinality)
        self.http_request_duration_highr_seconds.labels(
            service=service,
            method=method,
        ).observe(duration)

        # Record request/response sizes if available
        if request_size > 0:
            self.http_request_size_bytes.labels(
                service=service,
                handler=path,
            ).observe(request_size)

        if response_size > 0:
            self.http_response_size_bytes.labels(
                service=service,
                handler=path,
            ).observe(response_size)

    def register_custom_counter(
        self,
        name: str,
        description: str,
        labelnames: Optional[List[str]] = None,
    ) -> Counter:
        """
        Register a custom Counter metric.

        Args:
            name: Metric name (will be prefixed with metrics_prefix)
            description: Metric description
            labelnames: Optional list of label names

        Returns:
            Counter: The registered Counter metric

        Example:
            >>> metrics = get_prometheus_metrics()
            >>> task_counter = metrics.register_custom_counter(
            ...     "tasks_created_total",
            ...     "Total number of tasks created",
            ...     labelnames=["task_type"]
            ... )
            >>> task_counter.labels(task_type="chat").inc()
        """
        full_name = f"{self.config.metrics_prefix}{name}"

        if full_name in self._custom_metrics:
            return self._custom_metrics[full_name]

        labels = labelnames or []
        counter = Counter(
            full_name,
            description,
            labelnames=labels,
            registry=self.registry,
        )
        self._custom_metrics[full_name] = counter
        return counter

    def register_custom_gauge(
        self,
        name: str,
        description: str,
        labelnames: Optional[List[str]] = None,
    ) -> Gauge:
        """
        Register a custom Gauge metric.

        Args:
            name: Metric name (will be prefixed with metrics_prefix)
            description: Metric description
            labelnames: Optional list of label names

        Returns:
            Gauge: The registered Gauge metric

        Example:
            >>> metrics = get_prometheus_metrics()
            >>> active_sessions = metrics.register_custom_gauge(
            ...     "active_sessions",
            ...     "Number of active chat sessions",
            ...     labelnames=["session_type"]
            ... )
            >>> active_sessions.labels(session_type="websocket").set(10)
        """
        full_name = f"{self.config.metrics_prefix}{name}"

        if full_name in self._custom_metrics:
            return self._custom_metrics[full_name]

        labels = labelnames or []
        gauge = Gauge(
            full_name,
            description,
            labelnames=labels,
            registry=self.registry,
        )
        self._custom_metrics[full_name] = gauge
        return gauge

    def register_custom_histogram(
        self,
        name: str,
        description: str,
        labelnames: Optional[List[str]] = None,
        buckets: Optional[tuple] = None,
    ) -> Histogram:
        """
        Register a custom Histogram metric.

        Args:
            name: Metric name (will be prefixed with metrics_prefix)
            description: Metric description
            labelnames: Optional list of label names
            buckets: Optional histogram bucket boundaries

        Returns:
            Histogram: The registered Histogram metric

        Example:
            >>> metrics = get_prometheus_metrics()
            >>> llm_latency = metrics.register_custom_histogram(
            ...     "llm_response_duration_seconds",
            ...     "LLM response duration in seconds",
            ...     labelnames=["model", "provider"]
            ... )
            >>> llm_latency.labels(model="claude-3", provider="anthropic").observe(1.5)
        """
        full_name = f"{self.config.metrics_prefix}{name}"

        if full_name in self._custom_metrics:
            return self._custom_metrics[full_name]

        labels = labelnames or []
        histogram_buckets = buckets or DEFAULT_DURATION_BUCKETS
        histogram = Histogram(
            full_name,
            description,
            labelnames=labels,
            buckets=histogram_buckets,
            registry=self.registry,
        )
        self._custom_metrics[full_name] = histogram
        return histogram


# Cached PrometheusMetrics instance (per service)
_prometheus_metrics: Optional[PrometheusMetrics] = None


def get_prometheus_metrics(
    config: Optional[PrometheusConfig] = None,
    registry: Optional[CollectorRegistry] = None,
) -> PrometheusMetrics:
    """
    Get the global PrometheusMetrics instance.

    This function returns a cached PrometheusMetrics instance. The instance
    is created once and reused for subsequent calls.

    Args:
        config: Optional PrometheusConfig. Only used on first call.
        registry: Optional CollectorRegistry. Only used on first call.

    Returns:
        PrometheusMetrics: The global metrics instance

    Example:
        >>> metrics = get_prometheus_metrics()
        >>> metrics.record_request_start("GET", "/api/users")
    """
    global _prometheus_metrics

    if _prometheus_metrics is None:
        _prometheus_metrics = PrometheusMetrics(config=config, registry=registry)

    return _prometheus_metrics


def reset_prometheus_metrics() -> None:
    """
    Reset the cached PrometheusMetrics instance.

    This is primarily useful for testing purposes.
    Note: This does NOT unregister metrics from the registry.
    """
    global _prometheus_metrics
    _prometheus_metrics = None
