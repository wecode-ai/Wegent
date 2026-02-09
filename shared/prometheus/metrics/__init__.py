# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus metrics module.

Provides service-specific HTTP metrics:
- BackendHTTPMetrics: Optimized for standard REST API response times
- ChatShellHTTPMetrics: Extended buckets for long-running LLM interactions
"""

from shared.prometheus.metrics.backend_http import (
    BACKEND_HTTP_DURATION_BUCKETS,
    BackendHTTPMetrics,
    get_backend_http_metrics,
    reset_backend_http_metrics,
)
from shared.prometheus.metrics.chat_shell_http import (
    CHAT_SHELL_HTTP_DURATION_BUCKETS,
    ChatShellHTTPMetrics,
    get_chat_shell_http_metrics,
    reset_chat_shell_http_metrics,
)
from shared.prometheus.metrics.websocket import WebSocketMetrics, get_websocket_metrics

__all__ = [
    # Backend HTTP metrics
    "BackendHTTPMetrics",
    "get_backend_http_metrics",
    "reset_backend_http_metrics",
    "BACKEND_HTTP_DURATION_BUCKETS",
    # Chat Shell HTTP metrics
    "ChatShellHTTPMetrics",
    "get_chat_shell_http_metrics",
    "reset_chat_shell_http_metrics",
    "CHAT_SHELL_HTTP_DURATION_BUCKETS",
    # WebSocket metrics
    "WebSocketMetrics",
    "get_websocket_metrics",
]
