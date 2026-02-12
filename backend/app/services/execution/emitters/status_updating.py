# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Status updating emitter wrapper.

Wraps any ResultEmitter to automatically update subtask/task status
when terminal events (DONE, ERROR, CANCELLED) are received.

This ensures unified status update logic across all execution modes
(SSE, WebSocket, HTTP+Callback).

Also collects blocks (tool calls and text segments) for mixed content rendering
using session_manager to maintain state across HTTP requests and support
page refresh recovery.
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

    It also collects blocks (tool calls and text segments) for mixed content
    rendering using session_manager, ensuring the correct order of
    tool-text-tool-text is preserved across multiple HTTP callback requests.

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
        self._status_updated = False

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit event and update status if terminal.

        Args:
            event: Execution event to emit
        """
        from app.services.chat.storage import session_manager

        logger.debug(
            f"[StatusUpdatingEmitter] emit: event_type={event.type}, "
            f"task_id={self._task_id}, subtask_id={self._subtask_id}, "
            f"content_len={len(event.content) if event.content else 0}"
        )

        # Handle START event - set task streaming status for page refresh recovery
        if event.type == EventType.START.value:
            # Set task-level streaming status so get_active_streaming can find it
            await session_manager.set_task_streaming_status(
                task_id=self._task_id,
                subtask_id=self._subtask_id,
                user_id=0,  # Will be updated if needed
                username="",
            )
            logger.info(
                f"[StatusUpdatingEmitter] Set task streaming status: "
                f"task_id={self._task_id}, subtask_id={self._subtask_id}"
            )

        # Collect blocks for mixed content rendering using session_manager
        elif event.type == EventType.TOOL_START.value:
            # When a tool starts, finalize any current text block and add tool block
            display_name = event.data.get("display_name") if event.data else None
            await session_manager.add_tool_block(
                subtask_id=self._subtask_id,
                tool_use_id=event.tool_use_id or "",
                tool_name=event.tool_name or "",
                tool_input=event.tool_input,
                display_name=display_name,
            )
        elif event.type == EventType.TOOL_RESULT.value:
            # Update tool block status when result arrives
            if event.tool_use_id:
                await session_manager.update_tool_block_status(
                    subtask_id=self._subtask_id,
                    tool_use_id=event.tool_use_id,
                    status="done",
                    tool_output=event.tool_output,
                )
        elif event.type == EventType.CHUNK.value:
            # Accumulate content and track text blocks
            content = event.content or ""
            if content:
                await session_manager.add_text_content(
                    subtask_id=self._subtask_id,
                    content=content,
                )

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
        from app.services.chat.storage import session_manager

        if content:
            await session_manager.add_text_content(
                subtask_id=subtask_id,
                content=content,
            )
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
        from app.services.chat.storage import session_manager
        from app.services.chat.storage.db import db_handler

        try:
            # Get accumulated content and blocks from session_manager
            accumulated_content = await session_manager.get_accumulated_content(
                self._subtask_id
            )
            blocks = await session_manager.finalize_and_get_blocks(self._subtask_id)

            # Build result dict
            final_result = result
            if final_result is None:
                final_result = {"value": accumulated_content}
            elif isinstance(final_result, dict) and "value" not in final_result:
                # If result exists but has no value, add accumulated content
                final_result = {**final_result, "value": accumulated_content}

            # Add collected blocks to result if we have any and result doesn't have blocks
            # This ensures mixed content (tool-text-tool-text) is preserved for database reload
            if blocks and isinstance(final_result, dict):
                existing_blocks = final_result.get("blocks")
                if not existing_blocks:
                    final_result["blocks"] = blocks
                    logger.info(
                        f"[StatusUpdatingEmitter] Added {len(blocks)} blocks to result "
                        f"for subtask {self._subtask_id}"
                    )

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

            # Clean up streaming state (including task-level streaming status)
            await session_manager.cleanup_streaming_state(
                self._subtask_id, task_id=self._task_id
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
        from app.services.chat.storage import session_manager
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

            # Clean up streaming state (including task-level streaming status)
            await session_manager.cleanup_streaming_state(
                self._subtask_id, task_id=self._task_id
            )
        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to FAILED: {e}",
                exc_info=True,
            )

    async def _update_status_cancelled(self) -> None:
        """Update subtask and task status to CANCELLED."""
        from app.services.chat.storage import session_manager
        from app.services.chat.storage.db import db_handler

        try:
            # Get accumulated content and blocks from session_manager
            accumulated_content = await session_manager.get_accumulated_content(
                self._subtask_id
            )
            blocks = await session_manager.finalize_and_get_blocks(self._subtask_id)

            # Build result with accumulated content
            result: Optional[Dict[str, Any]] = (
                {"value": accumulated_content} if accumulated_content else None
            )

            # Add collected blocks to result if we have any
            # This ensures mixed content (tool-text-tool-text) is preserved for database reload
            if blocks:
                if result is None:
                    result = {}
                result["blocks"] = blocks
                logger.info(
                    f"[StatusUpdatingEmitter] Added {len(blocks)} blocks to cancelled result "
                    f"for subtask {self._subtask_id}"
                )

            await db_handler.update_subtask_status(
                self._subtask_id,
                "CANCELLED",
                result=result,
            )

            self._status_updated = True
            logger.info(
                f"[StatusUpdatingEmitter] Updated subtask {self._subtask_id} "
                f"and task {self._task_id} status to CANCELLED"
            )

            # Clean up streaming state (including task-level streaming status)
            await session_manager.cleanup_streaming_state(
                self._subtask_id, task_id=self._task_id
            )
        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status for cancelled: {e}",
                exc_info=True,
            )
