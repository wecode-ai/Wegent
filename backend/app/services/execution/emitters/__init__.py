# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified result emitters for execution events.

This module provides a unified interface for emitting execution events
to different targets (WebSocket, SSE, HTTP Callback, Subscription).
"""

from .base import BaseResultEmitter, QueueBasedEmitter
from .callback import BatchCallbackEmitter, CallbackResultEmitter
from .composite import CompositeResultEmitter
from .factory import EmitterType, ResultEmitterFactory
from .protocol import ResultEmitter, StreamableEmitter
from .sse import DirectSSEEmitter, SSEResultEmitter
from .status_updating import StatusUpdatingEmitter
from .websocket import WebSocketResultEmitter

__all__ = [
    # Protocol
    "ResultEmitter",
    "StreamableEmitter",
    # Base
    "BaseResultEmitter",
    "QueueBasedEmitter",
    # Implementations
    "WebSocketResultEmitter",
    "SSEResultEmitter",
    "DirectSSEEmitter",
    "CallbackResultEmitter",
    "BatchCallbackEmitter",
    "CompositeResultEmitter",
    "StatusUpdatingEmitter",
    # Factory
    "EmitterType",
    "ResultEmitterFactory",
]
