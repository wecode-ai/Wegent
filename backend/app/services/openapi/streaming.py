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
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional

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


def _format_sse_event(event_type: str, data: Dict[str, Any]) -> str:
    """
    Format data as Server-Sent Event (SSE).

    Args:
        event_type: Event type (e.g., 'response.created')
        data: Event data dictionary

    Returns:
        Formatted SSE string
    """
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class OpenAPIStreamingService:
    """
    Service for generating OpenAI v1/responses compatible streaming output.

    Converts internal chat streaming responses to the OpenAI SSE event format.
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
        the OpenAI SSE event format.

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
                "response.created",
                {"type": "response.created", "response": initial_response.model_dump()},
            )

            # Event 2: response.output_item.added
            yield _format_sse_event(
                "response.output_item.added",
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {"type": "message", "role": "assistant", "content": []},
                },
            )

            # Event 3: response.content_part.added
            yield _format_sse_event(
                "response.content_part.added",
                {
                    "type": "response.content_part.added",
                    "output_index": 0,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": ""},
                },
            )

            # Stream text deltas
            async for chunk in chat_stream:
                if chunk:
                    accumulated_text += chunk
                    yield _format_sse_event(
                        "response.output_text.delta",
                        {
                            "type": "response.output_text.delta",
                            "output_index": 0,
                            "content_index": 0,
                            "delta": chunk,
                        },
                    )

            # Event: response.output_text.done
            yield _format_sse_event(
                "response.output_text.done",
                {
                    "type": "response.output_text.done",
                    "output_index": 0,
                    "content_index": 0,
                    "text": accumulated_text,
                },
            )

            # Event: response.content_part.done
            yield _format_sse_event(
                "response.content_part.done",
                {
                    "type": "response.content_part.done",
                    "output_index": 0,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": accumulated_text},
                },
            )

            # Event: response.output_item.done
            yield _format_sse_event(
                "response.output_item.done",
                {
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "type": "message",
                        "id": message_id,
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": accumulated_text}],
                    },
                },
            )

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
                "response.completed",
                {"type": "response.completed", "response": final_response.model_dump()},
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
                output=[
                    OutputMessage(
                        id=message_id,
                        status="incomplete",
                        role="assistant",
                        content=[OutputTextContent(text=accumulated_text)],
                    )
                ]
                if accumulated_text
                else [],
                previous_response_id=previous_response_id,
            )
            yield _format_sse_event(
                "response.failed",
                {"type": "response.failed", "response": error_response.model_dump()},
            )


# Global service instance
streaming_service = OpenAPIStreamingService()
