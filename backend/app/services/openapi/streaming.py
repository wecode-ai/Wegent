# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses streaming service.

This module provides streaming response generation in OpenAI v1/responses SSE format.
It converts internal chat streaming to the OpenAI-compatible event format.
"""

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

from app.schemas.openapi_response import (
    FunctionCallOutputItem,
    MCPCallOutputItem,
    OutputMessage,
    OutputTextContent,
    ResponseError,
    ResponseObject,
    ShellCallOutputItem,
)
from app.services.openapi.output_builder import normalize_tool_output

logger = logging.getLogger(__name__)


def _generate_response_id() -> str:
    """Generate a unique response ID."""
    return f"resp_{uuid.uuid4().hex[:12]}"


def _generate_message_id() -> str:
    """Generate a unique message ID."""
    return f"msg_{uuid.uuid4().hex[:12]}"


def _format_sse_event(data: Dict[str, Any]) -> str:
    """
    Format data as Server-Sent Event (SSE).

    Args:
        data: Event data dictionary

    Returns:
        Formatted SSE string (data only, without event line)
    """
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _build_shell_call_action(arguments: Dict[str, Any]) -> Dict[str, Any]:
    action = {
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


def _build_shell_call_item(
    call_id: str,
    name: str,
    arguments: Dict[str, Any],
    *,
    status: str,
) -> Dict[str, Any]:
    return {
        "type": "shell_call",
        "id": call_id,
        "call_id": call_id,
        "status": status,
        "action": _build_shell_call_action(arguments),
        "name": name,
        "input": arguments,
    }


@dataclass
class StreamingChunk:
    """A chunk of streaming data for Responses API streaming."""

    type: str
    content: str = ""
    data: Dict[str, Any] = field(default_factory=dict)


class OpenAPIStreamingService:
    """
    Service for generating OpenAI v1/responses compatible streaming output.

    Converts internal chat streaming responses to the OpenAI SSE event format.
    Follows OpenAI Responses API specification:
    https://platform.openai.com/docs/api-reference/responses-streaming
    """

    def __init__(self):
        self._active_streams: Dict[str, bool] = {}

    async def create_streaming_response(
        self,
        response_id: str,
        model_string: str,
        chat_stream: AsyncGenerator[Union[str, StreamingChunk], None],
        created_at: Optional[int] = None,
        previous_response_id: Optional[str] = None,
        task_context: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Create a streaming response generator in OpenAI v1/responses format.

        This method wraps an internal chat stream and converts it to
        the OpenAI SSE event format.

        Args:
            response_id: Response ID (format: resp_{task_id})
            model_string: Model string from request
            chat_stream: Async generator yielding text chunks or StreamingChunk objects
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
        next_output_index = 0
        message_started = False
        message_output_index: Optional[int] = None
        reasoning_segments: List[Dict[str, Any]] = []
        current_reasoning_segment: Optional[Dict[str, Any]] = None
        tool_output_indexes: Dict[str, int] = {}
        completed_output_items: Dict[int, Any] = {}
        response_blocks: Dict[str, Dict[str, Any]] = {}

        def allocate_output_index() -> int:
            nonlocal next_output_index
            assigned = next_output_index
            next_output_index += 1
            return assigned

        def get_tool_output_index(tool_key: str) -> int:
            if tool_key not in tool_output_indexes:
                tool_output_indexes[tool_key] = allocate_output_index()
            return tool_output_indexes[tool_key]

        def pop_tool_output_index(tool_key: str) -> int:
            existing = tool_output_indexes.pop(tool_key, None)
            if existing is not None:
                return existing
            return allocate_output_index()

        def ensure_reasoning_segment() -> tuple[Dict[str, Any], bool]:
            nonlocal current_reasoning_segment
            if current_reasoning_segment is not None:
                return current_reasoning_segment, False

            current_reasoning_segment = {
                "output_index": allocate_output_index(),
                "item_id": _generate_message_id(),
                "content": "",
            }
            reasoning_segments.append(current_reasoning_segment)
            return current_reasoning_segment, True

        def close_reasoning_segment() -> None:
            nonlocal current_reasoning_segment
            current_reasoning_segment = None

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

            if task_context:
                yield _format_sse_event(
                    {
                        "type": "response.task_context",
                        "response_id": response_id,
                        **task_context,
                    }
                )

            # Process stream chunks
            async for chunk in chat_stream:
                if chunk is None:
                    continue
                if isinstance(chunk, str):
                    chunk = StreamingChunk(type="text", content=chunk)

                # Handle StreamingChunk objects
                if isinstance(chunk, StreamingChunk):
                    if chunk.type == "reasoning":
                        segment, created = ensure_reasoning_segment()
                        if created:
                            # Official OpenAI event: response.reasoning_summary_part.added
                            yield _format_sse_event(
                                {
                                    "item": {
                                        "id": segment["item_id"],
                                        "object": "response.output_item",
                                        "status": "in_progress",
                                        "summary": [],
                                        "type": "reasoning",
                                    },
                                    "output_index": segment["output_index"],
                                    "sequence_number": sequence_number,
                                    "type": "response.reasoning_summary_part.added",
                                }
                            )
                            sequence_number += 1

                        # Accumulate reasoning content
                        if chunk.content:
                            segment["content"] += chunk.content
                            # Official OpenAI event: response.reasoning_summary_text.delta
                            yield _format_sse_event(
                                {
                                    "content_index": 0,
                                    "delta": chunk.content,
                                    "item_id": segment["item_id"],
                                    "output_index": segment["output_index"],
                                    "sequence_number": sequence_number,
                                    "type": "response.reasoning_summary_text.delta",
                                }
                            )
                            sequence_number += 1

                    elif chunk.type == "text":
                        # Handle text content
                        if chunk.content:
                            close_reasoning_segment()

                            accumulated_text += chunk.content

                            # Start text output if this is the first text chunk
                            if not message_started:
                                message_started = True
                                message_output_index = allocate_output_index()
                                # Official OpenAI event: response.output_item.added
                                yield _format_sse_event(
                                    {
                                        "item": {
                                            "content": [],
                                            "id": message_id,
                                            "role": "assistant",
                                            "status": "in_progress",
                                            "type": "message",
                                        },
                                        "output_index": message_output_index,
                                        "sequence_number": sequence_number,
                                        "type": "response.output_item.added",
                                    }
                                )
                                sequence_number += 1

                                # Official OpenAI event: response.content_part.added
                                yield _format_sse_event(
                                    {
                                        "content_index": 0,
                                        "item_id": message_id,
                                        "output_index": message_output_index,
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

                            # Official OpenAI event: response.output_text.delta
                            yield _format_sse_event(
                                {
                                    "content_index": 0,
                                    "delta": chunk.content,
                                    "item_id": message_id,
                                    "output_index": message_output_index,
                                    "sequence_number": sequence_number,
                                    "type": "response.output_text.delta",
                                }
                            )
                            sequence_number += 1
                    elif chunk.type == "function_call_added":
                        close_reasoning_segment()
                        call_id = chunk.data["call_id"]
                        name = chunk.data["name"]
                        arguments = chunk.data.get("arguments") or ""
                        tool_output_index = get_tool_output_index(f"function:{call_id}")
                        yield _format_sse_event(
                            {
                                "type": "response.output_item.added",
                                "response_id": response_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "item": {
                                    "type": "function_call",
                                    "id": call_id,
                                    "call_id": call_id,
                                    "name": name,
                                    "arguments": arguments,
                                },
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "function_call_done":
                        close_reasoning_segment()
                        call_id = chunk.data["call_id"]
                        name = chunk.data["name"]
                        arguments = chunk.data.get("arguments") or ""
                        tool_output_index = pop_tool_output_index(f"function:{call_id}")
                        completed_output_items[tool_output_index] = (
                            FunctionCallOutputItem(
                                id=call_id,
                                call_id=call_id,
                                name=name,
                                arguments=arguments,
                            )
                        )
                        yield _format_sse_event(
                            {
                                "type": "response.function_call_arguments.done",
                                "response_id": response_id,
                                "item_id": call_id,
                                "call_id": call_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "arguments": arguments,
                            }
                        )
                        sequence_number += 1
                        yield _format_sse_event(
                            {
                                "type": "response.output_item.done",
                                "response_id": response_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "item": {
                                    "type": "function_call",
                                    "id": call_id,
                                    "call_id": call_id,
                                    "name": name,
                                    "arguments": arguments,
                                },
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "shell_call_added":
                        close_reasoning_segment()
                        call_id = chunk.data["call_id"]
                        name = chunk.data["name"]
                        arguments = chunk.data.get("arguments") or {}
                        tool_output_index = get_tool_output_index(f"shell:{call_id}")
                        yield _format_sse_event(
                            {
                                "type": "response.output_item.added",
                                "response_id": response_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "item": _build_shell_call_item(
                                    call_id,
                                    name,
                                    arguments,
                                    status="in_progress",
                                ),
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "shell_call_done":
                        close_reasoning_segment()
                        call_id = chunk.data["call_id"]
                        name = chunk.data["name"]
                        arguments = chunk.data.get("arguments") or {}
                        tool_output_index = pop_tool_output_index(f"shell:{call_id}")
                        completed_output_items[tool_output_index] = (
                            ShellCallOutputItem.model_validate(
                                _build_shell_call_item(
                                    call_id,
                                    name,
                                    arguments,
                                    status=chunk.data.get("status", "completed"),
                                )
                            )
                        )
                        yield _format_sse_event(
                            {
                                "type": "response.output_item.done",
                                "response_id": response_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "item": _build_shell_call_item(
                                    call_id,
                                    name,
                                    arguments,
                                    status=chunk.data.get("status", "completed"),
                                ),
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "mcp_call_added":
                        close_reasoning_segment()
                        item_id = chunk.data["item_id"]
                        name = chunk.data["name"]
                        server_label = chunk.data["server_label"]
                        tool_output_index = get_tool_output_index(f"mcp:{item_id}")
                        yield _format_sse_event(
                            {
                                "type": "response.output_item.added",
                                "response_id": response_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "item": {
                                    "type": "mcp_call",
                                    "id": item_id,
                                    "name": name,
                                    "server_label": server_label,
                                    "arguments": "",
                                },
                            }
                        )
                        sequence_number += 1
                        yield _format_sse_event(
                            {
                                "type": "response.mcp_call.in_progress",
                                "response_id": response_id,
                                "item_id": item_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "mcp_call_done":
                        close_reasoning_segment()
                        item_id = chunk.data["item_id"]
                        name = chunk.data["name"]
                        server_label = chunk.data["server_label"]
                        arguments = chunk.data.get("arguments") or ""
                        tool_output = normalize_tool_output(chunk.data.get("output"))
                        tool_output_index = pop_tool_output_index(f"mcp:{item_id}")
                        completed_output_items[tool_output_index] = MCPCallOutputItem(
                            id=item_id,
                            name=name,
                            server_label=server_label,
                            arguments=arguments,
                            status=(
                                "failed"
                                if chunk.data.get("status") == "failed"
                                else "completed"
                            ),
                            output=tool_output,
                        )
                        yield _format_sse_event(
                            {
                                "type": "response.mcp_call_arguments.done",
                                "response_id": response_id,
                                "item_id": item_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "arguments": arguments,
                            }
                        )
                        sequence_number += 1
                        terminal_type = (
                            "response.mcp_call.failed"
                            if chunk.data.get("status") == "failed"
                            else "response.mcp_call.completed"
                        )
                        terminal_payload = {
                            "type": terminal_type,
                            "response_id": response_id,
                            "item_id": item_id,
                            "output_index": tool_output_index,
                            "sequence_number": sequence_number,
                        }
                        if chunk.data.get("status") == "failed" and chunk.data.get(
                            "error"
                        ):
                            terminal_payload["failure_reason"] = chunk.data["error"]
                        if tool_output is not None:
                            terminal_payload["output"] = tool_output
                        yield _format_sse_event(terminal_payload)
                        sequence_number += 1
                        item_payload = {
                            "type": "mcp_call",
                            "id": item_id,
                            "name": name,
                            "server_label": server_label,
                            "arguments": arguments,
                            "status": (
                                "failed"
                                if chunk.data.get("status") == "failed"
                                else "completed"
                            ),
                        }
                        if tool_output is not None:
                            item_payload["output"] = tool_output
                        yield _format_sse_event(
                            {
                                "type": "response.output_item.done",
                                "response_id": response_id,
                                "output_index": tool_output_index,
                                "sequence_number": sequence_number,
                                "item": item_payload,
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "block_created":
                        close_reasoning_segment()
                        block = chunk.data.get("block")
                        if not isinstance(block, dict) or not block.get("id"):
                            continue
                        block_id = str(block["id"])
                        response_blocks[block_id] = dict(block)
                        yield _format_sse_event(
                            {
                                "type": "response.block.created",
                                "response_id": response_id,
                                "sequence_number": sequence_number,
                                "block": block,
                            }
                        )
                        sequence_number += 1
                    elif chunk.type == "block_updated":
                        close_reasoning_segment()
                        block_id = chunk.data.get("block_id")
                        updates = chunk.data.get("updates")
                        if not block_id or not isinstance(updates, dict):
                            continue
                        block_id = str(block_id)
                        if block_id in response_blocks:
                            response_blocks[block_id].update(updates)
                        yield _format_sse_event(
                            {
                                "type": "response.block.updated",
                                "response_id": response_id,
                                "sequence_number": sequence_number,
                                "block_id": block_id,
                                "updates": updates,
                            }
                        )
                        sequence_number += 1

            # Close text output items
            if accumulated_text:
                # Official OpenAI event: response.output_text.done
                yield _format_sse_event(
                    {
                        "content_index": 0,
                        "item_id": message_id,
                        "output_index": message_output_index,
                        "sequence_number": sequence_number,
                        "text": accumulated_text,
                        "type": "response.output_text.done",
                    }
                )
                sequence_number += 1

                # Official OpenAI event: response.content_part.done
                yield _format_sse_event(
                    {
                        "content_index": 0,
                        "item_id": message_id,
                        "output_index": message_output_index,
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

                # Official OpenAI event: response.output_item.done
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
                        "output_index": message_output_index,
                        "sequence_number": sequence_number,
                        "type": "response.output_item.done",
                    }
                )
                sequence_number += 1

            # Build final output items
            for segment in reasoning_segments:
                if not segment["content"]:
                    continue
                completed_output_items[segment["output_index"]] = OutputMessage(
                    id=segment["item_id"],
                    status="completed",
                    role="assistant",
                    content=[
                        OutputTextContent(
                            type="reasoning",
                            text=segment["content"],
                            annotations=[],
                        )
                    ],
                )
            if accumulated_text and message_output_index is not None:
                completed_output_items[message_output_index] = OutputMessage(
                    id=message_id,
                    status="completed",
                    role="assistant",
                    content=[OutputTextContent(text=accumulated_text)],
                )
            output_items = [
                completed_output_items[index]
                for index in sorted(completed_output_items.keys())
            ]

            # Official OpenAI event: response.completed
            final_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="completed",
                model=model_string,
                output=output_items,
                previous_response_id=previous_response_id,
            )
            final_response_data = final_response.model_dump()
            if response_blocks:
                final_response_data["blocks"] = list(response_blocks.values())
            yield _format_sse_event(
                {
                    "response": final_response_data,
                    "sequence_number": sequence_number,
                    "type": "response.completed",
                }
            )

        except NotImplementedError:
            raise
        except Exception as e:
            logger.exception(f"Error during streaming response: {e}")
            # Official OpenAI event: response.failed (or error)
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


# Global service instance
streaming_service = OpenAPIStreamingService()
