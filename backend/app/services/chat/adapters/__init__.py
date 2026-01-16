# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell adapters for Backend integration.

This module provides adapters for communicating with Chat Shell,
supporting both package import (in-process) and HTTP/SSE (remote) modes.
"""

from .converter import SSEToWebSocketConverter, stream_sse_to_websocket
from .http import HTTPAdapter
from .interface import ChatEvent, ChatEventType, ChatInterface, ChatRequest
from .proxy import ChatProxy, chat_proxy

__all__ = [
    "ChatInterface",
    "ChatRequest",
    "ChatEvent",
    "ChatEventType",
    "HTTPAdapter",
    "ChatProxy",
    "chat_proxy",
    "SSEToWebSocketConverter",
    "stream_sse_to_websocket",
]
