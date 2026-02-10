# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell HTTP/API Prometheus metrics.

Provides metrics for Chat Shell HTTP request tracking with extended buckets
optimized for LLM interactions that can take much longer than standard REST APIs:
- chat_shell_http_requests_total: Counter for total requests
- chat_shell_http_request_duration_seconds: Histogram for request latency
- chat_shell_http_requests_in_progress: Gauge for concurrent requests
"""

from typing import Optional

from prometheus_client import Counter, Gauge, Histogram

from shared.prometheus.registry import get_registry

# Histogram buckets optimized for Chat Shell LLM interactions
# Extended to support long-running streaming responses up to 30 minutes
# Covers: 1, 5, 10, 30, 60, 120, 300, 600, 900, 1800 seconds
CHAT_SHELL_HTTP_DURATION_BUCKETS = (
    1.0,
    5.0,
    10.0,
    30.0,
    60.0,
    120.0,
    300.0,
    600.0,
    900.0,
    1800.0,
    float("inf"),
)


class ChatShellHTTPMetrics:
    """Chat Shell HTTP metrics collection class.

    Provides metrics for monitoring Chat Shell HTTP API performance:
    - Request counts by endpoint, method, and status
    - Request latency distribution with extended buckets for LLM interactions
    - Concurrent request tracking

    The buckets are designed for long-running LLM streaming responses that
    can take anywhere from a few seconds to 30 minutes.
    """

    def __init__(self, registry=None):
        """Initialize Chat Shell HTTP metrics.

        Args:
            registry: Optional Prometheus registry. Uses global registry if not provided.
        """
        self._registry = registry or get_registry()
        self._requests_total: Optional[Counter] = None
        self._request_duration: Optional[Histogram] = None
        self._requests_in_progress: Optional[Gauge] = None

    @property
    def requests_total(self) -> Counter:
        """Get or create the requests total counter."""
        if self._requests_total is None:
            self._requests_total = Counter(
                "chat_shell_http_requests_total",
                "Total number of Chat Shell HTTP requests",
                labelnames=["method", "endpoint", "status_code"],
                registry=self._registry,
            )
        return self._requests_total

    @property
    def request_duration(self) -> Histogram:
        """Get or create the request duration histogram."""
        if self._request_duration is None:
            self._request_duration = Histogram(
                "chat_shell_http_request_duration_seconds",
                "Chat Shell HTTP request duration in seconds",
                labelnames=["method", "endpoint", "status_code"],
                buckets=CHAT_SHELL_HTTP_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._request_duration

    @property
    def requests_in_progress(self) -> Gauge:
        """Get or create the requests in progress gauge."""
        if self._requests_in_progress is None:
            self._requests_in_progress = Gauge(
                "chat_shell_http_requests_in_progress",
                "Number of Chat Shell HTTP requests currently being processed",
                labelnames=["method", "endpoint"],
                registry=self._registry,
            )
        return self._requests_in_progress

    def observe_request(
        self,
        method: str,
        endpoint: str,
        status_code: int,
        duration_seconds: float,
    ) -> None:
        """Record a completed HTTP request.

        Args:
            method: HTTP method (GET, POST, etc.)
            endpoint: Normalized endpoint path
            status_code: HTTP response status code
            duration_seconds: Request duration in seconds
        """
        status_str = str(status_code)
        self.requests_total.labels(
            method=method, endpoint=endpoint, status_code=status_str
        ).inc()
        self.request_duration.labels(
            method=method, endpoint=endpoint, status_code=status_str
        ).observe(duration_seconds)

    def inc_in_progress(self, method: str, endpoint: str) -> None:
        """Increment the in-progress counter for a request.

        Args:
            method: HTTP method
            endpoint: Normalized endpoint path
        """
        self.requests_in_progress.labels(method=method, endpoint=endpoint).inc()

    def dec_in_progress(self, method: str, endpoint: str) -> None:
        """Decrement the in-progress counter for a request.

        Args:
            method: HTTP method
            endpoint: Normalized endpoint path
        """
        self.requests_in_progress.labels(method=method, endpoint=endpoint).dec()


# Global instance
_chat_shell_http_metrics: Optional[ChatShellHTTPMetrics] = None


def get_chat_shell_http_metrics() -> ChatShellHTTPMetrics:
    """Get the global Chat Shell HTTP metrics instance.

    Returns:
        ChatShellHTTPMetrics singleton instance.
    """
    global _chat_shell_http_metrics
    if _chat_shell_http_metrics is None:
        _chat_shell_http_metrics = ChatShellHTTPMetrics()
    return _chat_shell_http_metrics


def reset_chat_shell_http_metrics() -> None:
    """Reset the global Chat Shell HTTP metrics (for testing)."""
    global _chat_shell_http_metrics
    _chat_shell_http_metrics = None
