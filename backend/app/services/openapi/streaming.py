# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses streaming service.

This module provides streaming response generation in OpenAI v1/responses SSE format.
It converts internal chat streaming to the OpenAI-compatible event format.

Supports all OpenAI response output types:
- message: Text output from the model
- mcp_call: MCP server tool calls (all server-side tool execution uses this type)
- reasoning: Chain of thought reasoning
- web_search_call: Web search results
- And more (see ResponseOutputItem union type)

Note: function_call type is NOT used for server-side tools because OpenAI API treats
function_call as "client should execute this function". All server-executed tools
are reported as mcp_call to prevent client SDKs from trying to execute them.
"""

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

from app.schemas.openapi_response import (
    McpCall,
    OutputMessage,
    OutputTextContent,
    ReasoningItem,
    ResponseError,
    ResponseObject,
    WebSearchToolCall,
)

logger = logging.getLogger(__name__)


class StreamEventType(str, Enum):
    """Types of stream events from chat response handler."""

    TEXT_CHUNK = "text_chunk"
    REASONING_CHUNK = "reasoning_chunk"
    TOOL_START = "tool_start"
    TOOL_PROGRESS = "tool_progress"
    TOOL_DONE = "tool_done"
    SOURCES_UPDATE = "sources_update"
    DONE = "done"
    ERROR = "error"


@dataclass
class StreamEvent:
    """Internal stream event structure.

    Used to pass structured events from chat_response.py to streaming.py.
    """

    type: StreamEventType
    data: Dict[str, Any] = field(default_factory=dict)


def _generate_response_id() -> str:
    """Generate a unique response ID."""
    return f"resp_{uuid.uuid4().hex[:12]}"


def _generate_message_id() -> str:
    """Generate a unique message ID."""
    return f"msg_{uuid.uuid4().hex[:12]}"


def _generate_item_id() -> str:
    """Generate a unique output item ID."""
    return f"item_{uuid.uuid4().hex[:12]}"


def _format_sse_event(data: Dict[str, Any]) -> str:
    """
    Format data as Server-Sent Event (SSE).

    Args:
        data: Event data dictionary

    Returns:
        Formatted SSE string (data only, without event line)
    """
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@dataclass
class OutputItemState:
    """State for tracking an output item during streaming."""

    item_id: str
    output_index: int
    item_type: str  # "message", "function_call", "mcp_call", "reasoning", etc.
    status: str = "in_progress"
    data: Dict[str, Any] = field(default_factory=dict)


class OpenAPIStreamingService:
    """
    Service for generating OpenAI v1/responses compatible streaming output.

    Converts internal chat streaming responses to the OpenAI SSE event format.
    Supports multiple output items including messages, tool calls, and reasoning.
    """

    def __init__(self):
        self._active_streams: Dict[str, bool] = {}

    async def create_streaming_response(
        self,
        response_id: str,
        model_string: str,
        chat_stream: AsyncGenerator[str, None],
        created_at: Optional[int] = None,
        previous_response_id: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Create a streaming response generator in OpenAI v1/responses format.

        This method wraps an internal chat stream and converts it to
        the OpenAI SSE event format. For backward compatibility, accepts
        plain text chunks (as strings).

        Args:
            response_id: Response ID (format: resp_{task_id})
            model_string: Model string from request
            chat_stream: Async generator yielding text chunks
            created_at: Unix timestamp (defaults to now)
            previous_response_id: Optional previous response ID

        Yields:
            SSE formatted events
        """
        if created_at is None:
            created_at = int(datetime.now().timestamp())

        message_id = _generate_message_id()
        accumulated_text = ""
        sequence_number = 0

        try:
            # Event 1: response.created
            initial_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="in_progress",
                model=model_string,
                output=[],
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                {
                    "response": initial_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.created",
                }
            )
            sequence_number += 1

            # Event 2: response.in_progress
            yield _format_sse_event(
                {
                    "response": initial_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.in_progress",
                }
            )
            sequence_number += 1

            # Event 3: response.output_item.added
            yield _format_sse_event(
                {
                    "item": {
                        "content": [],
                        "id": message_id,
                        "role": "assistant",
                        "status": "in_progress",
                        "type": "message",
                    },
                    "output_index": 0,
                    "sequence_number": sequence_number,
                    "type": "response.output_item.added",
                }
            )
            sequence_number += 1

            # Event 4: response.content_part.added
            yield _format_sse_event(
                {
                    "content_index": 0,
                    "item_id": message_id,
                    "output_index": 0,
                    "part": {
                        "annotations": [],
                        "text": "",
                        "type": "output_text",
                    },
                    "sequence_number": sequence_number,
                    "type": "response.content_part.added",
                }
            )
            sequence_number += 1

            # Stream text deltas
            async for chunk in chat_stream:
                if chunk:
                    accumulated_text += chunk
                    yield _format_sse_event(
                        {
                            "content_index": 0,
                            "delta": chunk,
                            "item_id": message_id,
                            "output_index": 0,
                            "sequence_number": sequence_number,
                            "type": "response.output_text.delta",
                        }
                    )
                    sequence_number += 1

            # Event: response.output_text.done
            yield _format_sse_event(
                {
                    "content_index": 0,
                    "item_id": message_id,
                    "output_index": 0,
                    "sequence_number": sequence_number,
                    "text": accumulated_text,
                    "type": "response.output_text.done",
                }
            )
            sequence_number += 1

            # Event: response.content_part.done
            yield _format_sse_event(
                {
                    "content_index": 0,
                    "item_id": message_id,
                    "output_index": 0,
                    "part": {
                        "annotations": [],
                        "text": accumulated_text,
                        "type": "output_text",
                    },
                    "sequence_number": sequence_number,
                    "type": "response.content_part.done",
                }
            )
            sequence_number += 1

            # Event: response.output_item.done
            yield _format_sse_event(
                {
                    "item": {
                        "content": [
                            {
                                "annotations": [],
                                "text": accumulated_text,
                                "type": "output_text",
                            }
                        ],
                        "id": message_id,
                        "role": "assistant",
                        "status": "completed",
                        "type": "message",
                    },
                    "output_index": 0,
                    "sequence_number": sequence_number,
                    "type": "response.output_item.done",
                }
            )
            sequence_number += 1

            # Event: response.completed
            final_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="completed",
                model=model_string,
                output=[
                    OutputMessage(
                        id=message_id,
                        status="completed",
                        role="assistant",
                        content=[OutputTextContent(text=accumulated_text)],
                    )
                ],
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                {
                    "response": final_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.completed",
                }
            )

        except Exception as e:
            logger.exception(f"Error during streaming response: {e}")
            # Event: response.failed
            error_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="failed",
                error=ResponseError(code="stream_error", message=str(e)),
                model=model_string,
                output=(
                    [
                        OutputMessage(
                            id=message_id,
                            status="incomplete",
                            role="assistant",
                            content=[OutputTextContent(text=accumulated_text)],
                        )
                    ]
                    if accumulated_text
                    else []
                ),
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                {
                    "response": error_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.failed",
                }
            )

    async def create_multi_output_streaming_response(
        self,
        response_id: str,
        model_string: str,
        event_stream: AsyncGenerator[StreamEvent, None],
        created_at: Optional[int] = None,
        previous_response_id: Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Create a streaming response generator supporting multiple output types.

        This method handles structured events including tool calls, reasoning,
        and text content, emitting proper OpenAI SSE events for each.

        Args:
            response_id: Response ID (format: resp_{task_id})
            model_string: Model string from request
            event_stream: Async generator yielding StreamEvent objects
            created_at: Unix timestamp (defaults to now)
            previous_response_id: Optional previous response ID

        Yields:
            SSE formatted events
        """
        if created_at is None:
            created_at = int(datetime.now().timestamp())

        sequence_number = 0

        # Track all output items: message (text), tool calls, reasoning
        output_items: List[OutputItemState] = []
        message_item: Optional[OutputItemState] = None
        reasoning_item: Optional[OutputItemState] = None
        tool_items: Dict[str, OutputItemState] = {}  # keyed by tool call id

        # Accumulated content
        accumulated_text = ""
        accumulated_reasoning = ""

        try:
            # Event 1: response.created
            initial_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="in_progress",
                model=model_string,
                output=[],
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                {
                    "response": initial_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.created",
                }
            )
            sequence_number += 1

            # Event 2: response.in_progress
            yield _format_sse_event(
                {
                    "response": initial_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.in_progress",
                }
            )
            sequence_number += 1

            async for event in event_stream:
                if event.type == StreamEventType.TEXT_CHUNK:
                    # Handle text content
                    text = event.data.get("content", "")
                    if not text:
                        continue

                    # Create message item if not exists
                    if message_item is None:
                        message_item = OutputItemState(
                            item_id=_generate_message_id(),
                            output_index=len(output_items),
                            item_type="message",
                            data={"content": ""},
                        )
                        output_items.append(message_item)

                        # Emit output_item.added for message
                        yield _format_sse_event(
                            {
                                "item": {
                                    "content": [],
                                    "id": message_item.item_id,
                                    "role": "assistant",
                                    "status": "in_progress",
                                    "type": "message",
                                },
                                "output_index": message_item.output_index,
                                "sequence_number": sequence_number,
                                "type": "response.output_item.added",
                            }
                        )
                        sequence_number += 1

                        # Emit content_part.added
                        yield _format_sse_event(
                            {
                                "content_index": 0,
                                "item_id": message_item.item_id,
                                "output_index": message_item.output_index,
                                "part": {
                                    "annotations": [],
                                    "text": "",
                                    "type": "output_text",
                                },
                                "sequence_number": sequence_number,
                                "type": "response.content_part.added",
                            }
                        )
                        sequence_number += 1

                    # Emit text delta
                    accumulated_text += text
                    message_item.data["content"] = accumulated_text

                    yield _format_sse_event(
                        {
                            "content_index": 0,
                            "delta": text,
                            "item_id": message_item.item_id,
                            "output_index": message_item.output_index,
                            "sequence_number": sequence_number,
                            "type": "response.output_text.delta",
                        }
                    )
                    sequence_number += 1

                elif event.type == StreamEventType.REASONING_CHUNK:
                    # Handle reasoning content
                    text = event.data.get("content", "")
                    if not text:
                        continue

                    # Create reasoning item if not exists
                    if reasoning_item is None:
                        reasoning_item = OutputItemState(
                            item_id=_generate_item_id(),
                            output_index=len(output_items),
                            item_type="reasoning",
                            data={"content": ""},
                        )
                        output_items.append(reasoning_item)

                        # Emit output_item.added for reasoning
                        yield _format_sse_event(
                            {
                                "item": {
                                    "id": reasoning_item.item_id,
                                    "type": "reasoning",
                                    "summary": [],
                                    "status": "in_progress",
                                },
                                "output_index": reasoning_item.output_index,
                                "sequence_number": sequence_number,
                                "type": "response.output_item.added",
                            }
                        )
                        sequence_number += 1

                    # Emit reasoning delta
                    accumulated_reasoning += text
                    reasoning_item.data["content"] = accumulated_reasoning

                    yield _format_sse_event(
                        {
                            "delta": text,
                            "item_id": reasoning_item.item_id,
                            "output_index": reasoning_item.output_index,
                            "sequence_number": sequence_number,
                            "type": "response.reasoning.delta",
                        }
                    )
                    sequence_number += 1

                elif event.type == StreamEventType.TOOL_START:
                    # Handle tool call start
                    tool_id = event.data.get("id", _generate_item_id())
                    tool_name = event.data.get("name", "unknown")
                    tool_input = event.data.get("input", {})
                    display_name = event.data.get("display_name", tool_name)

                    # Determine tool type based on name pattern
                    is_web_search = (
                        "web_search" in tool_name.lower()
                        or "search" in tool_name.lower()
                    )

                    # Use mcp_call for all server-executed tools (not function_call)
                    # function_call type makes client SDK try to execute the function
                    tool_type = "web_search_call" if is_web_search else "mcp_call"

                    tool_item = OutputItemState(
                        item_id=tool_id,
                        output_index=len(output_items),
                        item_type=tool_type,
                        data={
                            "name": tool_name,
                            "arguments": (
                                json.dumps(tool_input)
                                if isinstance(tool_input, dict)
                                else str(tool_input)
                            ),
                            "display_name": display_name,
                        },
                    )
                    tool_items[tool_id] = tool_item
                    output_items.append(tool_item)

                    # Build item based on type
                    if tool_type == "mcp_call":
                        item_data = {
                            "id": tool_id,
                            "name": tool_name,
                            "arguments": tool_item.data["arguments"],
                            "server_label": display_name,
                            "status": "calling",
                            "type": "mcp_call",
                        }
                    else:  # web_search_call
                        item_data = {
                            "id": tool_id,
                            "status": "searching",
                            "type": "web_search_call",
                        }

                    # Emit output_item.added for tool
                    yield _format_sse_event(
                        {
                            "item": item_data,
                            "output_index": tool_item.output_index,
                            "sequence_number": sequence_number,
                            "type": "response.output_item.added",
                        }
                    )
                    sequence_number += 1

                elif event.type == StreamEventType.TOOL_DONE:
                    # Handle tool call completion
                    tool_id = event.data.get("id", "")
                    tool_output = event.data.get("output", "")
                    tool_error = event.data.get("error")

                    if tool_id in tool_items:
                        tool_item = tool_items[tool_id]
                        tool_item.status = "failed" if tool_error else "completed"
                        tool_item.data["output"] = tool_output
                        if tool_error:
                            tool_item.data["error"] = tool_error

                        # Build completed item
                        if tool_item.item_type == "mcp_call":
                            item_data = {
                                "id": tool_item.item_id,
                                "name": tool_item.data.get("name", ""),
                                "arguments": tool_item.data.get("arguments", "{}"),
                                "server_label": tool_item.data.get("display_name", ""),
                                "status": tool_item.status,
                                "output": (
                                    json.dumps(tool_output)
                                    if not isinstance(tool_output, str)
                                    else tool_output
                                ),
                                "type": "mcp_call",
                            }
                            if tool_error:
                                item_data["error"] = tool_error

                            # Emit output_item.done for mcp_call
                            yield _format_sse_event(
                                {
                                    "item": item_data,
                                    "output_index": tool_item.output_index,
                                    "sequence_number": sequence_number,
                                    "type": "response.output_item.done",
                                }
                            )
                            sequence_number += 1

                        else:  # web_search_call
                            item_data = {
                                "id": tool_item.item_id,
                                "status": tool_item.status,
                                "type": "web_search_call",
                            }

                            # Emit output_item.done
                            yield _format_sse_event(
                                {
                                    "item": item_data,
                                    "output_index": tool_item.output_index,
                                    "sequence_number": sequence_number,
                                    "type": "response.output_item.done",
                                }
                            )
                            sequence_number += 1

                elif event.type == StreamEventType.DONE:
                    # Stream completed - finalize all items
                    break

                elif event.type == StreamEventType.ERROR:
                    # Handle error
                    error_msg = event.data.get("error", "Unknown error")
                    raise Exception(error_msg)

            # Finalize message item if exists
            if message_item:
                # Emit output_text.done
                yield _format_sse_event(
                    {
                        "content_index": 0,
                        "item_id": message_item.item_id,
                        "output_index": message_item.output_index,
                        "sequence_number": sequence_number,
                        "text": accumulated_text,
                        "type": "response.output_text.done",
                    }
                )
                sequence_number += 1

                # Emit content_part.done
                yield _format_sse_event(
                    {
                        "content_index": 0,
                        "item_id": message_item.item_id,
                        "output_index": message_item.output_index,
                        "part": {
                            "annotations": [],
                            "text": accumulated_text,
                            "type": "output_text",
                        },
                        "sequence_number": sequence_number,
                        "type": "response.content_part.done",
                    }
                )
                sequence_number += 1

                # Emit output_item.done for message
                message_item.status = "completed"
                yield _format_sse_event(
                    {
                        "item": {
                            "content": [
                                {
                                    "annotations": [],
                                    "text": accumulated_text,
                                    "type": "output_text",
                                }
                            ],
                            "id": message_item.item_id,
                            "role": "assistant",
                            "status": "completed",
                            "type": "message",
                        },
                        "output_index": message_item.output_index,
                        "sequence_number": sequence_number,
                        "type": "response.output_item.done",
                    }
                )
                sequence_number += 1

            # Finalize reasoning item if exists
            if reasoning_item:
                reasoning_item.status = "completed"
                yield _format_sse_event(
                    {
                        "item": {
                            "id": reasoning_item.item_id,
                            "type": "reasoning",
                            "summary": [
                                {
                                    "type": "summary_text",
                                    "text": (
                                        accumulated_reasoning[:500] + "..."
                                        if len(accumulated_reasoning) > 500
                                        else accumulated_reasoning
                                    ),
                                }
                            ],
                            "status": "completed",
                        },
                        "output_index": reasoning_item.output_index,
                        "sequence_number": sequence_number,
                        "type": "response.output_item.done",
                    }
                )
                sequence_number += 1

            # Build final output array
            final_output: List[Any] = []

            for item in output_items:
                if item.item_type == "message":
                    final_output.append(
                        OutputMessage(
                            id=item.item_id,
                            status="completed",
                            role="assistant",
                            content=[OutputTextContent(text=accumulated_text)],
                        )
                    )
                elif item.item_type == "mcp_call":
                    # Add mcp_call item for server-executed tools
                    final_output.append(
                        McpCall(
                            id=item.item_id,
                            name=item.data.get("name", ""),
                            arguments=item.data.get("arguments", "{}"),
                            server_label=item.data.get("display_name", ""),
                            status=(
                                "completed" if item.status == "completed" else "failed"
                            ),
                            output=(
                                json.dumps(item.data.get("output", ""))
                                if not isinstance(item.data.get("output", ""), str)
                                else item.data.get("output", "")
                            ),
                            error=item.data.get("error"),
                        )
                    )
                elif item.item_type == "web_search_call":
                    final_output.append(
                        WebSearchToolCall(
                            id=item.item_id,
                            status=(
                                "completed" if item.status == "completed" else "failed"
                            ),
                        )
                    )
                elif item.item_type == "reasoning":
                    final_output.append(
                        ReasoningItem(
                            id=item.item_id,
                            summary=[
                                {
                                    "type": "summary_text",
                                    "text": (
                                        accumulated_reasoning[:500] + "..."
                                        if len(accumulated_reasoning) > 500
                                        else accumulated_reasoning
                                    ),
                                }
                            ],
                            status="completed",
                        )
                    )

            # Event: response.completed
            final_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="completed",
                model=model_string,
                output=final_output,
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                {
                    "response": final_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.completed",
                }
            )

        except Exception as e:
            logger.exception(f"Error during multi-output streaming response: {e}")

            # Build partial output
            partial_output: List[Any] = []
            if message_item and accumulated_text:
                partial_output.append(
                    OutputMessage(
                        id=message_item.item_id,
                        status="incomplete",
                        role="assistant",
                        content=[OutputTextContent(text=accumulated_text)],
                    )
                )

            # Event: response.failed
            error_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="failed",
                error=ResponseError(code="stream_error", message=str(e)),
                model=model_string,
                output=partial_output,
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                {
                    "response": error_response.model_dump(),
                    "sequence_number": sequence_number,
                    "type": "response.failed",
                }
            )


# Global service instance
streaming_service = OpenAPIStreamingService()
