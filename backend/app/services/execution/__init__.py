# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Execution module for task dispatch.

This module provides unified task dispatch functionality including:
- ExecutionRouter: Routes tasks to execution targets
- ExecutionDispatcher: Dispatches tasks via SSE/WebSocket/HTTP
- ResultEmitter: Unified interface for emitting execution events
- TaskRequestBuilder: Builds ExecutionRequest from database models
"""

from .dispatcher import ExecutionDispatcher, execution_dispatcher
from .emitters import (
    BaseResultEmitter,
    BatchCallbackEmitter,
    CallbackResultEmitter,
    CompositeResultEmitter,
    DirectSSEEmitter,
    EmitterType,
    QueueBasedEmitter,
    ResultEmitter,
    ResultEmitterFactory,
    SSEResultEmitter,
    StreamableEmitter,
    WebSocketResultEmitter,
)
from .request_builder import TaskRequestBuilder
from .router import CommunicationMode, ExecutionRouter, ExecutionTarget

__all__ = [
    # Router
    "ExecutionRouter",
    "ExecutionTarget",
    "CommunicationMode",
    # Dispatcher
    "ExecutionDispatcher",
    "execution_dispatcher",
    # Request Builder
    "TaskRequestBuilder",
    # Emitters - Protocol
    "ResultEmitter",
    "StreamableEmitter",
    # Emitters - Base
    "BaseResultEmitter",
    "QueueBasedEmitter",
    # Emitters - Implementations
    "WebSocketResultEmitter",
    "SSEResultEmitter",
    "DirectSSEEmitter",
    "CallbackResultEmitter",
    "BatchCallbackEmitter",
    "CompositeResultEmitter",
    # Emitters - Factory
    "EmitterType",
    "ResultEmitterFactory",
]
