# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Executor streaming service.

Handles streaming events from Claude Code and Agno executors,
manages Redis state, emits WebSocket events, and persists to database.
"""

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskStatus
from app.schemas.streaming import (
    StreamingEventRequest,
    StreamingEventResponse,
    StreamingEventType,
    StreamingStateData,
)
from app.services.executor_streaming.state import executor_streaming_state

logger = logging.getLogger(__name__)

# Database save interval (seconds) - save to DB every 5 seconds during streaming
DB_SAVE_INTERVAL = 5.0

# Redis save interval (seconds) - save to Redis every 1 second
REDIS_SAVE_INTERVAL = 1.0

# Stale entry timeout (seconds) - cleanup tracking entries older than 1 hour
STALE_ENTRY_TIMEOUT = 3600.0


class ExecutorStreamingService:
    """
    Service for handling executor streaming events.

    Processes streaming events from Claude Code and Agno executors,
    manages state in Redis, emits WebSocket events, and handles
    database persistence.
    """

    def __init__(self):
        self._state_manager = executor_streaming_state
        # Track last DB save times per subtask
        self._last_db_save_times: Dict[int, float] = {}
        # Track last Redis save times per subtask
        self._last_redis_save_times: Dict[int, float] = {}
        # Track last cleanup time
        self._last_cleanup_time: float = 0.0

    def _cleanup_stale_entries(self) -> None:
        """
        Clean up tracking entries older than STALE_ENTRY_TIMEOUT.

        This prevents memory leaks from abandoned streams (executor crashes,
        network failures, client disconnects without error events).
        """
        current_time = time.time()

        # Only run cleanup every 5 minutes
        if current_time - self._last_cleanup_time < 300:
            return

        self._last_cleanup_time = current_time
        stale_cutoff = current_time - STALE_ENTRY_TIMEOUT

        # Find and remove stale entries from DB tracking
        stale_db_keys = [
            subtask_id
            for subtask_id, last_time in self._last_db_save_times.items()
            if last_time < stale_cutoff
        ]
        for subtask_id in stale_db_keys:
            self._last_db_save_times.pop(subtask_id, None)
            logger.debug(
                f"[ExecutorStreaming] Cleaned up stale DB tracking for subtask {subtask_id}"
            )

        # Find and remove stale entries from Redis tracking
        stale_redis_keys = [
            subtask_id
            for subtask_id, last_time in self._last_redis_save_times.items()
            if last_time < stale_cutoff
        ]
        for subtask_id in stale_redis_keys:
            self._last_redis_save_times.pop(subtask_id, None)
            logger.debug(
                f"[ExecutorStreaming] Cleaned up stale Redis tracking for subtask {subtask_id}"
            )

        if stale_db_keys or stale_redis_keys:
            logger.info(
                f"[ExecutorStreaming] Cleaned up {len(stale_db_keys)} DB entries "
                f"and {len(stale_redis_keys)} Redis entries"
            )

    async def handle_streaming_event(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Main dispatcher for streaming events.

        Args:
            db: Database session
            task_id: Task ID
            subtask_id: Subtask ID
            event: Streaming event request

        Returns:
            StreamingEventResponse indicating success/failure
        """
        try:
            # Periodically clean up stale tracking entries
            self._cleanup_stale_entries()

            logger.info(
                f"[ExecutorStreaming] Handling {event.event_type} event for "
                f"task={task_id}, subtask={subtask_id}"
            )

            if event.event_type == StreamingEventType.STREAM_START:
                return await self._handle_stream_start(db, task_id, subtask_id, event)
            elif event.event_type == StreamingEventType.STREAM_CHUNK:
                return await self._handle_stream_chunk(db, task_id, subtask_id, event)
            elif event.event_type == StreamingEventType.TOOL_START:
                return await self._handle_tool_start(db, task_id, subtask_id, event)
            elif event.event_type == StreamingEventType.TOOL_DONE:
                return await self._handle_tool_done(db, task_id, subtask_id, event)
            elif event.event_type == StreamingEventType.STREAM_DONE:
                return await self._handle_stream_done(db, task_id, subtask_id, event)
            elif event.event_type == StreamingEventType.STREAM_ERROR:
                return await self._handle_stream_error(db, task_id, subtask_id, event)
            else:
                logger.warning(
                    f"[ExecutorStreaming] Unknown event type: {event.event_type}"
                )
                return StreamingEventResponse(
                    success=False,
                    message=f"Unknown event type: {event.event_type}",
                    task_id=task_id,
                    subtask_id=subtask_id,
                )

        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Error handling event: {e}", exc_info=True
            )
            return StreamingEventResponse(
                success=False,
                message=str(e),
                task_id=task_id,
                subtask_id=subtask_id,
            )

    async def _handle_stream_start(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Handle stream_start event.

        Initializes streaming state in Redis and emits chat:start WebSocket event.
        """
        shell_type = event.shell_type or "ClaudeCode"

        # Initialize streaming state in Redis
        state = StreamingStateData(
            task_id=task_id,
            subtask_id=subtask_id,
            shell_type=shell_type,
            status="streaming",
            started_at=datetime.now(),
            last_update_at=datetime.now(),
            content_length=0,
            offset=0,
            thinking_count=0,
        )
        await self._state_manager.set_streaming_state(subtask_id, state)

        # Initialize content cache
        await self._state_manager.save_streaming_content(subtask_id, "")

        # Emit WebSocket chat:start event
        await self._emit_chat_start(task_id, subtask_id, shell_type)

        logger.info(
            f"[ExecutorStreaming] Stream started: task={task_id}, "
            f"subtask={subtask_id}, shell_type={shell_type}"
        )

        return StreamingEventResponse(
            success=True,
            message="Stream started",
            task_id=task_id,
            subtask_id=subtask_id,
        )

    async def _handle_stream_chunk(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Handle stream_chunk event.

        Appends content to Redis cache, emits WebSocket event,
        and periodically saves to database.
        """
        content = event.content or ""
        offset = event.offset or 0
        result = event.result

        # Always append content to Redis for reconnection support
        _, new_length = await self._state_manager.append_streaming_content(
            subtask_id, content
        )

        # Throttle state metadata updates (offset, content_length) to reduce Redis writes
        current_time = time.time()
        last_redis_save = self._last_redis_save_times.get(subtask_id, 0)

        if current_time - last_redis_save >= REDIS_SAVE_INTERVAL:
            # Update state metadata
            await self._state_manager.update_streaming_state(
                subtask_id,
                {
                    "content_length": new_length,
                    "offset": offset + len(content),
                },
            )
            self._last_redis_save_times[subtask_id] = current_time

        # Emit WebSocket chat:chunk event
        await self._emit_chat_chunk(task_id, subtask_id, content, offset, result)

        # Periodically save to database
        await self._maybe_save_to_db(db, task_id, subtask_id, result)

        # Publish to Redis Pub/Sub for reconnection support
        await self._state_manager.publish_streaming_event(
            subtask_id,
            "chunk",
            {"content": content, "offset": offset, "result": result},
        )

        return StreamingEventResponse(
            success=True,
            message="Chunk processed",
            task_id=task_id,
            subtask_id=subtask_id,
        )

    async def _handle_tool_start(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Handle tool_start event.

        Emits tool:start WebSocket event for real-time tool execution display.
        """
        tool_id = event.tool_id or ""
        tool_name = event.tool_name or ""
        tool_input = event.tool_input or {}

        # Emit WebSocket tool:start event
        await self._emit_tool_start(task_id, subtask_id, tool_id, tool_name, tool_input)

        logger.debug(
            f"[ExecutorStreaming] Tool started: task={task_id}, "
            f"subtask={subtask_id}, tool={tool_name}"
        )

        return StreamingEventResponse(
            success=True,
            message="Tool start processed",
            task_id=task_id,
            subtask_id=subtask_id,
        )

    async def _handle_tool_done(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Handle tool_done event.

        Emits tool:done WebSocket event when tool execution completes.
        """
        tool_id = event.tool_id or ""
        tool_output = event.tool_output
        tool_error = event.tool_error

        # Emit WebSocket tool:done event
        await self._emit_tool_done(
            task_id, subtask_id, tool_id, tool_output, tool_error
        )

        logger.debug(
            f"[ExecutorStreaming] Tool done: task={task_id}, "
            f"subtask={subtask_id}, tool_id={tool_id}"
        )

        return StreamingEventResponse(
            success=True,
            message="Tool done processed",
            task_id=task_id,
            subtask_id=subtask_id,
        )

    async def _handle_stream_done(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Handle stream_done event.

        Finalizes streaming: saves to database, emits chat:done,
        and cleans up Redis state.
        """
        offset = event.offset or 0
        result = event.result or {}

        # Get final content from Redis
        final_content = await self._state_manager.get_streaming_content(subtask_id)

        # Save final result to database
        await self._save_final_to_db(db, subtask_id, result)

        # Emit WebSocket chat:done event
        await self._emit_chat_done(task_id, subtask_id, offset, result)

        # Publish stream done to Redis Pub/Sub
        await self._state_manager.publish_stream_done(subtask_id, result)

        # Clean up Redis state
        await self._state_manager.cleanup_streaming_session(subtask_id)

        # Clean up tracking
        self._last_db_save_times.pop(subtask_id, None)
        self._last_redis_save_times.pop(subtask_id, None)

        logger.info(
            f"[ExecutorStreaming] Stream done: task={task_id}, "
            f"subtask={subtask_id}, offset={offset}"
        )

        return StreamingEventResponse(
            success=True,
            message="Stream completed",
            task_id=task_id,
            subtask_id=subtask_id,
        )

    async def _handle_stream_error(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        event: StreamingEventRequest,
    ) -> StreamingEventResponse:
        """
        Handle stream_error event.

        Saves error to database, emits chat:error, and cleans up.
        """
        error = event.error or "Unknown error"

        # Save error to database
        await self._save_error_to_db(db, subtask_id, error)

        # Emit WebSocket chat:error event
        await self._emit_chat_error(task_id, subtask_id, error)

        # Clean up Redis state
        await self._state_manager.cleanup_streaming_session(subtask_id)

        # Clean up tracking
        self._last_db_save_times.pop(subtask_id, None)
        self._last_redis_save_times.pop(subtask_id, None)

        logger.error(
            f"[ExecutorStreaming] Stream error: task={task_id}, "
            f"subtask={subtask_id}, error={error}"
        )

        return StreamingEventResponse(
            success=True,
            message="Error processed",
            task_id=task_id,
            subtask_id=subtask_id,
        )

    # ==================== Database Operations ====================

    async def _maybe_save_to_db(
        self,
        db: Session,
        task_id: int,
        subtask_id: int,
        result: Optional[Dict[str, Any]],
    ) -> None:
        """
        Periodically save streaming content to database (every 5 seconds).
        """
        current_time = time.time()
        last_save = self._last_db_save_times.get(subtask_id, 0)

        if current_time - last_save < DB_SAVE_INTERVAL:
            return

        try:
            subtask = db.query(Subtask).get(subtask_id)
            if subtask:
                if result:
                    subtask.result = result
                subtask.status = SubtaskStatus.RUNNING
                subtask.updated_at = datetime.now()
                db.add(subtask)
                db.commit()

                self._last_db_save_times[subtask_id] = current_time
                logger.debug(
                    f"[ExecutorStreaming] Periodic DB save for subtask {subtask_id}"
                )
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to save to DB for subtask {subtask_id}: {e}"
            )
            db.rollback()

    async def _save_final_to_db(
        self,
        db: Session,
        subtask_id: int,
        result: Dict[str, Any],
    ) -> None:
        """
        Save final result to database on stream completion.
        """
        try:
            subtask = db.query(Subtask).get(subtask_id)
            if subtask:
                subtask.result = result
                subtask.status = SubtaskStatus.COMPLETED
                subtask.completed_at = datetime.now()
                subtask.updated_at = datetime.now()
                db.add(subtask)
                db.commit()
                logger.info(
                    f"[ExecutorStreaming] Final save to DB for subtask {subtask_id}"
                )
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed final DB save for subtask {subtask_id}: {e}"
            )
            db.rollback()

    async def _save_error_to_db(
        self,
        db: Session,
        subtask_id: int,
        error: str,
    ) -> None:
        """
        Save error to database on stream failure.
        """
        try:
            subtask = db.query(Subtask).get(subtask_id)
            if subtask:
                subtask.error_message = error
                subtask.status = SubtaskStatus.FAILED
                subtask.updated_at = datetime.now()
                db.add(subtask)
                db.commit()
                logger.info(
                    f"[ExecutorStreaming] Error saved to DB for subtask {subtask_id}"
                )
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed error DB save for subtask {subtask_id}: {e}"
            )
            db.rollback()

    # ==================== WebSocket Emission ====================

    async def _emit_chat_start(
        self, task_id: int, subtask_id: int, shell_type: str
    ) -> None:
        """Emit chat:start WebSocket event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_start(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    shell_type=shell_type,
                )
        except Exception as e:
            logger.error(f"[ExecutorStreaming] Failed to emit chat:start: {e}")

    async def _emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]],
    ) -> None:
        """Emit chat:chunk WebSocket event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_chunk(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=content,
                    offset=offset,
                    result=result,
                )
        except Exception as e:
            logger.error(f"[ExecutorStreaming] Failed to emit chat:chunk: {e}")

    async def _emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]],
    ) -> None:
        """Emit chat:done WebSocket event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result=result,
                )
        except Exception as e:
            logger.error(f"[ExecutorStreaming] Failed to emit chat:done: {e}")

    async def _emit_chat_error(self, task_id: int, subtask_id: int, error: str) -> None:
        """Emit chat:error WebSocket event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_error(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=error,
                )
        except Exception as e:
            logger.error(f"[ExecutorStreaming] Failed to emit chat:error: {e}")

    async def _emit_tool_start(
        self,
        task_id: int,
        subtask_id: int,
        tool_id: str,
        tool_name: str,
        tool_input: Dict[str, Any],
    ) -> None:
        """Emit tool:start WebSocket event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter and hasattr(ws_emitter, "emit_tool_start"):
                await ws_emitter.emit_tool_start(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_id=tool_id,
                    tool_name=tool_name,
                    tool_input=tool_input,
                )
            else:
                # Fallback: include tool info in a chat:chunk event
                logger.debug(
                    f"[ExecutorStreaming] emit_tool_start not available, "
                    f"tool={tool_name}"
                )
        except Exception as e:
            logger.error(f"[ExecutorStreaming] Failed to emit tool:start: {e}")

    async def _emit_tool_done(
        self,
        task_id: int,
        subtask_id: int,
        tool_id: str,
        tool_output: Optional[str],
        tool_error: Optional[str],
    ) -> None:
        """Emit tool:done WebSocket event."""
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter and hasattr(ws_emitter, "emit_tool_done"):
                await ws_emitter.emit_tool_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_id=tool_id,
                    tool_output=tool_output,
                    tool_error=tool_error,
                )
            else:
                logger.debug(
                    f"[ExecutorStreaming] emit_tool_done not available, "
                    f"tool_id={tool_id}"
                )
        except Exception as e:
            logger.error(f"[ExecutorStreaming] Failed to emit tool:done: {e}")


# Global singleton instance
executor_streaming_service = ExecutorStreamingService()
