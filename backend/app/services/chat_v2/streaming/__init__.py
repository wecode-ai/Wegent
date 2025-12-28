# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Streaming module for Chat Service.

This module re-exports streaming infrastructure from app.services.streaming
for backward compatibility. New code should import directly from
app.services.streaming.

Also exports the global WebSocket emitter for cross-worker communication.
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

# Export the global emitter from local module
from .global_emitter import get_main_event_loop, get_ws_emitter, init_ws_emitter

__all__ = [
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
    # Global emitter (local)
    "get_ws_emitter",
    "init_ws_emitter",
    "get_main_event_loop",
]
