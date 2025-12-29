# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Streaming infrastructure module.

This module provides reusable streaming infrastructure for different protocols:
- SSE (Server-Sent Events) for HTTP streaming
- WebSocket for real-time bidirectional communication

The streaming infrastructure is designed to be protocol-agnostic and can be
used by different services (chat, executor, etc.).
"""

from .core import StreamingConfig, StreamingCore, StreamingState
from .emitters import SSEEmitter, StreamEmitter, WebSocketEmitter
from .utils import truncate_list_keep_ends

__all__ = [
    # Core streaming
    "StreamingCore",
    "StreamingConfig",
    "StreamingState",
    # Emitters
    "StreamEmitter",
    "SSEEmitter",
    "WebSocketEmitter",
    # Utilities
    "truncate_list_keep_ends",
]
