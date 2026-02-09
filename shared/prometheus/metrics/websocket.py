# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket/Socket.IO Prometheus metrics.

Provides metrics for WebSocket connection and event tracking:
- websocket_connections_total: Counter for total connections
- websocket_connections_active: Gauge for active connections
- websocket_events_total: Counter for total events
- websocket_event_duration_seconds: Histogram for event processing time
"""

from typing import Optional

from prometheus_client import Counter, Gauge, Histogram

from shared.prometheus.registry import get_registry

# Histogram buckets starting from 0.1 seconds for WebSocket events
WEBSOCKET_DURATION_BUCKETS = (
    0.1,
    0.25,
    0.5,
    0.75,
    1.0,
    2.5,
    5.0,
    7.5,
    10.0,
    30.0,
    60.0,
    float("inf"),
)


class WebSocketMetrics:
    """WebSocket/Socket.IO metrics collection class.

    Provides metrics for monitoring WebSocket connections and events:
    - Connection counts by namespace and status
    - Active connection tracking
    - Event counts and latency
    """

    def __init__(self, registry=None):
        """Initialize WebSocket metrics.

        Args:
            registry: Optional Prometheus registry. Uses global registry if not provided.
        """
        self._registry = registry or get_registry()
        self._connections_total: Optional[Counter] = None
        self._connections_active: Optional[Gauge] = None
        self._events_total: Optional[Counter] = None
        self._event_duration: Optional[Histogram] = None

    @property
    def connections_total(self) -> Counter:
        """Get or create the connections total counter."""
        if self._connections_total is None:
            self._connections_total = Counter(
                "websocket_connections_total",
                "Total number of WebSocket connections",
                labelnames=["namespace", "status"],
                registry=self._registry,
            )
        return self._connections_total

    @property
    def connections_active(self) -> Gauge:
        """Get or create the active connections gauge."""
        if self._connections_active is None:
            self._connections_active = Gauge(
                "websocket_connections_active",
                "Number of currently active WebSocket connections",
                labelnames=["namespace"],
                registry=self._registry,
            )
        return self._connections_active

    @property
    def events_total(self) -> Counter:
        """Get or create the events total counter."""
        if self._events_total is None:
            self._events_total = Counter(
                "websocket_events_total",
                "Total number of WebSocket events processed",
                labelnames=["namespace", "event", "status"],
                registry=self._registry,
            )
        return self._events_total

    @property
    def event_duration(self) -> Histogram:
        """Get or create the event duration histogram."""
        if self._event_duration is None:
            self._event_duration = Histogram(
                "websocket_event_duration_seconds",
                "WebSocket event processing duration in seconds",
                labelnames=["namespace", "event", "status"],
                buckets=WEBSOCKET_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._event_duration

    def record_connection(self, namespace: str, status: str) -> None:
        """Record a WebSocket connection event.

        Args:
            namespace: Socket.IO namespace (e.g., "/chat")
            status: Connection status ("connected" or "disconnected")
        """
        self.connections_total.labels(namespace=namespace, status=status).inc()

        if status == "connected":
            self.connections_active.labels(namespace=namespace).inc()
        elif status == "disconnected":
            self.connections_active.labels(namespace=namespace).dec()

    def observe_event(
        self,
        namespace: str,
        event: str,
        status: str,
        duration_seconds: float,
    ) -> None:
        """Record a WebSocket event.

        Args:
            namespace: Socket.IO namespace
            event: Event name (e.g., "chat:send")
            status: Event status ("success" or "error")
            duration_seconds: Event processing duration in seconds
        """
        self.events_total.labels(namespace=namespace, event=event, status=status).inc()
        self.event_duration.labels(
            namespace=namespace, event=event, status=status
        ).observe(duration_seconds)


# Global instance
_websocket_metrics: Optional[WebSocketMetrics] = None


def get_websocket_metrics() -> WebSocketMetrics:
    """Get the global WebSocket metrics instance.

    Returns:
        WebSocketMetrics singleton instance.
    """
    global _websocket_metrics
    if _websocket_metrics is None:
        _websocket_metrics = WebSocketMetrics()
    return _websocket_metrics


def reset_websocket_metrics() -> None:
    """Reset the global WebSocket metrics (for testing)."""
    global _websocket_metrics
    _websocket_metrics = None
