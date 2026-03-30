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
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ):
        """Initialize the status updating emitter.

        Args:
            wrapped: The emitter to wrap
            task_id: Task ID for status updates
            subtask_id: Subtask ID for status updates
            executor_name: Optional executor name for container reuse
            executor_namespace: Optional executor namespace
        """
        self._wrapped = wrapped
        self._task_id = task_id
        self._subtask_id = subtask_id
        self._executor_name = executor_name
        self._executor_namespace = executor_namespace
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
        elif event.type in (
            EventType.CHUNK.value,
            EventType.TOOL_START.value,
            EventType.TOOL_RESULT.value,
        ):
            await session_manager.touch_task_streaming_activity(self._task_id)

        # Collect blocks for mixed content rendering using session_manager
        if event.type == EventType.TOOL_START.value:
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

        The actual task status (COMPLETED or PENDING_CONFIRMATION for pipeline mode)
        is determined by the collaboration strategy in db_handler.

        Also publishes TaskCompletedEvent for unified handling by subscription
        task completion handler and other event subscribers.

        Args:
            result: Optional result data from the event
        """
        from app.core.events import TaskCompletedEvent, get_event_bus
        from app.db.session import SessionLocal
        from app.models.subtask import Subtask
        from app.services.chat.storage import session_manager
        from app.services.chat.storage.db import db_handler

        try:
            # Get accumulated content and blocks from session_manager
            accumulated_content = await session_manager.get_accumulated_content(
                self._subtask_id
            )
            blocks = await session_manager.finalize_and_get_blocks(self._subtask_id)

            # Get existing subtask.result from database to preserve silent_exit flag
            # set by MCP tools (e.g., silent_exit tool)
            existing_result = {}
            db = SessionLocal()
            try:
                subtask = (
                    db.query(Subtask).filter(Subtask.id == self._subtask_id).first()
                )
                if subtask and subtask.result:
                    existing_result = subtask.result
            finally:
                db.close()

            # Build result dict, merging existing result (preserves silent_exit flag)
            final_result = result
            if final_result is None:
                final_result = {"value": accumulated_content}
            elif isinstance(final_result, dict) and "value" not in final_result:
                # If result exists but has no value, add accumulated content
                final_result = {**final_result, "value": accumulated_content}

            # Merge existing result fields (like silent_exit) into final_result
            if existing_result and isinstance(final_result, dict):
                for key, value in existing_result.items():
                    if key not in final_result:
                        final_result[key] = value
                        logger.debug(
                            f"[StatusUpdatingEmitter] Preserved existing result field "
                            f"'{key}' for subtask {self._subtask_id}"
                        )

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

            # Update subtask status to COMPLETED with executor info for container reuse
            # Task status will be determined by collaboration strategy in db_handler
            await db_handler.update_subtask_status(
                self._subtask_id,
                "COMPLETED",
                result=final_result,
                executor_name=self._executor_name,
                executor_namespace=self._executor_namespace,
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

            # Publish TaskCompletedEvent for unified handling
            # This ensures subscription execution status is updated regardless of execution mode
            await self._publish_task_completed_event("COMPLETED", final_result, None)

        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to COMPLETED: {e}",
                exc_info=True,
            )

    async def _update_status_failed(self, error_message: str) -> None:
        """Update subtask and task status to FAILED.

        Also publishes TaskCompletedEvent for unified handling by subscription
        task completion handler and other event subscribers.

        Args:
            error_message: Error message
        """
        from app.services.chat.storage import session_manager
        from app.services.chat.storage.db import db_handler

        try:
            # Keep partial streaming output even when execution fails.
            accumulated_content = await session_manager.get_accumulated_content(
                self._subtask_id
            )
            blocks = await session_manager.finalize_and_get_blocks(self._subtask_id)

            result: Optional[Dict[str, Any]] = None
            if accumulated_content:
                result = {"value": accumulated_content}

            if blocks:
                if result is None:
                    result = {}
                result["blocks"] = blocks
                logger.info(
                    f"[StatusUpdatingEmitter] Added {len(blocks)} blocks to failed result "
                    f"for subtask {self._subtask_id}"
                )

            # Update subtask status to FAILED with executor info for container reuse
            await db_handler.update_subtask_status(
                self._subtask_id,
                "FAILED",
                result=result,
                error=error_message,
                executor_name=self._executor_name,
                executor_namespace=self._executor_namespace,
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

            # Publish TaskCompletedEvent for unified handling
            await self._publish_task_completed_event("FAILED", result, error_message)

        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to FAILED: {e}",
                exc_info=True,
            )

    async def _update_status_cancelled(self) -> None:
        """Update subtask and task status to CANCELLED.

        Also publishes TaskCompletedEvent for unified handling by subscription
        task completion handler and other event subscribers.
        """
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

            # Update subtask status to CANCELLED with executor info for container reuse
            await db_handler.update_subtask_status(
                self._subtask_id,
                "CANCELLED",
                result=result,
                executor_name=self._executor_name,
                executor_namespace=self._executor_namespace,
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

            # Publish TaskCompletedEvent for unified handling
            await self._publish_task_completed_event("CANCELLED", result, None)

        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status for cancelled: {e}",
                exc_info=True,
            )

    async def _publish_task_completed_event(
        self,
        status: str,
        result: Optional[Dict[str, Any]],
        error: Optional[str],
    ) -> None:
        """Publish TaskCompletedEvent for unified handling.

        This ensures subscription execution status is updated regardless of
        execution mode (SSE, WebSocket, HTTP+Callback, INPROCESS).

        Args:
            status: Task status (COMPLETED, FAILED, CANCELLED)
            result: Optional result data
            error: Optional error message
        """
        from app.core.events import TaskCompletedEvent, get_event_bus
        from app.db.session import SessionLocal
        from app.models.task import TaskResource

        try:
            # Get user_id from task
            db = SessionLocal()
            try:
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == self._task_id,
                        TaskResource.kind == "Task",
                        TaskResource.is_active.in_(
                            [TaskResource.STATE_ACTIVE, TaskResource.STATE_SUBSCRIPTION]
                        ),
                    )
                    .first()
                )
                user_id = task.user_id if task else None
            finally:
                db.close()

            if user_id is None:
                logger.warning(
                    f"[StatusUpdatingEmitter] Cannot publish TaskCompletedEvent: "
                    f"task {self._task_id} not found or no user_id"
                )
                return

            # Publish TaskCompletedEvent
            event_bus = get_event_bus()
            await event_bus.publish(
                TaskCompletedEvent(
                    task_id=self._task_id,
                    subtask_id=self._subtask_id,
                    user_id=user_id,
                    status=status,
                    result=result,
                    error=error,
                )
            )

            logger.info(
                f"[StatusUpdatingEmitter] Published TaskCompletedEvent: "
                f"task_id={self._task_id}, subtask_id={self._subtask_id}, "
                f"status={status}"
            )

        except Exception as e:
            # Don't fail the status update if event publishing fails
            logger.error(
                f"[StatusUpdatingEmitter] Failed to publish TaskCompletedEvent: {e}",
                exc_info=True,
            )
