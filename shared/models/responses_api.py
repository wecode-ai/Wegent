# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAI Responses API schema definitions.

This module provides standardized schema definitions for OpenAI Responses API,
compatible with standard OpenAI client consumption.

All helper functions follow OpenAI's official Responses API specification.
See: https://platform.openai.com/docs/api-reference/responses-streaming

Design:
- ResponsesAPIStreamEvents: Event type enum (defined locally to avoid litellm dependency)
- ResponsesAPIStreamingResponse: Union type of all event TypedDicts
- ResponsesAPIEventBuilder: Stateful builder for creating events with minimal parameters

Note: We define ResponsesAPIStreamEvents locally instead of importing from litellm
to avoid loading the entire litellm library (~907 modules, ~156MB memory).
"""

import json
import time
import uuid
from enum import Enum
from typing import Any, List, Literal, Optional, Union

from typing_extensions import NotRequired, TypedDict

# ============================================================
# Response Object Types
# ============================================================


class ResponsesAPIUsage(TypedDict, total=False):
    """Token usage information."""

    input_tokens: int
    output_tokens: int
    total_tokens: int


class OutputTextContent(TypedDict):
    """Output text content part."""

    type: Literal["output_text"]
    text: str
    annotations: List[Any]


class ReasoningContent(TypedDict):
    """Reasoning content part."""

    type: Literal["reasoning"]
    text: str


class MessageItem(TypedDict, total=False):
    """Message output item."""

    type: Literal["message"]
    id: str
    status: str
    role: Literal["assistant"]
    content: List[OutputTextContent]


class FunctionCallItem(TypedDict, total=False):
    """Function call output item."""

    type: Literal["function_call"]
    id: str
    call_id: str
    name: str
    arguments: str


class MCPCallItem(TypedDict, total=False):
    """MCP call output item."""

    type: Literal["mcp_call"]
    id: str
    name: str
    server_label: str
    arguments: str
    status: str


class ShellCallAction(TypedDict, total=False):
    """Shell call action payload."""

    commands: List[str]
    timeout_ms: int
    max_output_length: int


class ShellCallItem(TypedDict, total=False):
    """Shell call output item."""

    type: Literal["shell_call"]
    id: str
    call_id: str
    status: str
    action: ShellCallAction
    # Wegent extensions
    name: str
    input: dict[str, Any]


OutputItem = Union[MessageItem, FunctionCallItem, MCPCallItem, ShellCallItem]


class ResponsesAPIResponse(TypedDict, total=False):
    """Response object in events."""

    id: str
    object: Literal["response"]
    created_at: int
    model: str
    status: str
    output: List[OutputItem]
    usage: ResponsesAPIUsage
    stop_reason: str
    incomplete_details: dict
    # Wegent extensions
    sources: List[Any]
    silent_exit: bool
    silent_exit_reason: str


# ============================================================
# Event Types (TypedDict definitions)
# ============================================================


class ResponseCreatedEvent(TypedDict, total=False):
    """response.created event."""

    type: Literal["response.created"]
    response: ResponsesAPIResponse
    shell_type: str  # Wegent extension


class ResponseInProgressEvent(TypedDict):
    """response.in_progress event."""

    type: Literal["response.in_progress"]
    response: ResponsesAPIResponse


class ResponseCompletedEvent(TypedDict):
    """response.completed event."""

    type: Literal["response.completed"]
    response: ResponsesAPIResponse


class ResponseFailedEvent(TypedDict):
    """response.failed event."""

    type: Literal["response.failed"]
    response: ResponsesAPIResponse


class ResponseIncompleteEvent(TypedDict):
    """response.incomplete event."""

    type: Literal["response.incomplete"]
    response: ResponsesAPIResponse


class OutputItemAddedEvent(TypedDict, total=False):
    """response.output_item.added event."""

    type: Literal["response.output_item.added"]
    response_id: str
    output_index: int
    item: OutputItem
    display_name: str  # Wegent extension


class OutputItemDoneEvent(TypedDict):
    """response.output_item.done event."""

    type: Literal["response.output_item.done"]
    response_id: str
    output_index: int
    item: OutputItem


class ContentPartAddedEvent(TypedDict):
    """response.content_part.added event."""

    type: Literal["response.content_part.added"]
    response_id: str
    item_id: str
    output_index: int
    content_index: int
    part: OutputTextContent


class ContentPartDoneEvent(TypedDict):
    """response.content_part.done event."""

    type: Literal["response.content_part.done"]
    response_id: str
    item_id: str
    output_index: int
    content_index: int
    part: OutputTextContent


class OutputTextDeltaEvent(TypedDict, total=False):
    """response.output_text.delta event."""

    type: Literal["response.output_text.delta"]
    item_id: str
    output_index: int
    content_index: int
    delta: str
    offset: int  # Wegent extension


class OutputTextDoneEvent(TypedDict):
    """response.output_text.done event."""

    type: Literal["response.output_text.done"]
    item_id: str
    output_index: int
    content_index: int
    text: str


class FunctionCallArgumentsDeltaEvent(TypedDict):
    """response.function_call_arguments.delta event."""

    type: Literal["response.function_call_arguments.delta"]
    response_id: str
    item_id: str
    output_index: int
    delta: str


class FunctionCallArgumentsDoneEvent(TypedDict, total=False):
    """response.function_call_arguments.done event."""

    type: Literal["response.function_call_arguments.done"]
    response_id: str
    item_id: str
    output_index: int
    arguments: str
    output: str  # Wegent extension


class ResponsePartAddedEvent(TypedDict):
    """response.reasoning_summary_part.added event."""

    type: Literal["response.reasoning_summary_part.added"]
    response_id: str
    item_id: str
    output_index: int
    part: ReasoningContent


class ErrorEvent(TypedDict):
    """error event."""

    type: Literal["error"]
    code: str
    message: str


# Union of all event types for type checking
ResponsesAPIStreamingResponse = Union[
    ResponseCreatedEvent,
    ResponseInProgressEvent,
    ResponseCompletedEvent,
    ResponseFailedEvent,
    ResponseIncompleteEvent,
    OutputItemAddedEvent,
    OutputItemDoneEvent,
    ContentPartAddedEvent,
    ContentPartDoneEvent,
    OutputTextDeltaEvent,
    OutputTextDoneEvent,
    FunctionCallArgumentsDeltaEvent,
    FunctionCallArgumentsDoneEvent,
    ResponsePartAddedEvent,
    ErrorEvent,
]


# ============================================================
# Event Type Enum
# ============================================================


class ResponsesAPIStreamEvents(str, Enum):
    """OpenAI Responses API stream event types.

    These event types follow OpenAI's official Responses API specification.
    See: https://platform.openai.com/docs/api-reference/responses-streaming
    """

    # Response lifecycle events
    RESPONSE_CREATED = "response.created"
    RESPONSE_IN_PROGRESS = "response.in_progress"
    RESPONSE_COMPLETED = "response.completed"
    RESPONSE_FAILED = "response.failed"
    RESPONSE_INCOMPLETE = "response.incomplete"

    # Reasoning events
    RESPONSE_PART_ADDED = "response.reasoning_summary_part.added"
    REASONING_SUMMARY_TEXT_DELTA = "response.reasoning_summary_text.delta"

    # Output item events
    OUTPUT_ITEM_ADDED = "response.output_item.added"
    OUTPUT_ITEM_DONE = "response.output_item.done"

    # Content part events
    CONTENT_PART_ADDED = "response.content_part.added"
    CONTENT_PART_DONE = "response.content_part.done"

    # Text streaming events
    OUTPUT_TEXT_DELTA = "response.output_text.delta"
    OUTPUT_TEXT_ANNOTATION_ADDED = "response.output_text.annotation.added"
    OUTPUT_TEXT_DONE = "response.output_text.done"

    # Refusal events
    REFUSAL_DELTA = "response.refusal.delta"
    REFUSAL_DONE = "response.refusal.done"

    # Function call events
    FUNCTION_CALL_ARGUMENTS_DELTA = "response.function_call_arguments.delta"
    FUNCTION_CALL_ARGUMENTS_DONE = "response.function_call_arguments.done"

    # File search events
    FILE_SEARCH_CALL_IN_PROGRESS = "response.file_search_call.in_progress"
    FILE_SEARCH_CALL_SEARCHING = "response.file_search_call.searching"
    FILE_SEARCH_CALL_COMPLETED = "response.file_search_call.completed"

    # Web search events
    WEB_SEARCH_CALL_IN_PROGRESS = "response.web_search_call.in_progress"
    WEB_SEARCH_CALL_SEARCHING = "response.web_search_call.searching"
    WEB_SEARCH_CALL_COMPLETED = "response.web_search_call.completed"

    # MCP events
    MCP_LIST_TOOLS_IN_PROGRESS = "response.mcp_list_tools.in_progress"
    MCP_LIST_TOOLS_COMPLETED = "response.mcp_list_tools.completed"
    MCP_LIST_TOOLS_FAILED = "response.mcp_list_tools.failed"
    MCP_CALL_IN_PROGRESS = "response.mcp_call.in_progress"
    MCP_CALL_ARGUMENTS_DELTA = "response.mcp_call_arguments.delta"
    MCP_CALL_ARGUMENTS_DONE = "response.mcp_call_arguments.done"
    MCP_CALL_COMPLETED = "response.mcp_call.completed"
    MCP_CALL_FAILED = "response.mcp_call.failed"

    # Image generation events
    IMAGE_GENERATION_PARTIAL_IMAGE = "image_generation.partial_image"

    # Error event
    ERROR = "error"


__all__ = [
    # Event type enum
    "ResponsesAPIStreamEvents",
    # Union type of all events
    "ResponsesAPIStreamingResponse",
    # Response object types
    "ResponsesAPIResponse",
    "ResponsesAPIUsage",
    "OutputTextContent",
    "ReasoningContent",
    "MessageItem",
    "FunctionCallItem",
    "MCPCallItem",
    "ShellCallItem",
    "OutputItem",
    # Individual event types (TypedDict)
    "ResponseCreatedEvent",
    "ResponseInProgressEvent",
    "ResponseCompletedEvent",
    "ResponseFailedEvent",
    "ResponseIncompleteEvent",
    "OutputItemAddedEvent",
    "OutputItemDoneEvent",
    "ContentPartAddedEvent",
    "ContentPartDoneEvent",
    "OutputTextDeltaEvent",
    "OutputTextDoneEvent",
    "FunctionCallArgumentsDeltaEvent",
    "FunctionCallArgumentsDoneEvent",
    "ResponsePartAddedEvent",
    "ErrorEvent",
    # Event builder
    "ResponsesAPIEventBuilder",
]


class ResponsesAPIEventBuilder:
    """Builder for creating OpenAI Responses API events.

    This class maintains context (response_id, item_id, etc.) and provides
    simple methods to create events with minimal parameters.

    Usage:
        builder = ResponsesAPIEventBuilder(subtask_id=123)

        # Create events with minimal parameters
        start_event = builder.response_created()
        chunk_event = builder.text_delta("Hello")
        done_event = builder.response_completed(content="Hello world")

    All events follow OpenAI's official Responses API specification.
    """

    def __init__(
        self,
        subtask_id: int,
        model: str = "",
        response_id: Optional[str] = None,
    ):
        """Initialize the event builder.

        Args:
            subtask_id: Subtask ID (used to generate item_id)
            model: Model identifier
            response_id: Optional response ID (auto-generated if not provided)
        """
        self.subtask_id = subtask_id
        self.model = model
        self.response_id = response_id or f"resp_{uuid.uuid4().hex[:24]}"
        self.item_id = f"msg_{subtask_id}"
        self.created_at = int(time.time())
        self.output_index = 0
        self.content_index = 0
        self._tool_output_index = 1  # Tool calls start at index 1
        self._text_offset = 0  # Track cumulative text offset for streaming

    @staticmethod
    def _json_arguments(arguments: Optional[dict]) -> str:
        return json.dumps(arguments) if arguments else ""

    @staticmethod
    def _shell_action(arguments: Optional[dict]) -> ShellCallAction:
        arguments = arguments or {}
        action: ShellCallAction = {
            "commands": (
                [arguments["command"]]
                if isinstance(arguments.get("command"), str) and arguments["command"]
                else []
            ),
        }
        timeout_seconds = arguments.get("timeout_seconds")
        if isinstance(timeout_seconds, int) and timeout_seconds > 0:
            action["timeout_ms"] = timeout_seconds * 1000
        return action

    # ============================================================
    # Response Lifecycle Events
    # ============================================================

    def response_created(self, shell_type: Optional[str] = None) -> dict:
        """Create response.created event.

        Args:
            shell_type: Optional shell type (Wegent extension)

        Returns:
            Event data dictionary
        """
        data = {
            "type": ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
            "response": {
                "id": self.response_id,
                "object": "response",
                "created_at": self.created_at,
                "model": self.model,
                "status": "in_progress",
                "output": [],
            },
        }
        if shell_type:
            data["shell_type"] = shell_type
        return data

    def response_in_progress(self) -> dict:
        """Create response.in_progress event.

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
            "response": {
                "id": self.response_id,
                "object": "response",
                "created_at": self.created_at,
                "model": self.model,
                "status": "in_progress",
                "output": [],
            },
        }

    def response_completed(
        self,
        content: str = "",
        usage: Optional[dict] = None,
        stop_reason: str = "end_turn",
        sources: Optional[list] = None,
        silent_exit: Optional[bool] = None,
        silent_exit_reason: Optional[str] = None,
        **extra_fields,
    ) -> dict:
        """Create response.completed event.

        Args:
            content: Full response content
            usage: Token usage info
            stop_reason: Stop reason (end_turn, tool_use, max_tokens)
            sources: Source references (Wegent extension)
            silent_exit: Silent exit flag (Wegent extension)
            silent_exit_reason: Silent exit reason (Wegent extension)
            **extra_fields: Additional fields

        Returns:
            Event data dictionary
        """
        output = [
            {
                "type": "message",
                "id": self.item_id,
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
        ]

        response_data = {
            "type": ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
            "response": {
                "id": self.response_id,
                "object": "response",
                "created_at": self.created_at,
                "model": self.model,
                "status": "completed",
                "output": output,
                "usage": usage,
                "stop_reason": stop_reason,
            },
        }

        # Add Wegent extensions if provided
        if sources is not None:
            response_data["response"]["sources"] = sources
        if silent_exit is not None:
            response_data["response"]["silent_exit"] = silent_exit
        if silent_exit_reason is not None:
            response_data["response"]["silent_exit_reason"] = silent_exit_reason
        for key, value in extra_fields.items():
            if value is not None:
                response_data["response"][key] = value

        return response_data

    def response_incomplete(self, reason: str = "cancelled", content: str = "") -> dict:
        """Create response.incomplete event.

        Args:
            reason: Reason for incompletion
            content: Partial content (if any)

        Returns:
            Event data dictionary
        """
        output = []
        if content:
            output = [
                {
                    "type": "message",
                    "id": self.item_id,
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": content}],
                }
            ]

        return {
            "type": ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
            "response": {
                "id": self.response_id,
                "object": "response",
                "status": "incomplete",
                "incomplete_details": {"reason": reason},
                "output": output,
            },
        }

    def error(self, message: str, code: str = "internal_error") -> dict:
        """Create error event.

        Args:
            message: Error message
            code: Error code

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.ERROR.value,
            "code": code,
            "message": message,
        }

    # ============================================================
    # Text Streaming Events
    # ============================================================

    def output_item_added(self) -> dict:
        """Create response.output_item.added event for message.

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            "response_id": self.response_id,
            "output_index": self.output_index,
            "item": {
                "type": "message",
                "id": self.item_id,
                "status": "in_progress",
                "role": "assistant",
                "content": [],
            },
        }

    def content_part_added(self) -> dict:
        """Create response.content_part.added event.

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            "response_id": self.response_id,
            "item_id": self.item_id,
            "output_index": self.output_index,
            "content_index": self.content_index,
            "part": {
                "type": "output_text",
                "text": "",
                "annotations": [],
            },
        }

    def text_delta(self, delta: str) -> dict:
        """Create response.output_text.delta event.

        Args:
            delta: Text delta

        Returns:
            Event data dictionary
        """
        # Capture current offset before incrementing
        current_offset = self._text_offset
        # Update offset for next delta
        self._text_offset += len(delta)

        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
            "item_id": self.item_id,
            "output_index": self.output_index,
            "content_index": self.content_index,
            "delta": delta,
            # Wegent extension: include offset for streaming position tracking
            "offset": current_offset,
        }

    def text_done(self, text: str) -> dict:
        """Create response.output_text.done event.

        Args:
            text: Full text content

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
            "item_id": self.item_id,
            "output_index": self.output_index,
            "content_index": self.content_index,
            "text": text,
        }

    def content_part_done(self, text: str, annotations: Optional[list] = None) -> dict:
        """Create response.content_part.done event.

        Args:
            text: Full text content
            annotations: Optional annotations

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            "response_id": self.response_id,
            "item_id": self.item_id,
            "output_index": self.output_index,
            "content_index": self.content_index,
            "part": {
                "type": "output_text",
                "text": text,
                "annotations": annotations or [],
            },
        }

    def output_item_done(self, content: str) -> dict:
        """Create response.output_item.done event for message.

        Args:
            content: Full content

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            "response_id": self.response_id,
            "output_index": self.output_index,
            "item": {
                "type": "message",
                "id": self.item_id,
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": content,
                        "annotations": [],
                    }
                ],
            },
        }

    # ============================================================
    # Function Call Events
    # ============================================================

    def function_call_added(
        self, call_id: str, name: str, display_name: Optional[str] = None
    ) -> dict:
        """Create response.output_item.added event for function call.

        Args:
            call_id: Function call ID
            name: Function name
            display_name: Optional display name for the tool (Wegent extension)

        Returns:
            Event data dictionary
        """
        output_index = self._tool_output_index
        data = {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            "response_id": self.response_id,
            "output_index": output_index,
            "item": {
                "type": "function_call",
                "id": call_id,
                "call_id": call_id,
                "name": name,
                "arguments": "",
            },
        }
        # Add display_name as Wegent extension if provided
        if display_name:
            data["display_name"] = display_name
        return data

    def function_call_arguments_delta(
        self,
        call_id: str,
        arguments: Optional[dict] = None,
    ) -> dict:
        """Create response.function_call_arguments.delta event.

        Args:
            call_id: Function call ID
            arguments: Arguments dict (will be JSON serialized)

        Returns:
            Event data dictionary
        """
        delta = self._json_arguments(arguments)
        return {
            "type": ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
            "response_id": self.response_id,
            "item_id": call_id,
            "output_index": self._tool_output_index,
            "delta": delta,
        }

    def function_call_arguments_done(
        self,
        call_id: str,
        arguments: Optional[dict] = None,
        output: Optional[str] = None,
    ) -> dict:
        """Create response.function_call_arguments.done event.

        Args:
            call_id: Function call ID
            arguments: Complete arguments dict
            output: Tool execution output (Wegent extension)

        Returns:
            Event data dictionary
        """
        args_str = self._json_arguments(arguments)
        data = {
            "type": ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
            "response_id": self.response_id,
            "item_id": call_id,
            "output_index": self._tool_output_index,
            "arguments": args_str,
        }
        # Add output as Wegent extension for tool result
        if output is not None:
            data["output"] = output
        return data

    def function_call_done(
        self,
        call_id: str,
        name: str,
        arguments: Optional[dict] = None,
    ) -> dict:
        """Create response.output_item.done event for function call.

        Args:
            call_id: Function call ID
            name: Function name
            arguments: Complete arguments dict

        Returns:
            Event data dictionary
        """
        args_str = self._json_arguments(arguments)
        output_index = self._tool_output_index
        self._tool_output_index += 1  # Increment for next tool call
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            "response_id": self.response_id,
            "output_index": output_index,
            "item": {
                "type": "function_call",
                "id": call_id,
                "call_id": call_id,
                "name": name,
                "arguments": args_str,
            },
        }

    # ============================================================
    # MCP Call Events
    # ============================================================

    def mcp_call_added(
        self,
        item_id: str,
        name: str,
        server_label: str,
    ) -> dict:
        """Create response.output_item.added event for MCP call."""
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            "response_id": self.response_id,
            "output_index": self._tool_output_index,
            "item": {
                "type": "mcp_call",
                "id": item_id,
                "name": name,
                "server_label": server_label,
                "arguments": "",
            },
        }

    def mcp_call_arguments_done(
        self,
        item_id: str,
        arguments: Optional[dict] = None,
    ) -> dict:
        """Create response.mcp_call_arguments.done event."""
        return {
            "type": ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DONE.value,
            "response_id": self.response_id,
            "item_id": item_id,
            "output_index": self._tool_output_index,
            "arguments": self._json_arguments(arguments),
        }

    def mcp_call_in_progress(self, item_id: str) -> dict:
        """Create response.mcp_call.in_progress event."""
        return {
            "type": ResponsesAPIStreamEvents.MCP_CALL_IN_PROGRESS.value,
            "response_id": self.response_id,
            "item_id": item_id,
            "output_index": self._tool_output_index,
        }

    def mcp_call_completed(self, item_id: str) -> dict:
        """Create response.mcp_call.completed event."""
        return {
            "type": ResponsesAPIStreamEvents.MCP_CALL_COMPLETED.value,
            "response_id": self.response_id,
            "item_id": item_id,
            "output_index": self._tool_output_index,
        }

    def mcp_call_failed(self, item_id: str, error: Optional[str] = None) -> dict:
        """Create response.mcp_call.failed event."""
        data = {
            "type": ResponsesAPIStreamEvents.MCP_CALL_FAILED.value,
            "response_id": self.response_id,
            "item_id": item_id,
            "output_index": self._tool_output_index,
        }
        if error:
            data["error"] = error
        return data

    def mcp_call_done(
        self,
        item_id: str,
        name: str,
        server_label: str,
        arguments: Optional[dict] = None,
        status: str = "completed",
    ) -> dict:
        """Create response.output_item.done event for MCP call."""
        output_index = self._tool_output_index
        self._tool_output_index += 1
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            "response_id": self.response_id,
            "output_index": output_index,
            "item": {
                "type": "mcp_call",
                "id": item_id,
                "name": name,
                "server_label": server_label,
                "arguments": self._json_arguments(arguments),
                "status": status,
            },
        }

    # ============================================================
    # Shell Call Events
    # ============================================================

    def shell_call_added(
        self,
        call_id: str,
        name: str,
        arguments: Optional[dict] = None,
        display_name: Optional[str] = None,
    ) -> dict:
        """Create response.output_item.added event for shell call."""
        output_index = self._tool_output_index
        data = {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            "response_id": self.response_id,
            "output_index": output_index,
            "item": {
                "type": "shell_call",
                "id": call_id,
                "call_id": call_id,
                "status": "in_progress",
                "action": self._shell_action(arguments),
                "name": name,
                "input": arguments or {},
            },
        }
        if display_name:
            data["display_name"] = display_name
        return data

    def shell_call_done(
        self,
        call_id: str,
        name: str,
        arguments: Optional[dict] = None,
        status: str = "completed",
    ) -> dict:
        """Create response.output_item.done event for shell call."""
        output_index = self._tool_output_index
        self._tool_output_index += 1
        return {
            "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            "response_id": self.response_id,
            "output_index": output_index,
            "item": {
                "type": "shell_call",
                "id": call_id,
                "call_id": call_id,
                "status": status,
                "action": self._shell_action(arguments),
                "name": name,
                "input": arguments or {},
            },
        }

    # ============================================================
    # Reasoning Events
    # ============================================================

    def reasoning(self, content: str) -> dict:
        """Create response.reasoning_summary_part.added event.

        Args:
            content: Reasoning/thinking content

        Returns:
            Event data dictionary
        """
        return {
            "type": ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
            "response_id": self.response_id,
            "item_id": self.item_id,
            "output_index": self.output_index,
            "part": {
                "type": "reasoning",
                "text": content,
            },
        }
