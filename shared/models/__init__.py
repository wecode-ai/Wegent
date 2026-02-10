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
- ResponseEventType: Event type mapping with Wegent extensions
- Helper functions for creating standard events

OpenAI Request Converter - bidirectional conversion:
- OpenAIRequestConverter: Convert between ExecutionRequest and OpenAI format
- OpenAIEventConverter: Map between OpenAI and internal event types
"""

from . import db

# Unified execution protocol
from .execution import EventType, ExecutionEvent, ExecutionRequest

# OpenAI Request Converter
from .openai_converter import OpenAIEventConverter, OpenAIRequestConverter

# OpenAI Responses API types
from .responses_api import (
    Clarification,
    ClarificationOption,
    ContentDelta,
    ErrorEvent,
    ReasoningDelta,
    ResponseCancelled,
    ResponseDone,
    ResponseEvent,
    ResponseEventType,
    ResponsesAPIStreamEvents,
    ResponsesAPIStreamingResponse,
    SourceItem,
    SourcesUpdate,
    ThinkingDelta,
    ToolCallRequired,
    ToolDone,
    ToolLimitReached,
    ToolProgress,
    ToolStart,
    UsageInfo,
    create_error_event,
    create_output_text_delta_event,
    create_response_completed_event,
    create_response_created_event,
)

__all__ = [
    "db",
    # Unified execution protocol
    "EventType",
    "ExecutionEvent",
    "ExecutionRequest",
    # OpenAI Responses API types
    "ResponsesAPIStreamEvents",
    "ResponsesAPIStreamingResponse",
    "ResponseEventType",
    "ContentDelta",
    "ThinkingDelta",
    "ReasoningDelta",
    "ToolStart",
    "ToolProgress",
    "ToolDone",
    "ToolCallRequired",
    "SourceItem",
    "SourcesUpdate",
    "ClarificationOption",
    "Clarification",
    "ToolLimitReached",
    "UsageInfo",
    "ResponseDone",
    "ResponseCancelled",
    "ErrorEvent",
    "ResponseEvent",
    "create_response_created_event",
    "create_output_text_delta_event",
    "create_response_completed_event",
    "create_error_event",
    # OpenAI Request Converter
    "OpenAIRequestConverter",
    "OpenAIEventConverter",
]
