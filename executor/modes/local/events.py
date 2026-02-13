# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event type definitions for local executor mode.

Keep this module dependency-light because it is imported during local-mode
bootstrap in the PyInstaller binary.
"""


class DeviceEvents:
    """Device lifecycle events (Socket.IO event names)."""

    REGISTER = "device:register"
    HEARTBEAT = "device:heartbeat"


class TaskEvents:
    """Task execution events (Socket.IO event names).

    These are Wegent-specific events for task lifecycle management.
    """

    EXECUTE = "task:execute"
    CANCEL = "task:cancel"
    COMPLETE = "task:complete"
    CLOSE_SESSION = "task:close-session"


class ChatEvents:
    """Chat streaming events (Socket.IO event names)."""

    # Wegent-specific incoming events
    MESSAGE = "chat:message"

    # Lifecycle events
    START = "response.created"
    IN_PROGRESS = "response.in_progress"
    DONE = "response.completed"
    INCOMPLETE = "response.incomplete"
    ERROR = "error"

    # Content streaming events
    CHUNK = "response.output_text.delta"
    TEXT_DONE = "response.output_text.done"

    # Tool events
    TOOL_START = "response.function_call_arguments.delta"
    TOOL_DONE = "response.function_call_arguments.done"

    # Reasoning events
    THINKING = "response.reasoning_summary_part.added"

    # Output item events
    OUTPUT_ITEM_ADDED = "response.output_item.added"
    OUTPUT_ITEM_DONE = "response.output_item.done"
    CONTENT_PART_ADDED = "response.content_part.added"
    CONTENT_PART_DONE = "response.content_part.done"
