# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SSE Emitter for Chat Shell streaming responses.

This module provides the SSE-specific event emitter that formats
streaming events for Server-Sent Events protocol.
"""

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class StreamEvent:
    """Represents a streaming event to be emitted."""

    type: str  # "chunk", "done", "error", "cancelled", "start", "thinking", "tool"
    content: str = ""
    offset: int = 0
    subtask_id: Optional[int] = None
    task_id: Optional[int] = None
    result: Optional[dict] = None
    error: Optional[str] = None


class StreamEmitter(ABC):
    """Abstract base class for stream emitters."""

    @abstractmethod
    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """Emit stream start event."""
        pass

    @abstractmethod
    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: Optional[dict] = None,
    ) -> None:
        """Emit a content chunk."""
        pass

    @abstractmethod
    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit stream completion event."""
        pass

    @abstractmethod
    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Emit error event."""
        pass

    @abstractmethod
    async def emit_cancelled(self, subtask_id: int) -> None:
        """Emit cancellation event."""
        pass

    @abstractmethod
    async def emit_thinking(self, subtask_id: int, thinking_data: dict) -> None:
        """Emit thinking/tool step event."""
        pass


class SSEEmitter(StreamEmitter):
    """Server-Sent Events emitter for HTTP streaming.

    Formats events as SSE data lines for HTTP streaming responses.
    Events are queued and can be retrieved for streaming.
    """

    def __init__(self):
        """Initialize SSE emitter."""
        self._events: list[str] = []

    @staticmethod
    def format_sse(data: dict) -> str:
        """Format data as SSE event string."""
        return f"data: {json.dumps(data)}\n\n"

    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """Emit start event."""
        self._events.append(
            self.format_sse(
                {
                    "type": "start",
                    "task_id": task_id,
                    "subtask_id": subtask_id,
                    "shell_type": shell_type,
                }
            )
        )

    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: Optional[dict] = None,
    ) -> None:
        """Emit chunk as SSE data."""
        payload = {
            "type": "chunk",
            "content": content,
            "offset": offset,
            "subtask_id": subtask_id,
        }
        if result is not None:
            payload["result"] = result
        self._events.append(self.format_sse(payload))

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit done event as SSE data."""
        payload = {
            "type": "done",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "offset": offset,
            "result": result,
        }
        if message_id is not None:
            payload["message_id"] = message_id
        self._events.append(self.format_sse(payload))

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Emit error as SSE data."""
        self._events.append(
            self.format_sse(
                {
                    "type": "error",
                    "subtask_id": subtask_id,
                    "error": error,
                }
            )
        )

    async def emit_cancelled(self, subtask_id: int) -> None:
        """Emit cancellation as SSE data."""
        self._events.append(
            self.format_sse(
                {
                    "type": "cancelled",
                    "subtask_id": subtask_id,
                }
            )
        )

    async def emit_thinking(self, subtask_id: int, thinking_data: dict) -> None:
        """Emit thinking/tool step as SSE data."""
        payload = {
            "type": "thinking",
            "subtask_id": subtask_id,
            **thinking_data,
        }
        self._events.append(self.format_sse(payload))

    def emit_json(self, data: dict) -> None:
        """Emit arbitrary JSON data as SSE event.

        This is a sync method for compatibility with tool callbacks.
        """
        self._events.append(self.format_sse(data))

    def get_event(self) -> Optional[str]:
        """Get and remove the next event from the queue."""
        if self._events:
            return self._events.pop(0)
        return None

    def has_events(self) -> bool:
        """Check if there are pending events."""
        return len(self._events) > 0

    def get_all_events(self) -> list[str]:
        """Get and clear all pending events."""
        events = self._events.copy()
        self._events.clear()
        return events


class NullEmitter(StreamEmitter):
    """A no-op emitter that discards all events.

    Used when events are published to Redis channel instead of directly emitted.
    The WebSocketBridge subscribes to the channel and handles WebSocket emission.
    """

    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """No-op: event published to Redis channel instead."""
        pass

    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: Optional[dict] = None,
    ) -> None:
        """No-op: event published to Redis channel instead."""
        pass

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict,
        message_id: Optional[int] = None,
    ) -> None:
        """No-op: event published to Redis channel instead."""
        pass

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """No-op: event published to Redis channel instead."""
        pass

    async def emit_cancelled(self, subtask_id: int) -> None:
        """No-op: event published to Redis channel instead."""
        pass

    async def emit_thinking(self, subtask_id: int, thinking_data: dict) -> None:
        """No-op: event published to Redis channel instead."""
        pass
