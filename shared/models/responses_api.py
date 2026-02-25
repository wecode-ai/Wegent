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
- ResponsesAPIStreamEvents: Event type enum (from LiteLLM)
- ResponsesAPIEventBuilder: Stateful builder for creating events with minimal parameters
"""

import json
import time
import uuid
from typing import Any, Optional

# Import LiteLLM's OpenAI Responses API types for standardized events
from litellm.types.llms.openai import (
    ResponsesAPIStreamEvents,
    ResponsesAPIStreamingResponse,
)

__all__ = [
    # LiteLLM types (re-exported)
    "ResponsesAPIStreamEvents",
    "ResponsesAPIStreamingResponse",
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
        delta = json.dumps(arguments) if arguments else ""
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
        args_str = json.dumps(arguments) if arguments else ""
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
        args_str = json.dumps(arguments) if arguments else ""
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
