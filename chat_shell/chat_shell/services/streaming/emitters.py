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


class RedisPublishingEmitter(StreamEmitter):
    """Redis publishing emitter for bridge mode.

    Publishes streaming events to Redis Pub/Sub channel.
    WebSocketBridge subscribes to the channel and forwards events to WebSocket clients.

    This enables the bridge architecture:
    StreamingCore -> RedisPublishingEmitter -> Redis Pub/Sub -> WebSocketBridge -> WebSocket
    """

    def __init__(self, storage_handler: Optional[Any] = None):
        """Initialize Redis publishing emitter.

        Args:
            storage_handler: Storage handler with publish methods (optional, will import default if None)
        """
        self._storage = storage_handler

    def _get_storage(self):
        """Get storage handler, lazily importing if needed."""
        if self._storage is None:
            # Import backend's session_manager which has the publish methods
            try:
                from app.services.chat.storage import session_manager

                self._storage = session_manager
            except ImportError:
                logger.error("[REDIS_EMITTER] Failed to import backend session_manager")
                raise RuntimeError(
                    "Backend session_manager not available for Redis publishing"
                )
        return self._storage

    async def emit_start(
        self, task_id: int, subtask_id: int, shell_type: str = "Chat"
    ) -> None:
        """Publish start event to Redis channel."""
        storage = self._get_storage()
        event = {
            "type": "start",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "shell_type": shell_type,
        }
        await storage.publish_streaming_chunk(subtask_id, json.dumps(event))
        logger.debug("[REDIS_EMITTER] Published start event: subtask_id=%d", subtask_id)

    async def emit_chunk(
        self,
        content: str,
        offset: int,
        subtask_id: int,
        result: Optional[dict] = None,
    ) -> None:
        """Publish chunk event to Redis channel."""
        storage = self._get_storage()
        payload = {
            "type": "chunk",
            "content": content,
            "offset": offset,
            "subtask_id": subtask_id,
        }
        if result is not None:
            payload["result"] = result
        await storage.publish_streaming_chunk(subtask_id, json.dumps(payload))
        logger.debug(
            "[REDIS_EMITTER] Published chunk: subtask_id=%d, content_len=%d",
            subtask_id,
            len(content),
        )

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict,
        message_id: Optional[int] = None,
    ) -> None:
        """Publish done event to Redis channel."""
        storage = self._get_storage()
        payload = {
            "type": "done",
            "task_id": task_id,
            "subtask_id": subtask_id,
            "offset": offset,
            "result": result,
        }
        if message_id is not None:
            payload["message_id"] = message_id
        await storage.publish_streaming_chunk(subtask_id, json.dumps(payload))
        logger.info("[REDIS_EMITTER] Published done event: subtask_id=%d", subtask_id)

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Publish error event to Redis channel."""
        storage = self._get_storage()
        event = {
            "type": "error",
            "subtask_id": subtask_id,
            "error": error,
        }
        await storage.publish_streaming_chunk(subtask_id, json.dumps(event))
        logger.warning(
            "[REDIS_EMITTER] Published error: subtask_id=%d, error=%s",
            subtask_id,
            error,
        )

    async def emit_cancelled(self, subtask_id: int) -> None:
        """Publish cancelled event to Redis channel."""
        storage = self._get_storage()
        event = {
            "type": "cancelled",
            "subtask_id": subtask_id,
        }
        await storage.publish_streaming_chunk(subtask_id, json.dumps(event))
        logger.info(
            "[REDIS_EMITTER] Published cancelled event: subtask_id=%d", subtask_id
        )

    async def emit_thinking(self, subtask_id: int, thinking_data: dict) -> None:
        """Publish thinking event to Redis channel."""
        storage = self._get_storage()
        payload = {
            "type": "thinking",
            "subtask_id": subtask_id,
            **thinking_data,
        }
        await storage.publish_streaming_chunk(subtask_id, json.dumps(payload))
        logger.debug("[REDIS_EMITTER] Published thinking: subtask_id=%d", subtask_id)

    def emit_json(self, data: dict) -> None:
        """Publish arbitrary JSON data to Redis channel.

        This is a sync method for compatibility with tool callbacks.
        We need to run it in the event loop.
        """
        import asyncio

        storage = self._get_storage()
        subtask_id = data.get("subtask_id")
        if subtask_id is None:
            logger.warning("[REDIS_EMITTER] emit_json called without subtask_id")
            return

        # Get the running event loop and schedule the coroutine
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(
                storage.publish_streaming_chunk(subtask_id, json.dumps(data))
            )
            logger.debug(
                "[REDIS_EMITTER] Scheduled JSON publish: subtask_id=%d", subtask_id
            )
        except RuntimeError:
            logger.error("[REDIS_EMITTER] No running event loop for emit_json")


class NullEmitter(StreamEmitter):
    """A no-op emitter that discards all events.

    Used when events are published to Redis channel instead of directly emitted.
    The WebSocketBridge subscribes to the channel and handles WebSocket emission.

    DEPRECATED: Use RedisPublishingEmitter for bridge mode instead.
    This class is kept for backward compatibility only.
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

    def emit_json(self, data: dict) -> None:
        """No-op: event published to Redis channel instead.

        This is a sync method for compatibility with tool callbacks.
        """
        pass
