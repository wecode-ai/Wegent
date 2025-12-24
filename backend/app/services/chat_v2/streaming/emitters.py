# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stream emitters for different output channels.

This module provides unified emitter interfaces for SSE and WebSocket streaming.
Each emitter handles the specific protocol details while sharing common logic.
"""

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class StreamEvent:
    """Represents a streaming event to be emitted."""

    type: str  # "chunk", "done", "error", "cancelled", "start"
    content: str = ""
    offset: int = 0
    subtask_id: int | None = None
    task_id: int | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


class StreamEmitter(ABC):
    """Abstract base class for stream emitters.

    Defines the interface for emitting streaming events to different channels.
    """

    @abstractmethod
    async def emit_start(self, task_id: int, subtask_id: int) -> None:
        """Emit stream start event."""
        pass

    @abstractmethod
    async def emit_chunk(self, content: str, offset: int, subtask_id: int) -> None:
        """Emit a content chunk."""
        pass

    @abstractmethod
    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict[str, Any],
        message_id: int | None = None,
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


class SSEEmitter(StreamEmitter):
    """Server-Sent Events emitter.

    Formats events as SSE data lines for HTTP streaming responses.
    """

    def __init__(self):
        """Initialize SSE emitter."""
        self._events: list[str] = []

    @staticmethod
    def format_sse(data: dict[str, Any]) -> str:
        """Format data as SSE event string."""
        return f"data: {json.dumps(data)}\n\n"

    async def emit_start(self, task_id: int, subtask_id: int) -> None:
        """SSE doesn't need explicit start event."""
        pass

    async def emit_chunk(self, content: str, offset: int, subtask_id: int) -> None:
        """Emit chunk as SSE data."""
        self._events.append(self.format_sse({"content": content, "done": False}))

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict[str, Any],
        message_id: int | None = None,
    ) -> None:
        """Emit done event as SSE data."""
        self._events.append(
            self.format_sse({"content": "", "done": True, "result": result})
        )

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Emit error as SSE data."""
        self._events.append(self.format_sse({"error": error}))

    async def emit_cancelled(self, subtask_id: int) -> None:
        """Emit cancellation as SSE data."""
        self._events.append(
            self.format_sse({"content": "", "done": True, "cancelled": True})
        )

    def get_event(self) -> str | None:
        """Get and remove the next event from the queue."""
        if self._events:
            return self._events.pop(0)
        return None

    def has_events(self) -> bool:
        """Check if there are pending events."""
        return len(self._events) > 0


class WebSocketEmitter(StreamEmitter):
    """WebSocket emitter using Socket.IO namespace.

    Emits events through a Socket.IO namespace to a specific room.
    """

    def __init__(self, namespace: Any, task_room: str):
        """Initialize WebSocket emitter.

        Args:
            namespace: Socket.IO namespace instance
            task_room: Room name for broadcasting events
        """
        self.namespace = namespace
        self.task_room = task_room

    async def emit_start(self, task_id: int, subtask_id: int) -> None:
        """Emit chat:start event."""
        from app.api.ws.events import ServerEvents

        await self.namespace.emit(
            ServerEvents.CHAT_START,
            {"task_id": task_id, "subtask_id": subtask_id},
            room=self.task_room,
        )
        logger.info("[WS_EMITTER] chat:start emitted")

    async def emit_chunk(self, content: str, offset: int, subtask_id: int) -> None:
        """Emit chat:chunk event."""
        from app.api.ws.events import ServerEvents

        logger.debug(
            "[WS_EMITTER] emit_chunk: subtask_id=%d, offset=%d, content_len=%d",
            subtask_id,
            offset,
            len(content),
        )
        await self.namespace.emit(
            ServerEvents.CHAT_CHUNK,
            {"subtask_id": subtask_id, "content": content, "offset": offset},
            room=self.task_room,
        )

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict[str, Any],
        message_id: int | None = None,
    ) -> None:
        """Emit chat:done event."""
        from app.api.ws.events import ServerEvents

        await self.namespace.emit(
            ServerEvents.CHAT_DONE,
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "offset": offset,
                "result": result,
                "message_id": message_id,
            },
            room=self.task_room,
        )
        logger.info("[WS_EMITTER] chat:done emitted message_id=%s", message_id)

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Emit chat:error event."""
        from app.api.ws.events import ServerEvents

        await self.namespace.emit(
            ServerEvents.CHAT_ERROR,
            {"subtask_id": subtask_id, "error": error},
            room=self.task_room,
        )
        logger.warning("[WS_EMITTER] chat:error emitted: %s", error)

    async def emit_cancelled(self, subtask_id: int) -> None:
        """Emit chat:cancelled event."""
        from app.api.ws.events import ServerEvents

        await self.namespace.emit(
            ServerEvents.CHAT_CANCELLED,
            {"subtask_id": subtask_id},
            room=self.task_room,
        )
        logger.info("[WS_EMITTER] chat:cancelled emitted")
