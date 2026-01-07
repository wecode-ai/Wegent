# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stream emitters for different output channels.

This module provides unified emitter interfaces for SSE and WebSocket streaming.
Each emitter handles the specific protocol details while sharing common logic.

This is a protocol-agnostic abstraction layer that can be used by different
services (chat, executor, etc.).
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
    This is a protocol-agnostic interface that can be implemented for different
    transport mechanisms (SSE, WebSocket, etc.).
    """

    @abstractmethod
    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """Emit stream start event with shell_type for frontend display logic."""
        pass

    @abstractmethod
    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: dict[str, Any] | None = None,
    ) -> None:
        """Emit a content chunk with optional result data (thinking, workbench).

        Args:
            content: Content chunk (for text streaming)
            offset: Current offset in the full response
            subtask_id: Subtask ID
            result: Optional full result data (for thinking/workbench display)
        """
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

    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """SSE doesn't need explicit start event."""
        pass

    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: dict[str, Any] | None = None,
    ) -> None:
        """Emit chunk as SSE data with optional result."""
        payload = {"content": content, "done": False}
        if result is not None:
            payload["result"] = result
        self._events.append(self.format_sse(payload))

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
    """WebSocket emitter using global ws_emitter for cross-worker broadcasting.

    Uses the global ws_emitter (with Redis adapter) to ensure events are
    broadcast to all backend replicas in multi-instance deployments.
    """

    def __init__(self, namespace: Any, task_room: str, task_id: int):
        """Initialize WebSocket emitter.

        Args:
            namespace: Socket.IO namespace instance (kept for compatibility)
            task_room: Room name for broadcasting events
            task_id: Task ID for emitting events
        """
        self.namespace = namespace
        self.task_room = task_room
        self.task_id = task_id

    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """Emit chat:start event using global emitter with shell_type."""
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        await emitter.emit_chat_start(
            task_id=task_id,
            subtask_id=subtask_id,
            shell_type=shell_type,
        )
        logger.info("[WS_EMITTER] chat:start emitted with shell_type=%s", shell_type)

    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: dict[str, Any] | None = None,
    ) -> None:
        """Emit chat:chunk event using global emitter with optional result data.

        This follows the same pattern as executor tasks to enable thinking/workbench display.
        """
        from app.services.chat.ws_emitter import get_ws_emitter

        logger.debug(
            "[WS_EMITTER] emit_chunk: subtask_id=%d, offset=%d, content_len=%d, has_result=%s",
            subtask_id,
            offset,
            len(content),
            result is not None,
        )
        emitter = get_ws_emitter()
        await emitter.emit_chat_chunk(
            task_id=self.task_id,
            subtask_id=subtask_id,
            content=content,
            offset=offset,
            result=result,
        )

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict[str, Any],
        message_id: int | None = None,
    ) -> None:
        """Emit chat:done event using global emitter."""
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        await emitter.emit_chat_done(
            task_id=task_id,
            subtask_id=subtask_id,
            offset=offset,
            result=result,
            message_id=message_id,
        )
        logger.info("[WS_EMITTER] chat:done emitted message_id=%s", message_id)

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Emit chat:error event using global emitter."""
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        await emitter.emit_chat_error(
            task_id=self.task_id,
            subtask_id=subtask_id,
            error=error,
        )
        logger.warning("[WS_EMITTER] chat:error emitted: %s", error)

    async def emit_cancelled(self, subtask_id: int) -> None:
        """Emit chat:cancelled event using global emitter."""
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        await emitter.emit_chat_cancelled(
            task_id=self.task_id,
            subtask_id=subtask_id,
        )
        logger.info("[WS_EMITTER] chat:cancelled emitted")

    def emit_json(self, data: dict[str, Any]) -> None:
        """Emit JSON data synchronously by scheduling async emit.

        This method is used in synchronous contexts (like tool event callbacks)
        where we need to emit data but can't use await directly.

        Args:
            data: Dictionary data to emit (typically a chunk event)
        """
        import asyncio

        from app.services.chat.ws_emitter import get_main_event_loop, get_ws_emitter

        emitter = get_ws_emitter()
        if emitter is None:
            logger.warning("[WS_EMITTER] emit_json: no emitter available")
            return

        # Extract data for emit_chat_chunk
        subtask_id = data.get("subtask_id", 0)
        content = data.get("content", "")
        offset = data.get("offset", 0)
        result = data.get("result")

        # Get the main event loop
        loop = get_main_event_loop()
        if loop is None:
            logger.warning("[WS_EMITTER] emit_json: no event loop available")
            return

        # Schedule the async emit on the main event loop
        asyncio.run_coroutine_threadsafe(
            emitter.emit_chat_chunk(
                task_id=self.task_id,
                subtask_id=subtask_id,
                content=content,
                offset=offset,
                result=result,
            ),
            loop,
        )
        logger.debug(
            "[WS_EMITTER] emit_json: scheduled chunk emission for subtask=%d",
            subtask_id,
        )
