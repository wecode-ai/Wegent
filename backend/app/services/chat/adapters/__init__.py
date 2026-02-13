# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell adapters for Backend integration.

This module provides converters for SSE to WebSocket streaming.

NOTE: ChatRequest, ChatEvent, ChatEventType, HTTPAdapter, ChatProxy have been removed.
Use ExecutionRequest, ExecutionEvent, and EventType from shared.models instead.
Use ExecutionDispatcher from app.services.execution for task dispatch.
"""

# Re-export unified types from shared.models for convenience
from shared.models import EventType, ExecutionEvent, ExecutionRequest

from .converter import SSEToWebSocketConverter, stream_sse_to_websocket

__all__ = [
    # Unified types from shared.models
    "ExecutionRequest",
    "ExecutionEvent",
    "EventType",
    # Converters
    "SSEToWebSocketConverter",
    "stream_sse_to_websocket",
]
