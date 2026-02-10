# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event type definitions for local executor mode.

Uses OpenAI Responses API event types from shared.models.responses_api.
This ensures consistency across all execution modes (SSE, callback, device).

Socket.IO event names are now based on OpenAI Responses API event types.
"""

# Re-export OpenAI Responses API event types from shared module
from shared.models.responses_api import ResponsesAPIStreamEvents


class DeviceEvents:
    """Device lifecycle events (Socket.IO event names)."""

    REGISTER = "device:register"
    HEARTBEAT = "device:heartbeat"


class TaskEvents:
    """Task execution events (Socket.IO event names).

    These are Wegent-specific events for task lifecycle management.
    """

    EXECUTE = "task:execute"
    COMPLETE = "task:complete"
    CLOSE_SESSION = "task:close-session"


class ChatEvents:
    """Chat streaming events using OpenAI Responses API event types.

    These event names are used as Socket.IO event names and match
    the OpenAI Responses API event types for consistency.
    """

    # Lifecycle events
    START = ResponsesAPIStreamEvents.RESPONSE_CREATED.value
    IN_PROGRESS = ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value
    DONE = ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value
    INCOMPLETE = ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value
    ERROR = ResponsesAPIStreamEvents.ERROR.value

    # Content streaming events
    CHUNK = ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value
    TEXT_DONE = ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value

    # Tool events
    TOOL_START = ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value
    TOOL_DONE = ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value

    # Reasoning events
    THINKING = ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value

    # Output item events
    OUTPUT_ITEM_ADDED = ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value
    OUTPUT_ITEM_DONE = ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value
    CONTENT_PART_ADDED = ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value
    CONTENT_PART_DONE = ResponsesAPIStreamEvents.CONTENT_PART_DONE.value
