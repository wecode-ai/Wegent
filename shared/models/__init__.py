# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared models package for Wegent project.

Unified execution protocol - all modules use these classes:
- ExecutionRequest: Unified request format for all execution services
- ExecutionEvent: Unified event format for all execution services
- EventType: Unified event type enum

OpenAI Responses API - standardized streaming events:
- ResponsesAPIStreamEvents: Standard event types from LiteLLM
- ResponsesAPIEventBuilder: Stateful builder for creating events with minimal parameters
- ResponsesAPIEmitter: Unified emitter with transport abstraction

OpenAI Request Converter - bidirectional conversion:
- OpenAIRequestConverter: Convert between ExecutionRequest and OpenAI format
- OpenAIEventConverter: Map between OpenAI and internal event types
"""

from . import db

# Unified event emitter
from .emitter import (
    CallbackTransport,
    EventTransport,
    GeneratorTransport,
    ResponsesAPIEmitter,
    WebSocketTransport,
)

# Unified execution protocol
from .execution import EventType, ExecutionEvent, ExecutionRequest

# OpenAI Request Converter
from .openai_converter import OpenAIEventConverter, OpenAIRequestConverter

# OpenAI Responses API types and event builder
from .responses_api import (
    ResponsesAPIEventBuilder,
    ResponsesAPIStreamEvents,
    ResponsesAPIStreamingResponse,
)

__all__ = [
    "db",
    # Unified execution protocol
    "EventType",
    "ExecutionEvent",
    "ExecutionRequest",
    # OpenAI Responses API
    "ResponsesAPIStreamEvents",
    "ResponsesAPIStreamingResponse",
    "ResponsesAPIEventBuilder",
    # Unified event emitter
    "ResponsesAPIEmitter",
    "EventTransport",
    "CallbackTransport",
    "WebSocketTransport",
    "GeneratorTransport",
    # OpenAI Request Converter
    "OpenAIRequestConverter",
    "OpenAIEventConverter",
]
