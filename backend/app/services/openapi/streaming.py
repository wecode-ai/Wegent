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
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

from app.schemas.openapi_response import (
    OutputMessage,
    OutputTextContent,
    ResponseError,
    ResponseObject,
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


@dataclass
class StreamingChunk:
    """A chunk of streaming data, either text or reasoning."""

    type: str  # "text" or "reasoning"
    content: str


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
        accumulated_reasoning = ""
        sequence_number = 0
        reasoning_started = False
        reasoning_complete = False
        output_index = 0

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

            # Process stream chunks
            async for chunk in chat_stream:
                if chunk is None:
                    continue

                # Handle StreamingChunk objects
                if isinstance(chunk, StreamingChunk):
                    if chunk.type == "reasoning":
                        # Start reasoning output if not started
                        if not reasoning_started:
                            reasoning_started = True
                            output_index = 0
                            # Official OpenAI event: response.reasoning_summary_part.added
                            yield _format_sse_event(
                                {
                                    "item": {
                                        "id": _generate_message_id(),
                                        "object": "response.output_item",
                                        "status": "in_progress",
                                        "summary": [],
                                        "type": "reasoning",
                                    },
                                    "output_index": output_index,
                                    "sequence_number": sequence_number,
                                    "type": "response.reasoning_summary_part.added",
                                }
                            )
                            sequence_number += 1

                        # Accumulate reasoning content
                        if chunk.content and not reasoning_complete:
                            accumulated_reasoning += chunk.content
                            # Official OpenAI event: response.reasoning_summary_text.delta
                            yield _format_sse_event(
                                {
                                    "content_index": 0,
                                    "delta": chunk.content,
                                    "item_id": message_id,
                                    "output_index": output_index,
                                    "sequence_number": sequence_number,
                                    "type": "response.reasoning_summary_text.delta",
                                }
                            )
                            sequence_number += 1

                    elif chunk.type == "text":
                        # Handle text content
                        if chunk.content:
                            # If we had reasoning before, close it first
                            if reasoning_started and not reasoning_complete:
                                reasoning_complete = True
                                output_index += 1
                                # Note: OpenAI doesn't have explicit reasoning "done" event
                                # We transition directly to text output

                            accumulated_text += chunk.content

                            # Start text output if this is the first text chunk
                            if output_index == 0 or (
                                reasoning_started and output_index == 1
                            ):
                                if output_index == 0:
                                    output_index = 0

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
                                        "output_index": output_index,
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
                                        "output_index": output_index,
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
                                    "output_index": output_index,
                                    "sequence_number": sequence_number,
                                    "type": "response.output_text.delta",
                                }
                            )
                            sequence_number += 1

                else:
                    # Handle plain string (backward compatibility)
                    if chunk:
                        accumulated_text += chunk
                        # Official OpenAI event: response.output_text.delta
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

            # Close text output items
            if accumulated_text:
                # Official OpenAI event: response.output_text.done
                yield _format_sse_event(
                    {
                        "content_index": 0,
                        "item_id": message_id,
                        "output_index": output_index,
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
                        "output_index": output_index,
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
                        "output_index": output_index,
                        "sequence_number": sequence_number,
                        "type": "response.output_item.done",
                    }
                )
                sequence_number += 1

            # Build final output items
            output_items = []
            if accumulated_reasoning:
                output_items.append(
                    OutputMessage(
                        id=_generate_message_id(),
                        status="completed",
                        role="assistant",
                        content=[{"type": "reasoning", "text": accumulated_reasoning}],
                    )
                )
            if accumulated_text:
                output_items.append(
                    OutputMessage(
                        id=message_id,
                        status="completed",
                        role="assistant",
                        content=[OutputTextContent(text=accumulated_text)],
                    )
                )

            # Official OpenAI event: response.completed
            final_response = ResponseObject(
                id=response_id,
                created_at=created_at,
                status="completed",
                model=model_string,
                output=output_items,
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
