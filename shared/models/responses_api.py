# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAI Responses API schema definitions.

This module provides standardized schema definitions for OpenAI Responses API,
compatible with standard OpenAI client consumption.

Uses LiteLLM's types for standard events and extends with Wegent-specific features.
"""

from typing import Any, Optional, Union

# Import LiteLLM's OpenAI Responses API types for standardized events
from litellm.types.llms.openai import (
    ResponsesAPIStreamEvents,
    ResponsesAPIStreamingResponse,
)
from pydantic import BaseModel, Field

__all__ = [
    # LiteLLM types (re-exported)
    "ResponsesAPIStreamEvents",
    "ResponsesAPIStreamingResponse",
    # Event type mapping
    "ResponseEventType",
    # Response event data models
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
    # Helper functions
    "create_response_created_event",
    "create_output_text_delta_event",
    "create_response_completed_event",
    "create_error_event",
]


class ResponseEventType:
    """
    SSE event types mapping.

    Maps Wegent event types to OpenAI Responses API standard events.
    Uses LiteLLM's ResponsesAPIStreamEvents for standard events.
    """

    # Standard OpenAI Responses API events (from LiteLLM)
    RESPONSE_CREATED = ResponsesAPIStreamEvents.RESPONSE_CREATED.value
    RESPONSE_IN_PROGRESS = ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value
    RESPONSE_COMPLETED = ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value
    RESPONSE_FAILED = ResponsesAPIStreamEvents.RESPONSE_FAILED.value
    RESPONSE_INCOMPLETE = ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value

    # Output events
    OUTPUT_ITEM_ADDED = ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value
    OUTPUT_ITEM_DONE = ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value
    CONTENT_PART_ADDED = ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value
    CONTENT_PART_DONE = ResponsesAPIStreamEvents.CONTENT_PART_DONE.value
    OUTPUT_TEXT_DELTA = ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value
    OUTPUT_TEXT_DONE = ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value

    # Function/Tool events
    FUNCTION_CALL_ARGUMENTS_DELTA = (
        ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value
    )
    FUNCTION_CALL_ARGUMENTS_DONE = (
        ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value
    )

    # Search events
    WEB_SEARCH_CALL_IN_PROGRESS = (
        ResponsesAPIStreamEvents.WEB_SEARCH_CALL_IN_PROGRESS.value
    )
    WEB_SEARCH_CALL_SEARCHING = ResponsesAPIStreamEvents.WEB_SEARCH_CALL_SEARCHING.value
    WEB_SEARCH_CALL_COMPLETED = ResponsesAPIStreamEvents.WEB_SEARCH_CALL_COMPLETED.value

    # Reasoning events
    RESPONSE_PART_ADDED = ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value

    # Error event
    ERROR = ResponsesAPIStreamEvents.ERROR.value

    # Legacy Wegent event types (for backward compatibility)
    # These map to OpenAI standard events
    RESPONSE_START = RESPONSE_CREATED  # Alias
    CONTENT_DELTA = OUTPUT_TEXT_DELTA  # Alias
    RESPONSE_DONE = RESPONSE_COMPLETED  # Alias

    # Wegent-specific events (not in OpenAI spec)
    THINKING_DELTA = "response.thinking.delta"
    REASONING_DELTA = "response.reasoning.delta"
    TOOL_START = "response.tool.start"
    TOOL_PROGRESS = "response.tool.progress"
    TOOL_DONE = "response.tool.done"
    TOOL_CALL_REQUIRED = "response.tool.call_required"
    SOURCES_UPDATE = "response.sources.update"
    CLARIFICATION = "response.clarification"
    TOOL_LIMIT_REACHED = "response.tool_limit_reached"
    RESPONSE_CANCELLED = "response.cancelled"


# ============================================================
# Response Event Data Models
# ============================================================


class ContentDelta(BaseModel):
    """Content delta event data (maps to response.output_text.delta)."""

    type: str = Field("text", description="Content type: text or image")
    text: Optional[str] = Field(None, description="Text content")
    data: Optional[str] = Field(None, description="Base64 image data")
    # Extended fields for Wegent
    result: Optional[dict] = Field(
        None,
        description="Full result data including thinking, blocks, sources for real-time rendering",
    )
    block_id: Optional[str] = Field(
        None,
        description="Block ID for text streaming - identifies which text block to append content to",
    )
    block_offset: Optional[int] = Field(
        None,
        description="Character offset within the current text block for incremental rendering",
    )
    # OpenAI Responses API fields
    item_id: Optional[str] = Field(None, description="Output item ID")
    output_index: Optional[int] = Field(None, description="Output index")
    content_index: Optional[int] = Field(None, description="Content index")


class ThinkingDelta(BaseModel):
    """Thinking delta event data."""

    text: str = Field(..., description="Thinking content")


class ReasoningDelta(BaseModel):
    """Reasoning delta event data (for DeepSeek R1 etc.)."""

    text: str = Field(..., description="Reasoning content")


class ToolStart(BaseModel):
    """Tool start event data."""

    id: str = Field(..., description="Tool call ID")
    name: str = Field(..., description="Tool name")
    input: dict = Field(..., description="Tool input")
    display_name: Optional[str] = Field(None, description="Display name for UI")
    blocks: Optional[list[dict[str, Any]]] = Field(
        None, description="Current message blocks for mixed content rendering"
    )


class ToolProgress(BaseModel):
    """Tool progress event data."""

    id: str = Field(..., description="Tool call ID")
    progress: int = Field(..., ge=0, le=100, description="Progress percentage")
    message: Optional[str] = Field(None, description="Progress message")


class ToolDone(BaseModel):
    """Tool done event data."""

    id: str = Field(..., description="Tool call ID")
    output: Any = Field(..., description="Tool output")
    duration_ms: Optional[int] = Field(None, description="Execution duration in ms")
    error: Optional[str] = Field(None, description="Error message if failed")
    sources: Optional[list[dict]] = Field(None, description="Source references")
    display_name: Optional[str] = Field(
        None, description="Display name for UI (updates title on completion)"
    )
    blocks: Optional[list[dict[str, Any]]] = Field(
        None, description="Current message blocks for mixed content rendering"
    )


class ToolCallRequired(BaseModel):
    """Tool call required event data (for client-side execution)."""

    id: str = Field(..., description="Tool call ID")
    name: str = Field(..., description="Tool name")
    input: dict = Field(..., description="Tool input")


class SourceItem(BaseModel):
    """Source reference item for knowledge base citations."""

    index: Optional[int] = Field(None, description="Source index number (1, 2, 3...)")
    title: str = Field(..., description="Source title/document name")
    kb_id: Optional[int] = Field(None, description="Knowledge base ID")
    url: Optional[str] = Field(None, description="Source URL (for web sources)")
    snippet: Optional[str] = Field(None, description="Content snippet")


class SourcesUpdate(BaseModel):
    """Sources update event data."""

    sources: list[SourceItem] = Field(..., description="Source references")


class ClarificationOption(BaseModel):
    """Clarification option."""

    label: str = Field(..., description="Option label")
    value: str = Field(..., description="Option value")


class Clarification(BaseModel):
    """Clarification event data."""

    question: str = Field(..., description="Clarification question")
    options: Optional[list[ClarificationOption]] = Field(None, description="Options")


class ToolLimitReached(BaseModel):
    """Tool limit reached event data."""

    max_calls: int = Field(..., description="Max allowed tool calls")
    message: str = Field(..., description="Limit message")


class UsageInfo(BaseModel):
    """Token usage information."""

    input_tokens: int = Field(..., description="Input tokens")
    output_tokens: int = Field(..., description="Output tokens")
    total_tokens: Optional[int] = Field(None, description="Total tokens")
    cache_read_input_tokens: Optional[int] = Field(
        None, description="Cache read tokens"
    )
    cache_creation_input_tokens: Optional[int] = Field(
        None, description="Cache creation tokens"
    )


class ResponseDone(BaseModel):
    """Response done event data.

    Uses extra="allow" to pass through additional fields from upstream
    without needing to explicitly define them here. This ensures new fields
    (like loaded_skills) are automatically forwarded to backend.
    """

    model_config = {"extra": "allow"}

    id: str = Field(..., description="Response ID")
    usage: Optional[UsageInfo] = Field(None, description="Token usage")
    stop_reason: str = Field(
        ..., description="Stop reason: end_turn, tool_use, max_tokens"
    )
    sources: Optional[list[SourceItem]] = Field(None, description="Source references")
    blocks: Optional[list[dict[str, Any]]] = Field(
        None, description="Message blocks for mixed text/tool rendering"
    )
    silent_exit: Optional[bool] = Field(
        None,
        description="Whether this was a silent exit (subscription task decided not to respond)",
    )
    silent_exit_reason: Optional[str] = Field(
        None, description="Reason for silent exit (for logging)"
    )


class ResponseCancelled(BaseModel):
    """Response cancelled event data."""

    id: str = Field(..., description="Response ID")
    partial_content: Optional[str] = Field(
        None, description="Partial content generated"
    )


class ErrorEvent(BaseModel):
    """Error event data."""

    code: str = Field(..., description="Error code")
    message: str = Field(..., description="Error message")
    details: Optional[dict] = Field(None, description="Error details")


class ResponseEvent(BaseModel):
    """Generic response event."""

    event: str = Field(..., description="Event type")
    data: Union[
        ContentDelta,
        ThinkingDelta,
        ReasoningDelta,
        ToolStart,
        ToolProgress,
        ToolDone,
        ToolCallRequired,
        SourcesUpdate,
        Clarification,
        ToolLimitReached,
        ResponseDone,
        ResponseCancelled,
        ErrorEvent,
        dict,
    ] = Field(..., description="Event data")


# ============================================================
# Helper Functions for Creating Standard Events
# ============================================================


def create_response_created_event(
    response_id: str,
    model: str,
    created_at: int,
) -> dict:
    """Create a response.created event in OpenAI format.

    Args:
        response_id: Unique response ID
        model: Model identifier
        created_at: Unix timestamp

    Returns:
        Event data dictionary
    """
    return {
        "type": ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
        "response": {
            "id": response_id,
            "object": "response",
            "created_at": created_at,
            "model": model,
            "status": "in_progress",
            "output": [],
        },
    }


def create_output_text_delta_event(
    item_id: str,
    output_index: int,
    content_index: int,
    delta: str,
    result: Optional[dict] = None,
    block_id: Optional[str] = None,
    block_offset: Optional[int] = None,
) -> dict:
    """Create a response.output_text.delta event in OpenAI format.

    Args:
        item_id: Output item ID
        output_index: Output index
        content_index: Content index
        delta: Text delta
        result: Optional Wegent result data
        block_id: Optional block ID for streaming
        block_offset: Optional block offset

    Returns:
        Event data dictionary
    """
    event_data = {
        "type": ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
        "item_id": item_id,
        "output_index": output_index,
        "content_index": content_index,
        "delta": delta,
    }
    # Add Wegent extensions if provided
    if result is not None:
        event_data["result"] = result
    if block_id is not None:
        event_data["block_id"] = block_id
    if block_offset is not None:
        event_data["block_offset"] = block_offset
    return event_data


def create_response_completed_event(
    response_id: str,
    model: str,
    created_at: int,
    item_id: str,
    content: str,
    usage: Optional[dict] = None,
    sources: Optional[list[dict]] = None,
    blocks: Optional[list[dict]] = None,
    stop_reason: str = "end_turn",
    silent_exit: Optional[bool] = None,
    silent_exit_reason: Optional[str] = None,
    **extra_fields,
) -> dict:
    """Create a response.completed event in OpenAI format.

    Args:
        response_id: Unique response ID
        model: Model identifier
        created_at: Unix timestamp
        item_id: Output item ID
        content: Full response content
        usage: Optional token usage info
        sources: Optional source references
        blocks: Optional message blocks
        stop_reason: Stop reason
        silent_exit: Whether this was a silent exit
        silent_exit_reason: Reason for silent exit
        **extra_fields: Additional fields to include

    Returns:
        Event data dictionary
    """
    response_data = {
        "type": ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
        "response": {
            "id": response_id,
            "object": "response",
            "created_at": created_at,
            "model": model,
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "id": item_id,
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": content,
                            "annotations": [],
                        }
                    ],
                }
            ],
            "usage": usage,
            # Wegent extensions
            "stop_reason": stop_reason,
            "sources": sources,
            "blocks": blocks,
            "silent_exit": silent_exit,
            "silent_exit_reason": silent_exit_reason,
            **extra_fields,
        },
    }
    return response_data


def create_error_event(
    code: str,
    message: str,
    details: Optional[dict] = None,
) -> dict:
    """Create an error event in OpenAI format.

    Args:
        code: Error code
        message: Error message
        details: Optional error details

    Returns:
        Event data dictionary
    """
    event_data = {
        "type": ResponsesAPIStreamEvents.ERROR.value,
        "code": code,
        "message": message,
    }
    if details is not None:
        event_data["details"] = details
    return event_data
