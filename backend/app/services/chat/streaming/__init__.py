# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Streaming module for Chat Service.

This module provides:
- WebSocket streaming handler
- Re-exports streaming infrastructure from app.services.streaming
"""

# Export streaming handlers
from app.chat_shell.streaming import SSEStreamingHandler

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

from .ws_handler import WebSocketStreamingHandler

__all__ = [
    # Streaming handlers
    "SSEStreamingHandler",
    "WebSocketStreamingHandler",
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
