# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Socket.IO Prometheus metrics integration.

Provides decorators and functions for collecting WebSocket/Socket.IO metrics.
"""

import time
from functools import wraps
from typing import Callable, Optional, Set

from shared.prometheus.metrics.websocket import get_websocket_metrics

# Default events to exclude from detailed metrics
DEFAULT_EXCLUDED_EVENTS: Set[str] = {
    "connect",
    "disconnect",
    "ping",
    "pong",
}


def prometheus_socketio_event(
    namespace: str = "/",
    exclude_events: Optional[Set[str]] = None,
):
    """Decorator to add Prometheus metrics to Socket.IO event handlers.

    This decorator wraps the trigger_event method of a Socket.IO namespace
    to automatically collect event metrics.

    Args:
        namespace: The Socket.IO namespace (default: "/")
        exclude_events: Set of event names to exclude from metrics

    Usage:
        class ChatNamespace(socketio.AsyncNamespace):
            @prometheus_socketio_event(namespace="/chat")
            async def trigger_event(self, event: str, sid: str, *args):
                return await self._execute_handler(event, sid, *args)
    """
    excluded = exclude_events or DEFAULT_EXCLUDED_EVENTS

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(self, event: str, sid: str, *args):
            # Skip excluded events (connection events handled separately)
            if event in excluded:
                return await func(self, event, sid, *args)

            metrics = get_websocket_metrics()
            start_time = time.time()
            status = "success"

            try:
                result = await func(self, event, sid, *args)
                return result
            except Exception:
                status = "error"
                raise
            finally:
                duration = time.time() - start_time
                metrics.observe_event(
                    namespace=namespace,
                    event=event,
                    status=status,
                    duration_seconds=duration,
                )

        return wrapper

    return decorator


def record_socketio_connection(namespace: str, status: str) -> None:
    """Record a Socket.IO connection event.

    Call this function in your connect/disconnect event handlers to track
    connection metrics.

    Args:
        namespace: The Socket.IO namespace (e.g., "/chat")
        status: "connected" or "disconnected"

    Usage:
        async def on_connect(self, sid, environ):
            record_socketio_connection("/chat", "connected")
            # ... your connect logic

        async def on_disconnect(self, sid):
            record_socketio_connection("/chat", "disconnected")
            # ... your disconnect logic
    """
    metrics = get_websocket_metrics()
    metrics.record_connection(namespace=namespace, status=status)
