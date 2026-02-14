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

Block types for mixed content rendering:
- BlockType: Block type enumeration (tool, text)
- BlockStatus: Block status enumeration (pending, streaming, done, error)
- ToolBlock: Tool block dataclass
- TextBlock: Text block dataclass
- create_tool_block: Convenience function to create tool block dict
- create_text_block: Convenience function to create text block dict
"""

from . import db

# Block types for mixed content rendering
from .blocks import (
    BlockStatus,
    BlockType,
    MessageBlock,
    TextBlock,
    ToolBlock,
    block_from_dict,
    blocks_from_list,
    blocks_to_list,
    create_text_block,
    create_tool_block,
)

# Unified execution protocol
from .execution import EventType, ExecutionEvent, ExecutionRequest

# OpenAI Request Converter
from .openai_converter import (
    OpenAIEventConverter,
    OpenAIRequestConverter,
    get_metadata_field,
)

# OpenAI Responses API types and event builder
from .responses_api import (
    ResponsesAPIEventBuilder,
    ResponsesAPIStreamEvents,
    ResponsesAPIStreamingResponse,
)

# Unified event emitter
from .responses_api_emitter import (
    CallbackTransport,
    EventTransport,
    GeneratorTransport,
    ResponsesAPIEmitter,
    WebSocketTransport,
)

# Factory and Builder for emitter
from .responses_api_factory import (
    EmitterBuilder,
    RedisTransport,
    ThrottleConfig,
    ThrottledTransport,
    TransportFactory,
    TransportType,
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
    # Factory and Builder for emitter
    "EmitterBuilder",
    "TransportFactory",
    "TransportType",
    "RedisTransport",
    "ThrottleConfig",
    "ThrottledTransport",
    # OpenAI Request Converter
    "OpenAIRequestConverter",
    "OpenAIEventConverter",
    "get_metadata_field",
    # Block types for mixed content rendering
    "BlockType",
    "BlockStatus",
    "ToolBlock",
    "TextBlock",
    "MessageBlock",
    "block_from_dict",
    "blocks_from_list",
    "blocks_to_list",
    "create_tool_block",
    "create_text_block",
]
