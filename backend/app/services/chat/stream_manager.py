# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stream manager for Chat Shell."""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from app.core.config import settings
from app.core.shutdown import shutdown_manager
from app.services.chat.db_handler import db_handler
from app.services.chat.providers.base import ChunkType, StreamChunk
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)

# Registry for background consumer tasks (keyed by subtask_id)
_background_consumer_tasks: dict[int, asyncio.Task] = {}


@dataclass
class StreamState:
    """State for a streaming session."""

    subtask_id: int
    task_id: int
    user_message: Any
    full_response: str = ""
    chunk_count: int = 0
    cancelled: bool = False
    error_info: dict[str, Any] | None = None
    last_redis_save: float = field(default_factory=time.time)
    last_db_save: float = field(default_factory=time.time)


class StreamManager:
    """Manages streaming response lifecycle with background processing."""

    def __init__(self):
        self._redis_interval = settings.STREAMING_REDIS_SAVE_INTERVAL
        self._db_interval = settings.STREAMING_DB_SAVE_INTERVAL
        self._min_chars_to_save = settings.STREAMING_MIN_CHARS_TO_SAVE

    async def create_consumer_task(
        self,
        state: StreamState,
        stream_generator: AsyncGenerator[StreamChunk, None],
        cancel_event: asyncio.Event,
        chunk_queue: asyncio.Queue,
    ) -> asyncio.Task | None:
        """Create a background consumer task for LLM streaming.

        Returns:
            asyncio.Task if successful, None if rejected due to shutdown
        """
        # Register with shutdown manager first
        if not await shutdown_manager.register_stream(state.subtask_id):
            logger.warning(
                "[STREAM] Rejecting new stream during shutdown: subtask_id=%d",
                state.subtask_id,
            )
            return None

        task = asyncio.create_task(
            self._consumer_loop(state, stream_generator, cancel_event, chunk_queue)
        )
        _background_consumer_tasks[state.subtask_id] = task
        return task

    async def _consumer_loop(
        self,
        state: StreamState,
        stream_generator: AsyncGenerator[StreamChunk, None],
        cancel_event: asyncio.Event,
        chunk_queue: asyncio.Queue,
    ) -> None:
        """Background consumer loop that processes LLM stream."""
        try:
            async for chunk in stream_generator:
                state.chunk_count += 1

                # Check for cancellation (user cancel, session cancel, or shutdown)
                if (
                    cancel_event.is_set()
                    or await session_manager.is_cancelled(state.subtask_id)
                    or shutdown_manager.is_shutting_down
                ):
                    state.cancelled = True
                    if shutdown_manager.is_shutting_down:
                        logger.info(
                            "[STREAM] subtask=%s stopping due to server shutdown",
                            state.subtask_id,
                        )
                    break

                if chunk.type == ChunkType.CONTENT and chunk.content:
                    state.full_response += chunk.content
                    await self._handle_content_chunk(state, chunk, chunk_queue)
                elif chunk.type == ChunkType.ERROR:
                    state.error_info = {"type": "error", "message": chunk.error}
                    break

            await self._handle_stream_completion(state, chunk_queue)

        except asyncio.CancelledError:
            await self._handle_task_cancelled(state)
            raise
        except asyncio.TimeoutError:
            state.error_info = {"type": "error", "message": "API call timeout"}
            logger.error("[STREAM] subtask=%s API call timeout", state.subtask_id)
            await self._handle_error(state, "API call timeout")
        except Exception as e:
            state.error_info = {"type": "error", "message": str(e)}
            logger.exception("[STREAM] subtask=%s error", state.subtask_id)
            await self._handle_error(state, str(e))
        finally:
            self._put_queue_safe(chunk_queue, state.error_info)
            self._put_queue_safe(chunk_queue, {"type": "end"})
            _background_consumer_tasks.pop(state.subtask_id, None)
            # Unregister from both session manager and shutdown manager
            await session_manager.unregister_stream(state.subtask_id)
            await shutdown_manager.unregister_stream(state.subtask_id)

    def _put_queue_safe(self, queue: asyncio.Queue, item: Any) -> None:
        """Put item to queue, ignoring if full or None."""
        if item is None:
            return
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            pass

    async def _handle_content_chunk(
        self, state: StreamState, chunk: StreamChunk, chunk_queue: asyncio.Queue
    ) -> None:
        """Handle a content chunk from the stream."""
        current_time = time.time()

        # Incremental save to Redis (high frequency)
        if current_time - state.last_redis_save >= self._redis_interval:
            await session_manager.save_streaming_content(
                state.subtask_id, state.full_response
            )
            state.last_redis_save = current_time

        # Incremental save to database (low frequency)
        if current_time - state.last_db_save >= self._db_interval:
            await db_handler.save_partial_response(
                state.subtask_id, state.full_response, is_streaming=True
            )
            state.last_db_save = current_time

        # Publish chunk to Redis Pub/Sub
        try:
            await session_manager.publish_streaming_chunk(
                state.subtask_id, chunk.content
            )
        except Exception as e:
            logger.warning(
                "[STREAM] subtask=%s failed to publish chunk: %s", state.subtask_id, e
            )

        self._put_queue_safe(chunk_queue, {"type": "chunk", "content": chunk.content})

    async def _handle_stream_completion(
        self, state: StreamState, chunk_queue: asyncio.Queue
    ) -> None:
        """Handle stream completion (success or cancellation)."""
        if state.cancelled:
            logger.info("[STREAM] subtask=%s handling cancellation", state.subtask_id)
            self._put_queue_safe(chunk_queue, {"type": "cancelled"})
            return

        # Normal completion - save everything to DB
        await session_manager.append_user_and_assistant_messages(
            state.task_id, state.user_message, state.full_response
        )

        result = {"value": state.full_response}
        await db_handler.update_subtask_status(
            state.subtask_id, "COMPLETED", result=result
        )
        await session_manager.delete_streaming_content(state.subtask_id)

        try:
            await session_manager.publish_streaming_done(
                state.subtask_id, result=result
            )
        except Exception as e:
            logger.warning(
                "[STREAM] subtask=%s failed to publish done: %s", state.subtask_id, e
            )

        self._put_queue_safe(chunk_queue, {"type": "done", "result": result})

    async def _handle_task_cancelled(self, state: StreamState) -> None:
        """Handle task cancellation (e.g., server shutdown)."""
        if not state.full_response:
            return

        await session_manager.append_user_and_assistant_messages(
            state.task_id, state.user_message, state.full_response
        )
        result = {
            "value": state.full_response,
            "incomplete": True,
            "reason": "server_shutdown",
        }
        await db_handler.update_subtask_status(
            state.subtask_id, "COMPLETED", result=result
        )
        await session_manager.delete_streaming_content(state.subtask_id)

    async def _handle_error(self, state: StreamState, error_msg: str) -> None:
        """Handle stream error."""
        if state.full_response:
            await db_handler.save_partial_response(
                state.subtask_id, state.full_response, is_streaming=False
            )
        await db_handler.update_subtask_status(
            state.subtask_id, "FAILED", error=error_msg
        )

    async def handle_client_disconnect(
        self, subtask_id: int, task_id: int, partial_content: str, user_message: Any
    ) -> None:
        """Handle client disconnect during streaming."""
        logger.info(
            "Handling client disconnect for subtask %s, saved %s chars",
            subtask_id,
            len(partial_content),
        )

        result = {
            "value": partial_content,
            "incomplete": True,
            "reason": "client_disconnect",
        }

        if len(partial_content) >= self._min_chars_to_save:
            await db_handler.save_partial_response(
                subtask_id, partial_content, is_streaming=False
            )
            if partial_content:
                await session_manager.append_user_and_assistant_messages(
                    task_id, user_message, partial_content
                )

        await db_handler.update_subtask_status(subtask_id, "COMPLETED", result=result)
        await session_manager.delete_streaming_content(subtask_id)

    def format_sse_chunk(self, chunk_type: str, data: dict[str, Any]) -> str:
        """Format a chunk as SSE data."""
        return f"data: {json.dumps(data)}\n\n"


# Global stream manager instance
stream_manager = StreamManager()
