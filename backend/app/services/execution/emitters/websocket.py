# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket result emitter.

Emits execution events to frontend via WebSocket.
"""

import logging
from typing import Optional

from shared.models import EventType, ExecutionEvent

from .base import BaseResultEmitter

logger = logging.getLogger(__name__)


class WebSocketResultEmitter(BaseResultEmitter):
    """WebSocket result emitter.

    Pushes events to frontend via WebSocket.
    Supports room broadcast and user-targeted push.
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

        logger.debug(
            f"[WebSocketResultEmitter] Emitting: type={event.type}, "
            f"task_id={event.task_id}, subtask_id={event.subtask_id}"
        )

        # Call corresponding WebSocket method based on event type
        if event.type == EventType.START.value:
            await ws_emitter.emit_chat_start(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                message_id=event.message_id,
            )

        elif event.type == EventType.CHUNK.value:
            await ws_emitter.emit_chat_chunk(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                content=event.content,
                offset=event.offset,
                result=event.result,
            )

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
