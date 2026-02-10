# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Status updating emitter wrapper.

Wraps any ResultEmitter to automatically update subtask/task status
when terminal events (DONE, ERROR, CANCELLED) are received.

This ensures unified status update logic across all execution modes
(SSE, WebSocket, HTTP+Callback).
"""

import logging
from typing import Any, Dict, Optional

from shared.models import EventType, ExecutionEvent

from .protocol import ResultEmitter

logger = logging.getLogger(__name__)


class StatusUpdatingEmitter(ResultEmitter):
    """Emitter wrapper that updates task status on terminal events.

    This wrapper intercepts terminal events (DONE, ERROR, CANCELLED) and
    updates the subtask and task status in the database before forwarding
    the event to the wrapped emitter.

    This ensures consistent status updates regardless of the execution mode
    (SSE, WebSocket, HTTP+Callback) or the type of emitter being used.
    """

    def __init__(
        self,
        wrapped: ResultEmitter,
        task_id: int,
        subtask_id: int,
    ):
        """Initialize the status updating emitter.

        Args:
            wrapped: The emitter to wrap
            task_id: Task ID for status updates
            subtask_id: Subtask ID for status updates
        """
        self._wrapped = wrapped
        self._task_id = task_id
        self._subtask_id = subtask_id
        self._accumulated_content = ""
        self._status_updated = False

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit event and update status if terminal.

        Args:
            event: Execution event to emit
        """
        # Accumulate content from CHUNK events for result
        if event.type == EventType.CHUNK.value:
            self._accumulated_content += event.content or ""

        # Handle terminal events - update status before forwarding
        if event.type == EventType.DONE.value:
            await self._handle_done(event)
        elif event.type == EventType.ERROR.value:
            await self._handle_error(event)
        elif event.type == EventType.CANCELLED.value:
            await self._handle_cancelled(event)

        # Forward event to wrapped emitter
        await self._wrapped.emit(event)

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Forward start event to wrapped emitter."""
        await self._wrapped.emit_start(task_id, subtask_id, message_id, **kwargs)

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Forward chunk event and accumulate content."""
        self._accumulated_content += content
        await self._wrapped.emit_chunk(task_id, subtask_id, content, offset, **kwargs)

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Update status to COMPLETED and forward done event."""
        if not self._status_updated:
            await self._update_status_completed(result)
        await self._wrapped.emit_done(task_id, subtask_id, result, **kwargs)

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Update status to FAILED and forward error event."""
        if not self._status_updated:
            await self._update_status_failed(error)
        await self._wrapped.emit_error(task_id, subtask_id, error, **kwargs)

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        """Update status to CANCELLED and forward cancelled event."""
        if not self._status_updated:
            await self._update_status_cancelled()
        await self._wrapped.emit_cancelled(task_id, subtask_id, **kwargs)

    async def close(self) -> None:
        """Close the wrapped emitter."""
        await self._wrapped.close()

    async def _handle_done(self, event: ExecutionEvent) -> None:
        """Handle DONE event - update status to COMPLETED.

        Args:
            event: The DONE event
        """
        if self._status_updated:
            return

        await self._update_status_completed(event.result)

    async def _handle_error(self, event: ExecutionEvent) -> None:
        """Handle ERROR event - update status to FAILED.

        Args:
            event: The ERROR event
        """
        if self._status_updated:
            return

        error_message = event.error or "Unknown error"
        await self._update_status_failed(error_message)

    async def _handle_cancelled(self, event: ExecutionEvent) -> None:
        """Handle CANCELLED event - update status to CANCELLED.

        Args:
            event: The CANCELLED event
        """
        if self._status_updated:
            return

        await self._update_status_cancelled()

    async def _update_status_completed(
        self, result: Optional[Dict[str, Any]] = None
    ) -> None:
        """Update subtask and task status to COMPLETED.

        Args:
            result: Optional result data from the event
        """
        from app.services.chat.storage.db import db_handler

        try:
            # Build result dict
            final_result = result
            if final_result is None:
                final_result = {"value": self._accumulated_content}
            elif isinstance(final_result, dict) and "value" not in final_result:
                # If result exists but has no value, add accumulated content
                final_result = {**final_result, "value": self._accumulated_content}

            # Update subtask status to COMPLETED
            await db_handler.update_subtask_status(
                self._subtask_id,
                "COMPLETED",
                result=final_result,
            )

            self._status_updated = True
            logger.info(
                f"[StatusUpdatingEmitter] Updated subtask {self._subtask_id} "
                f"and task {self._task_id} status to COMPLETED"
            )
        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to COMPLETED: {e}",
                exc_info=True,
            )

    async def _update_status_failed(self, error_message: str) -> None:
        """Update subtask and task status to FAILED.

        Args:
            error_message: Error message
        """
        from app.services.chat.storage.db import db_handler

        try:
            # Update subtask status to FAILED
            await db_handler.update_subtask_status(
                self._subtask_id,
                "FAILED",
                error=error_message,
            )

            self._status_updated = True
            logger.info(
                f"[StatusUpdatingEmitter] Updated subtask {self._subtask_id} "
                f"and task {self._task_id} status to FAILED"
            )
        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to FAILED: {e}",
                exc_info=True,
            )

    async def _update_status_cancelled(self) -> None:
        """Update subtask and task status to CANCELLED."""
        from app.services.chat.storage.db import db_handler

        try:
            # Build result with accumulated content
            result = (
                {"value": self._accumulated_content}
                if self._accumulated_content
                else None
            )

            # Update subtask status to CANCELLED
            # Note: We use COMPLETED status for cancelled tasks to preserve partial response
            # This is consistent with the behavior in streaming/core.py
            await db_handler.update_subtask_status(
                self._subtask_id,
                "COMPLETED",
                result=result,
            )

            self._status_updated = True
            logger.info(
                f"[StatusUpdatingEmitter] Updated subtask {self._subtask_id} "
                f"and task {self._task_id} status to COMPLETED (cancelled with partial response)"
            )
        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status for cancelled: {e}",
                exc_info=True,
            )
