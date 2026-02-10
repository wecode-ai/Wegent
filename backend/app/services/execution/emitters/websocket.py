# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket result emitter.

Emits execution events to frontend via WebSocket.
Supports block events for tool call visualization.
"""

import logging
from typing import Any, Optional

from shared.models import EventType, ExecutionEvent

from .base import BaseResultEmitter

logger = logging.getLogger(__name__)


class WebSocketResultEmitter(BaseResultEmitter):
    """WebSocket result emitter.

    Pushes events to frontend via WebSocket.
    Supports room broadcast and user-targeted push.
    Handles block events for tool call visualization.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        user_id: Optional[int] = None,
    ):
        """Initialize the WebSocket emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            user_id: Optional user ID for progress events
        """
        super().__init__(task_id, subtask_id)
        self.user_id = user_id

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit event via WebSocket.

        Args:
            event: Execution event to emit
        """
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.warning("[WebSocketResultEmitter] WebSocket emitter not available")
            return

        # Log blocks info for debugging
        blocks_count = 0
        if event.result and isinstance(event.result, dict):
            blocks = event.result.get("blocks", [])
            blocks_count = len(blocks) if blocks else 0

        logger.debug(
            f"[WebSocketResultEmitter] Emitting: type={event.type}, "
            f"task_id={event.task_id}, subtask_id={event.subtask_id}, "
            f"has_result={event.result is not None}, blocks_count={blocks_count}"
        )

        # Call corresponding WebSocket method based on event type
        if event.type == EventType.START.value:
            shell_type = event.data.get("shell_type", "Chat") if event.data else "Chat"
            await ws_emitter.emit_chat_start(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                message_id=event.message_id,
                shell_type=shell_type,
            )

        elif event.type == EventType.CHUNK.value:
            # Extract block_id and block_offset from event.data if present
            block_id = event.data.get("block_id") if event.data else None
            block_offset = event.data.get("block_offset") if event.data else None

            await ws_emitter.emit_chat_chunk(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                content=event.content,
                offset=event.offset,
                result=event.result,
                block_id=block_id,
                block_offset=block_offset,
            )

        elif event.type == EventType.TOOL_START.value:
            # Emit chat:block_created event for tool start
            await self._emit_block_created(event, ws_emitter)

        elif event.type == EventType.TOOL_RESULT.value:
            # Emit chat:block_updated event for tool result
            await self._emit_block_updated(event, ws_emitter)

        elif event.type == EventType.DONE.value:
            await ws_emitter.emit_chat_done(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                offset=event.offset,
                result=event.result,
                message_id=event.message_id,
            )

        elif event.type == EventType.ERROR.value:
            await ws_emitter.emit_chat_error(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                error=event.error or "Unknown error",
                message_id=event.message_id,
            )

        elif event.type == EventType.PROGRESS.value:
            await self._emit_progress(event, ws_emitter)

        elif event.type == EventType.CANCELLED.value:
            await ws_emitter.emit_chat_cancelled(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
            )

    async def _emit_block_created(self, event: ExecutionEvent, ws_emitter) -> None:
        """Emit chat:block_created event for tool start.

        Args:
            event: Execution event with tool start information
            ws_emitter: WebSocket emitter instance
        """
        import time

        # Build block data from event
        block: dict[str, Any] = {
            "id": event.tool_use_id or f"tool-{int(time.time() * 1000)}",
            "type": "tool",
            "tool_use_id": event.tool_use_id,
            "tool_name": event.tool_name,
            "tool_input": event.tool_input,
            "status": "pending",
            "timestamp": int(time.time() * 1000),
        }

        # Include display_name if available in event data
        if event.data and event.data.get("display_name"):
            block["display_name"] = event.data["display_name"]

        await ws_emitter.emit_block_created(
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            block=block,
        )
        logger.debug(
            f"[WebSocketResultEmitter] chat:block_created emitted: "
            f"task_id={event.task_id}, tool_name={event.tool_name}"
        )

    async def _emit_block_updated(self, event: ExecutionEvent, ws_emitter) -> None:
        """Emit chat:block_updated event for tool result.

        Args:
            event: Execution event with tool result information
            ws_emitter: WebSocket emitter instance
        """
        # Determine status based on tool output
        status = "done"
        if event.data and event.data.get("status") == "error":
            status = "error"

        await ws_emitter.emit_block_updated(
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            block_id=event.tool_use_id or "",
            tool_output=event.tool_output,
            status=status,
        )
        logger.debug(
            f"[WebSocketResultEmitter] chat:block_updated emitted: "
            f"task_id={event.task_id}, tool_use_id={event.tool_use_id}, status={status}"
        )

    async def _emit_progress(self, event: ExecutionEvent, ws_emitter) -> None:
        """Emit progress event.

        Args:
            event: Execution event with progress information
            ws_emitter: WebSocket emitter instance
        """
        if self.user_id:
            await ws_emitter.emit_task_status(
                user_id=self.user_id,
                task_id=event.task_id,
                status=event.status or "RUNNING",
                progress=event.progress,
            )
        else:
            # Need to get user_id from database
            from app.db.session import SessionLocal
            from app.models.task import TaskResource

            db = SessionLocal()
            try:
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == event.task_id,
                        TaskResource.kind == "Task",
                    )
                    .first()
                )
                if task:
                    await ws_emitter.emit_task_status(
                        user_id=task.user_id,
                        task_id=event.task_id,
                        status=event.status or "RUNNING",
                        progress=event.progress,
                    )
            finally:
                db.close()
