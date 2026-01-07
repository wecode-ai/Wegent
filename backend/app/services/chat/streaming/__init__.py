# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Streaming module for Chat Service.

This module provides:
- WebSocket streaming handler (legacy direct emit)
- WebSocket bridge (unified architecture via Redis Pub/Sub)
- Backend SSE handler (for chat_shell HTTP mode)
- Re-exports streaming infrastructure from app.services.streaming
"""

# Re-export from the centralized streaming module
from app.services.streaming import (
    SSEEmitter,
    StreamEmitter,
    StreamingConfig,
    StreamingCore,
    StreamingState,
    WebSocketEmitter,
    truncate_list_keep_ends,
)

from .sse_handler import BackendStreamHandler, SSEEvent, parse_sse_lines
from .ws_bridge import WebSocketBridge
from .ws_handler import WebSocketStreamingHandler

__all__ = [
    # Streaming handlers
    "WebSocketStreamingHandler",
    "WebSocketBridge",
    "BackendStreamHandler",
    # SSE parsing utilities
    "SSEEvent",
    "parse_sse_lines",
    # Core streaming (re-exported from app.services.streaming)
    "StreamingCore",
    "StreamingConfig",
    "StreamingState",
    # Emitters (re-exported from app.services.streaming)
    "StreamEmitter",
    "SSEEmitter",
    "WebSocketEmitter",
    # Utilities (re-exported from app.services.streaming)
    "truncate_list_keep_ends",
]
