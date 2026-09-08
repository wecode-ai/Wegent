# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content-free metrics for terminal relay and session storage."""

from prometheus_client import Counter, Histogram

TERMINAL_EVENTS_TOTAL = Counter(
    "terminal_ws_events_total",
    "Accepted terminal WebSocket events",
    ["source", "event"],
)
TERMINAL_SESSION_CACHE_REQUESTS_TOTAL = Counter(
    "terminal_session_cache_requests_total",
    "Terminal session cache lookups",
    ["result"],
)
TERMINAL_SESSION_CACHE_EVICTIONS_TOTAL = Counter(
    "terminal_session_cache_evictions_total",
    "Terminal session cache capacity evictions",
)
TERMINAL_SESSION_STORE_OPERATIONS_TOTAL = Counter(
    "terminal_session_store_operations_total",
    "Exact-key terminal session store operations",
    ["operation", "result"],
)
TERMINAL_SESSION_STORE_DURATION_SECONDS = Histogram(
    "terminal_session_store_duration_seconds",
    "Exact-key terminal session store operation duration",
    ["operation"],
    buckets=(0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1),
)


def record_terminal_event(
    *,
    source: str,
    event: str,
) -> None:
    """Record an accepted terminal event without terminal content."""
    TERMINAL_EVENTS_TOTAL.labels(source=source, event=event).inc()


def record_terminal_session_cache_request(result: str) -> None:
    """Record a bounded cache lookup without session identifiers."""
    TERMINAL_SESSION_CACHE_REQUESTS_TOTAL.labels(result=result).inc()


def record_terminal_session_cache_eviction() -> None:
    """Record one capacity eviction without session identifiers."""
    TERMINAL_SESSION_CACHE_EVICTIONS_TOTAL.inc()


def record_terminal_session_store_operation(
    *,
    operation: str,
    result: str,
    duration_seconds: float,
) -> None:
    """Record one exact-key store operation without key or payload content."""
    TERMINAL_SESSION_STORE_OPERATIONS_TOTAL.labels(
        operation=operation,
        result=result,
    ).inc()
    TERMINAL_SESSION_STORE_DURATION_SECONDS.labels(operation=operation).observe(
        max(0.0, duration_seconds)
    )
