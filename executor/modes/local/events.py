# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event type definitions for local executor mode.

Protocol aligned with LocalDeviceClient for device-based communication.

This module defines:
1. Socket.IO event names (DeviceEvents, TaskEvents, ChatEvents) - used for WebSocket communication
2. Re-exports unified ExecutionEvent and EventType from shared.models.execution
"""

# Re-export unified event types from shared module
from shared.models.execution import EventType, ExecutionEvent


class DeviceEvents:
    """Device lifecycle events (Socket.IO event names)."""

    REGISTER = "device:register"
    HEARTBEAT = "device:heartbeat"


class TaskEvents:
    """Task execution events (Socket.IO event names)."""

    EXECUTE = "task:execute"
    PROGRESS = "task:progress"
    COMPLETE = "task:complete"
    CANCEL = "task:cancel"
    CLOSE_SESSION = "task:close-session"


class ChatEvents:
    """Chat streaming events (Socket.IO event names)."""

    MESSAGE = "chat:message"
    CHUNK = "chat:chunk"
    DONE = "chat:done"
    START = "chat:start"
    ERROR = "chat:error"


# Mapping from EventType to Socket.IO event names
EVENT_TYPE_TO_SOCKET_EVENT = {
    EventType.START: ChatEvents.START,
    EventType.CHUNK: ChatEvents.CHUNK,
    EventType.DONE: ChatEvents.DONE,
    EventType.ERROR: ChatEvents.ERROR,
    EventType.PROGRESS: TaskEvents.PROGRESS,
    EventType.CANCEL: TaskEvents.CANCEL,
    EventType.CANCELLED: TaskEvents.CANCEL,
}
