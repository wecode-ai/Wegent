# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend Stream Handler for processing chat_shell SSE streams.

This module provides BackendStreamHandler that:
- Receives SSE streams from chat_shell HTTP service
- Accumulates full_response content
- Periodically saves to Redis (for reconnection support)
- Periodically saves to DB (for persistence)
- Detects cancellation signals and terminates early
- Forwards events to WebSocket clients

This handler is used when chat_shell runs as a separate HTTP service
and Backend needs to consume its SSE output.

Usage:
    handler = BackendStreamHandler(
        subtask_id=123,
        task_id=456,
        session_manager=session_manager,
        ws_emitter=ws_emitter,
    )
    result = await handler.process_sse_stream(sse_stream, cancel_event)
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class SSEEvent:
    """Parsed SSE event."""

    event: str
    data: dict[str, Any]


@dataclass
class StreamHandlerConfig:
    """Configuration for BackendStreamHandler."""

    redis_save_interval: float = field(
        default_factory=lambda: getattr(settings, "STREAMING_REDIS_SAVE_INTERVAL", 1.0)
    )
    db_save_interval: float = field(
        default_factory=lambda: getattr(settings, "STREAMING_DB_SAVE_INTERVAL", 3.0)
    )


class BackendStreamHandler:
    """Handler for processing chat_shell SSE streams in Backend.

    This handler is the Backend-side counterpart to chat_shell's HTTP mode.
    It receives SSE events from chat_shell and:
    - Accumulates the streaming content
    - Manages cancellation detection
    - Handles periodic persistence
    - Forwards events to WebSocket clients

    Attributes:
        subtask_id: The subtask ID for this stream
        task_id: The task ID for this stream
        full_response: Accumulated response content
        thinking: Tool call steps
        sources: Knowledge base sources
        reasoning_content: Reasoning content from DeepSeek R1 etc.
    """

    def __init__(
        self,
        subtask_id: int,
        task_id: int,
        user_id: int,
        user_name: str,
        task_room: str,
        namespace: Any,  # Socket.IO namespace
        config: Optional[StreamHandlerConfig] = None,
    ):
        """Initialize BackendStreamHandler.

        Args:
            subtask_id: Subtask ID for this stream
            task_id: Task ID for this stream
            user_id: User ID who triggered the stream
            user_name: Username for display
            task_room: WebSocket room name for broadcasting
            namespace: Socket.IO namespace for emitting events
            config: Optional handler configuration
        """
        self.subtask_id = subtask_id
        self.task_id = task_id
        self.user_id = user_id
        self.user_name = user_name
        self.task_room = task_room
        self.namespace = namespace
        self.config = config or StreamHandlerConfig()

        # Accumulation state
        self.full_response: str = ""
        self.thinking: list[dict[str, Any]] = []
        self.sources: list[dict[str, Any]] = []
        self.reasoning_content: str = ""
        self.offset: int = 0

        # Timing state
        self._last_redis_save: float = 0
        self._last_db_save: float = 0

        # Will be set by session_manager
        self._cancel_event: Optional[asyncio.Event] = None

    async def process_sse_stream(
        self,
        sse_stream: AsyncIterator[SSEEvent],
        cancel_event: asyncio.Event,
    ) -> dict[str, Any]:
        """Process SSE stream from chat_shell.

        Args:
            sse_stream: Async iterator yielding SSEEvent objects
            cancel_event: Event to signal cancellation

        Returns:
            Final result dictionary with full_response and metadata
        """
        from app.services.chat.storage import session_manager, storage_handler

        self._cancel_event = cancel_event

        try:
            async for event in sse_stream:
                # Check for cancellation
                if self._is_cancelled():
                    await self._handle_cancel()
                    break

                # Check Redis for cross-worker cancellation
                if await session_manager.is_cancelled(self.subtask_id):
                    self._cancel_event.set()
                    await self._handle_cancel()
                    break

                # Process event based on type
                event_type = event.event
                data = event.data

                if event_type == "content.delta":
                    await self._handle_content_delta(data)
                elif event_type == "thinking.delta":
                    await self._handle_thinking_delta(data)
                elif event_type == "reasoning.delta":
                    await self._handle_reasoning_delta(data)
                elif event_type == "tool.start":
                    await self._handle_tool_start(data)
                elif event_type == "tool.progress":
                    await self._handle_tool_progress(data)
                elif event_type == "tool.done":
                    await self._handle_tool_done(data)
                elif event_type == "sources.update":
                    await self._handle_sources_update(data)
                elif event_type == "response.done":
                    await self._handle_response_done(data)
                    break
                elif event_type == "response.cancelled":
                    await self._handle_response_cancelled(data)
                    break
                elif event_type == "error":
                    await self._handle_error(data)
                    break
                else:
                    logger.debug(
                        "[STREAM_HANDLER] Unknown event type: %s",
                        event_type,
                    )

            return self._build_result()

        finally:
            # Cleanup Redis cache
            await session_manager.delete_streaming_content(self.subtask_id)

    def _is_cancelled(self) -> bool:
        """Check if stream has been cancelled."""
        return self._cancel_event is not None and self._cancel_event.is_set()

    def _build_result(self) -> dict[str, Any]:
        """Build final result dictionary."""
        result: dict[str, Any] = {
            "value": self.full_response,
        }
        if self.thinking:
            result["thinking"] = self.thinking
        if self.sources:
            result["sources"] = self.sources
        if self.reasoning_content:
            result["reasoning_content"] = self.reasoning_content
        return result

    async def _handle_content_delta(self, data: dict[str, Any]) -> None:
        """Handle content delta event."""
        content = data.get("text", "")
        self.full_response += content
        self.offset += len(content)

        # Emit to WebSocket
        await self._emit_chunk(content)

        # Periodic saves
        await self._periodic_save()

    async def _handle_thinking_delta(self, data: dict[str, Any]) -> None:
        """Handle thinking delta event (DeepSeek etc.)."""
        # Forward to WebSocket
        await self._emit_event(
            "chat:thinking",
            {
                "subtask_id": self.subtask_id,
                "text": data.get("text", ""),
            },
        )

    async def _handle_reasoning_delta(self, data: dict[str, Any]) -> None:
        """Handle reasoning delta event (DeepSeek R1 format)."""
        content = data.get("text", "")
        self.reasoning_content += content

        # Forward to WebSocket
        await self._emit_event(
            "chat:reasoning",
            {
                "subtask_id": self.subtask_id,
                "text": content,
            },
        )

    async def _handle_tool_start(self, data: dict[str, Any]) -> None:
        """Handle tool start event."""
        tool_step = {
            "id": data.get("id"),
            "name": data.get("name"),
            "display_name": data.get("display_name"),
            "input": data.get("input"),
            "status": "running",
        }
        self.thinking.append(tool_step)

        # Forward to WebSocket
        await self._emit_event(
            "chat:tool_start",
            {
                "subtask_id": self.subtask_id,
                **data,
            },
        )

    async def _handle_tool_progress(self, data: dict[str, Any]) -> None:
        """Handle tool progress event."""
        # Forward to WebSocket
        await self._emit_event(
            "chat:tool_progress",
            {
                "subtask_id": self.subtask_id,
                **data,
            },
        )

    async def _handle_tool_done(self, data: dict[str, Any]) -> None:
        """Handle tool done event."""
        tool_id = data.get("id")

        # Update thinking step
        for step in self.thinking:
            if step.get("id") == tool_id:
                step["output"] = data.get("output")
                step["duration_ms"] = data.get("duration_ms")
                step["status"] = "completed"
                if data.get("error"):
                    step["error"] = data["error"]
                    step["status"] = "failed"
                # Update title if display_name is provided (for failed tools)
                if data.get("display_name"):
                    step["title"] = data["display_name"]
                break

        # Add sources from tool output if present
        if sources := data.get("sources"):
            self._add_sources(sources)

        # Forward to WebSocket
        await self._emit_event(
            "chat:tool_done",
            {
                "subtask_id": self.subtask_id,
                **data,
            },
        )

    async def _handle_sources_update(self, data: dict[str, Any]) -> None:
        """Handle sources update event (knowledge base citations)."""
        if sources := data.get("sources"):
            self._add_sources(sources)

        # Forward to WebSocket
        await self._emit_event(
            "chat:sources",
            {
                "subtask_id": self.subtask_id,
                "sources": self.sources,
            },
        )

    async def _handle_response_done(self, data: dict[str, Any]) -> None:
        """Handle response done event."""
        from app.services.chat.storage import storage_handler

        # Extract usage info
        usage = data.get("usage", {})
        stop_reason = data.get("stop_reason")

        # Build final result
        result = self._build_result()
        result["usage"] = usage
        result["stop_reason"] = stop_reason

        # Save final result to DB
        await storage_handler.update_subtask_status(
            self.subtask_id,
            "COMPLETED",
            result=result,
        )

        # Emit done to WebSocket
        await self._emit_event(
            "chat:done",
            {
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "result": result,
            },
        )

        logger.info(
            "[STREAM_HANDLER] Response done: subtask_id=%d, response_len=%d",
            self.subtask_id,
            len(self.full_response),
        )

    async def _handle_response_cancelled(self, data: dict[str, Any]) -> None:
        """Handle response cancelled event."""
        from app.services.chat.storage import storage_handler

        # Build partial result
        result = self._build_result()
        result["cancelled"] = True
        partial_content = data.get("partial_content", self.full_response)

        # Save to DB as COMPLETED (with partial content)
        await storage_handler.update_subtask_status(
            self.subtask_id,
            "COMPLETED",
            result=result,
        )

        # Emit cancelled to WebSocket
        await self._emit_event(
            "chat:cancelled",
            {
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "partial_content": partial_content,
            },
        )

        logger.info(
            "[STREAM_HANDLER] Response cancelled: subtask_id=%d",
            self.subtask_id,
        )

    async def _handle_cancel(self) -> None:
        """Handle local cancellation signal."""
        from app.services.chat.storage import storage_handler

        result = self._build_result()
        result["cancelled"] = True

        # Save partial result
        await storage_handler.update_subtask_status(
            self.subtask_id,
            "COMPLETED",
            result=result,
        )

        # Emit cancelled
        await self._emit_event(
            "chat:cancelled",
            {
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "partial_content": self.full_response,
            },
        )

        logger.info(
            "[STREAM_HANDLER] Cancelled locally: subtask_id=%d",
            self.subtask_id,
        )

    async def _handle_error(self, data: dict[str, Any]) -> None:
        """Handle error event."""
        from app.services.chat.storage import storage_handler

        error_code = data.get("code", "unknown")
        error_message = data.get("message", "Unknown error")
        error_details = data.get("details")

        # Save error to DB
        await storage_handler.update_subtask_status(
            self.subtask_id,
            "FAILED",
            error=f"{error_code}: {error_message}",
        )

        # Emit error to WebSocket
        await self._emit_event(
            "chat:error",
            {
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "error": error_message,
                "code": error_code,
                "details": error_details,
            },
        )

        logger.error(
            "[STREAM_HANDLER] Error: subtask_id=%d, code=%s, message=%s",
            self.subtask_id,
            error_code,
            error_message,
        )

    def _add_sources(self, sources: list[dict[str, Any]]) -> None:
        """Add sources avoiding duplicates."""
        existing_keys = {(s.get("kb_id"), s.get("title")) for s in self.sources}
        for source in sources:
            key = (source.get("kb_id"), source.get("title"))
            if key not in existing_keys:
                self.sources.append(source)
                existing_keys.add(key)

    async def _emit_chunk(self, content: str) -> None:
        """Emit content chunk to WebSocket."""
        await self._emit_event(
            "chat:chunk",
            {
                "subtask_id": self.subtask_id,
                "chunk": content,
                "offset": self.offset - len(content),
            },
        )

    async def _emit_event(self, event_name: str, data: dict[str, Any]) -> None:
        """Emit event to WebSocket room."""
        try:
            await self.namespace.emit(
                event_name,
                data,
                room=self.task_room,
            )
        except Exception as e:
            logger.error(
                "[STREAM_HANDLER] Failed to emit %s: %s",
                event_name,
                e,
            )

    async def _periodic_save(self) -> None:
        """Perform periodic saves to Redis and DB."""
        from app.services.chat.storage import session_manager, storage_handler

        current_time = time.time()

        # Save to Redis (for reconnection)
        if current_time - self._last_redis_save >= self.config.redis_save_interval:
            await session_manager.save_streaming_content(
                self.subtask_id,
                self.full_response,
            )
            self._last_redis_save = current_time

        # Save to DB
        if current_time - self._last_db_save >= self.config.db_save_interval:
            result = self._build_result()
            result["streaming"] = True
            await storage_handler.update_subtask_status(
                self.subtask_id,
                "RUNNING",
                result=result,
            )
            self._last_db_save = current_time


async def parse_sse_lines(
    lines: AsyncIterator[str],
) -> AsyncIterator[SSEEvent]:
    """Parse SSE lines into SSEEvent objects.

    Args:
        lines: Async iterator of SSE text lines

    Yields:
        SSEEvent objects
    """
    event_type = "message"
    data_lines: list[str] = []

    async for line in lines:
        line = line.strip()

        if not line:
            # Empty line signals end of event
            if data_lines:
                try:
                    data_str = "\n".join(data_lines)
                    data = json.loads(data_str)
                    yield SSEEvent(event=event_type, data=data)
                except json.JSONDecodeError as e:
                    logger.warning(
                        "[SSE_PARSE] Failed to parse SSE data: %s, error: %s",
                        data_str[:100],
                        e,
                    )
                # Reset for next event
                event_type = "message"
                data_lines = []
            continue

        if line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
        elif line.startswith(":"):
            # Comment line, ignore
            pass
        else:
            # Unknown line format
            logger.debug("[SSE_PARSE] Unknown line format: %s", line[:50])
