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
from functools import partial
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

from app.core.payload_codec import run_payload_codec
from app.schemas.openapi_response import (
    FunctionCallOutputItem,
    MCPCallOutputItem,
    OutputMessage,
    OutputTextContent,
    ResponseError,
    ResponseObject,
    ShellCallOutputItem,
)
from app.services.openapi.output_builder import (
    build_generation_output_item_from_block,
    normalize_tool_output,
)

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


async def _encode_sse_event(data: Dict[str, Any]) -> str:
    return await run_payload_codec(
        _format_sse_event,
        data,
        payload_hint=data,
        force_offload=True,
    )


def _join_text_chunks(chunks: List[str]) -> str:
    return "".join(chunks)


def _store_response_block_created(
    response_blocks: Dict[str, Dict[str, Any]],
    block: Any,
) -> bool:
    if not isinstance(block, dict) or not block.get("id"):
        return False
    response_blocks[str(block["id"])] = dict(block)
    return True


def _store_response_block_updated(
    response_blocks: Dict[str, Dict[str, Any]],
    block_id: Any,
    updates: Any,
) -> tuple[str, bool]:
    if not block_id or not isinstance(updates, dict):
        return "", False
    normalized_id = str(block_id)
    if normalized_id in response_blocks:
        response_blocks[normalized_id].update(updates)
    return normalized_id, True


def _build_completed_stream_projection(
    *,
    response_id: str,
    created_at: int,
    model_string: str,
    previous_response_id: Optional[str],
    message_id: str,
    message_output_index: Optional[int],
    accumulated_text_chunks: List[str],
    reasoning_segments: List[Dict[str, Any]],
    completed_output_items: Dict[int, Any],
    response_blocks: Dict[str, Dict[str, Any]],
) -> tuple[str, ResponseObject, List[Dict[str, Any]]]:
    accumulated_text = _join_text_chunks(accumulated_text_chunks)
    for segment in reasoning_segments:
        reasoning_content = _join_text_chunks(segment["content_chunks"])
        if not reasoning_content:
            continue
        completed_output_items[segment["output_index"]] = OutputMessage(
            id=segment["item_id"],
            status="completed",
            role="assistant",
            content=[
                OutputTextContent(
                    type="reasoning",
                    text=reasoning_content,
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
        completed_output_items[index] for index in sorted(completed_output_items.keys())
    ]
    blocks = list(response_blocks.values())
    for block in blocks:
        generation_item = build_generation_output_item_from_block(block)
        if generation_item is not None:
            output_items.append(generation_item)
    return (
        accumulated_text,
        ResponseObject(
            id=response_id,
            created_at=created_at,
            status="completed",
            model=model_string,
            output=output_items,
            previous_response_id=previous_response_id,
        ),
        blocks,
    )


def _build_failed_stream_response(
    *,
    response_id: str,
    created_at: int,
    model_string: str,
    previous_response_id: Optional[str],
    message_id: str,
    accumulated_text_chunks: List[str],
    error_message: str,
) -> ResponseObject:
    accumulated_text = _join_text_chunks(accumulated_text_chunks)
    return ResponseObject(
        id=response_id,
        created_at=created_at,
        status="failed",
        error=ResponseError(code="stream_error", message=error_message),
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


def _format_response_sse_event(
    response: ResponseObject,
    sequence_number: int,
    event_type: str,
    blocks: List[Dict[str, Any]] | None = None,
) -> str:
    response_data = response.model_dump()
    if blocks:
        response_data["blocks"] = blocks
    return _format_sse_event(
        {
            "response": response_data,
            "sequence_number": sequence_number,
            "type": event_type,
        }
    )


async def _encode_response_sse_event(
    response: ResponseObject,
    sequence_number: int,
    event_type: str,
    blocks: List[Dict[str, Any]] | None = None,
) -> str:
    return await run_payload_codec(
        _format_response_sse_event,
        response,
        sequence_number,
        event_type,
        blocks,
        payload_hint=response,
        force_offload=True,
    )


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
        accumulated_text_chunks: List[str] = []
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
                "content_chunks": [],
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
            yield await _encode_response_sse_event(
                initial_response,
                sequence_number,
                "response.created",
            )
            sequence_number += 1

            # Event 2: response.in_progress
            yield await _encode_response_sse_event(
                initial_response,
                sequence_number,
                "response.in_progress",
            )
            sequence_number += 1

            if task_context:
                yield await _encode_sse_event(
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
                            yield await _encode_sse_event(
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
                            segment["content_chunks"].append(chunk.content)
                            # Official OpenAI event: response.reasoning_summary_text.delta
                            yield await _encode_sse_event(
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

                            accumulated_text_chunks.append(chunk.content)

                            # Start text output if this is the first text chunk
                            if not message_started:
                                message_started = True
                                message_output_index = allocate_output_index()
                                # Official OpenAI event: response.output_item.added
                                yield await _encode_sse_event(
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
                                yield await _encode_sse_event(
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
                            yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(
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
                        tool_output = await run_payload_codec(
                            normalize_tool_output,
                            chunk.data.get("output"),
                            payload_hint=chunk.data.get("output"),
                            force_offload=True,
                        )
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
                        yield await _encode_sse_event(
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
                        yield await _encode_sse_event(terminal_payload)
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
                        yield await _encode_sse_event(
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
                        stored = await run_payload_codec(
                            _store_response_block_created,
                            response_blocks,
                            block,
                            payload_hint=(response_blocks, block),
                            force_offload=True,
                        )
                        if not stored:
                            continue
                        yield await _encode_sse_event(
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
                        block_id, stored = await run_payload_codec(
                            _store_response_block_updated,
                            response_blocks,
                            block_id,
                            updates,
                            payload_hint=(response_blocks, updates),
                            force_offload=True,
                        )
                        if not stored:
                            continue
                        yield await _encode_sse_event(
                            {
                                "type": "response.block.updated",
                                "response_id": response_id,
                                "sequence_number": sequence_number,
                                "block_id": block_id,
                                "updates": updates,
                            }
                        )
                        sequence_number += 1

            accumulated_text, final_response, final_blocks = await run_payload_codec(
                partial(
                    _build_completed_stream_projection,
                    response_id=response_id,
                    created_at=created_at,
                    model_string=model_string,
                    previous_response_id=previous_response_id,
                    message_id=message_id,
                    message_output_index=message_output_index,
                    accumulated_text_chunks=accumulated_text_chunks,
                    reasoning_segments=reasoning_segments,
                    completed_output_items=completed_output_items,
                    response_blocks=response_blocks,
                ),
                payload_hint=(
                    accumulated_text_chunks,
                    reasoning_segments,
                    completed_output_items,
                    response_blocks,
                ),
                force_offload=True,
            )

            # Close text output items
            if accumulated_text:
                # Official OpenAI event: response.output_text.done
                yield await _encode_sse_event(
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
                yield await _encode_sse_event(
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
                yield await _encode_sse_event(
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

            # Official OpenAI event: response.completed
            yield await _encode_response_sse_event(
                final_response,
                sequence_number,
                "response.completed",
                final_blocks,
            )

        except NotImplementedError:
            raise
        except Exception as e:
            logger.exception(f"Error during streaming response: {e}")
            # Official OpenAI event: response.failed (or error)
            error_response = await run_payload_codec(
                partial(
                    _build_failed_stream_response,
                    response_id=response_id,
                    created_at=created_at,
                    model_string=model_string,
                    previous_response_id=previous_response_id,
                    message_id=message_id,
                    accumulated_text_chunks=accumulated_text_chunks,
                    error_message=str(e),
                ),
                payload_hint=(accumulated_text_chunks, e),
                force_offload=True,
            )
            yield await _encode_response_sse_event(
                error_response,
                sequence_number,
                "response.failed",
            )


# Global service instance
streaming_service = OpenAPIStreamingService()
