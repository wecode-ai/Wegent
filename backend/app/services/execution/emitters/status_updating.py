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

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from app.services.chat.storage.session import StreamContentType
from app.services.chat.trigger.lifecycle import (
    collect_completed_result,
    persist_completed_result,
)
from app.services.execution.interactive_form_render import (
    build_interactive_form_render_payload,
)
from shared.models import EventType, ExecutionEvent

from .protocol import ResultEmitter

logger = logging.getLogger(__name__)

STREAMING_STORAGE_FLUSH_INTERVAL_SECONDS = 1.0
TASK_STREAMING_ACTIVITY_TOUCH_INTERVAL_SECONDS = 1.0

STREAM_CONTENT_EVENT_TYPES = {
    EventType.CHUNK.value: StreamContentType.TEXT,
    EventType.THINKING.value: StreamContentType.THINKING,
}
STREAM_BOUNDARY_EVENT_TYPES = {
    EventType.TOOL_START.value,
    EventType.TOOL_ARGUMENT_DELTA.value,
    EventType.TOOL_ARGUMENT_DONE.value,
    EventType.TOOL_RESULT.value,
    EventType.BLOCK_CREATED.value,
    EventType.BLOCK_UPDATED.value,
}
STREAM_TERMINAL_EVENT_TYPES = {
    EventType.DONE.value,
    EventType.ERROR.value,
    EventType.CANCELLED.value,
}


@dataclass
class _BufferedStreamContent:
    content_type: StreamContentType
    content: str


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
        self._stream_storage_buffer: list[_BufferedStreamContent] = []
        self._stream_storage_lock = asyncio.Lock()
        self._stream_storage_flush_task: Optional[asyncio.Task[None]] = None
        self._stream_storage_flush_in_progress = False
        self._last_task_activity_touch = 0.0

    def _resolve_owner_user_id(self) -> Optional[int]:
        from app.db.session import SessionLocal
        from app.models.task import TaskResource
        from app.stores.tasks import task_store

        with SessionLocal() as db:
            task = task_store.get_task_by_states(
                db,
                task_id=self._task_id,
                states=TaskResource.is_active_query(),
            )
            return task.user_id if task else None

    async def _buffer_stream_content(
        self,
        content_type: StreamContentType,
        content: str,
    ) -> None:
        """Buffer high-frequency stream content for batched Redis persistence."""
        if not content:
            return

        async with self._stream_storage_lock:
            if (
                self._stream_storage_buffer
                and self._stream_storage_buffer[-1].content_type == content_type
            ):
                self._stream_storage_buffer[-1].content += content
            else:
                self._stream_storage_buffer.append(
                    _BufferedStreamContent(
                        content_type=content_type,
                        content=content,
                    )
                )

            if (
                self._stream_storage_flush_task is None
                or self._stream_storage_flush_task.done()
            ):
                self._stream_storage_flush_task = asyncio.create_task(
                    self._flush_stream_storage_after_delay()
                )

    async def _flush_stream_storage_after_delay(self) -> None:
        """Flush buffered stream content after the configured interval."""
        try:
            await asyncio.sleep(STREAMING_STORAGE_FLUSH_INTERVAL_SECONDS)
            self._stream_storage_flush_in_progress = True
            await self._flush_stream_storage()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(
                "[StatusUpdatingEmitter] Failed to flush buffered stream storage: %s",
                exc,
                exc_info=True,
            )
        finally:
            self._stream_storage_flush_in_progress = False
            if self._stream_storage_flush_task is asyncio.current_task():
                self._stream_storage_flush_task = None

    async def _flush_stream_storage(self) -> None:
        """Persist buffered stream content to Redis in order."""
        async with self._stream_storage_lock:
            pending = self._stream_storage_buffer
            self._stream_storage_buffer = []

        if not pending:
            return

        from app.services.chat.storage import session_manager

        for item in pending:
            await session_manager.add_stream_content(
                subtask_id=self._subtask_id,
                content_type=item.content_type,
                content=item.content,
            )
        await self._touch_task_streaming_activity(session_manager, force=True)

    async def _touch_task_streaming_activity(
        self,
        session_manager: Any,
        force: bool = False,
    ) -> None:
        """Refresh task activity at a limited cadence."""
        now = time.monotonic()
        if (
            not force
            and now - self._last_task_activity_touch
            < TASK_STREAMING_ACTIVITY_TOUCH_INTERVAL_SECONDS
        ):
            return

        await session_manager.touch_task_streaming_activity(self._task_id)
        self._last_task_activity_touch = now

    async def _cancel_pending_storage_flush_task(self) -> None:
        """Cancel a scheduled delayed flush after a synchronous flush."""
        task = self._stream_storage_flush_task
        if not task or task.done() or task is asyncio.current_task():
            return

        if self._stream_storage_flush_in_progress:
            await task
            return

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            if self._stream_storage_flush_task is task:
                self._stream_storage_flush_task = None

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
        elif event.type in STREAM_CONTENT_EVENT_TYPES:
            await self._buffer_stream_content(
                STREAM_CONTENT_EVENT_TYPES[event.type],
                event.content or "",
            )
        elif event.type in STREAM_BOUNDARY_EVENT_TYPES:
            await self._flush_stream_storage()
            await self._touch_task_streaming_activity(session_manager)

        # Collect blocks for mixed content rendering using session_manager
        if event.type == EventType.TOOL_START.value:
            # When a tool starts, finalize any current text block and add tool block
            display_name = event.data.get("display_name") if event.data else None
            tool_protocol = event.data.get("tool_protocol") if event.data else None
            server_label = event.data.get("server_label") if event.data else None
            await session_manager.add_tool_block(
                subtask_id=self._subtask_id,
                tool_use_id=event.tool_use_id or "",
                tool_name=event.tool_name or "",
                tool_input=event.tool_input,
                display_name=display_name,
                tool_protocol=tool_protocol,
                server_label=server_label,
            )
            if event.data and event.data.get("argument_status") == "streaming":
                await session_manager.update_tool_block_status(
                    subtask_id=self._subtask_id,
                    tool_use_id=event.tool_use_id or "",
                    status="generating_arguments",
                    tool_input=event.tool_input,
                )
        elif event.type == EventType.TOOL_ARGUMENT_DELTA.value:
            if event.tool_use_id:
                await session_manager.update_tool_block_status(
                    subtask_id=self._subtask_id,
                    tool_use_id=event.tool_use_id,
                    status="generating_arguments",
                    tool_input=event.tool_input,
                )
        elif event.type == EventType.TOOL_ARGUMENT_DONE.value:
            if event.tool_use_id:
                await session_manager.update_tool_block_status(
                    subtask_id=self._subtask_id,
                    tool_use_id=event.tool_use_id,
                    status="pending",
                    tool_input=event.tool_input,
                )
        elif event.type == EventType.TOOL_RESULT.value:
            # Update tool block status when result arrives
            if event.tool_use_id:
                tool_status = (
                    "error" if (event.data or {}).get("status") == "failed" else "done"
                )
                tool_protocol = event.data.get("tool_protocol") if event.data else None
                server_label = event.data.get("server_label") if event.data else None
                update_kwargs = {
                    "subtask_id": self._subtask_id,
                    "tool_use_id": event.tool_use_id,
                    "status": tool_status,
                    "tool_output": event.tool_output,
                    "tool_input": event.tool_input,
                    "tool_protocol": tool_protocol,
                    "server_label": server_label,
                }
                render_payload = build_interactive_form_render_payload(event)
                if render_payload is not None:
                    update_kwargs["render_payload"] = render_payload
                await session_manager.update_tool_block_status(**update_kwargs)
        elif event.type == EventType.BLOCK_CREATED.value:
            block = event.data.get("block") if event.data else None
            if isinstance(block, dict):
                await session_manager.add_block(self._subtask_id, block)
        elif event.type == EventType.BLOCK_UPDATED.value:
            block_id = event.data.get("block_id") if event.data else None
            updates = event.data.get("updates") if event.data else None
            if block_id and isinstance(updates, dict):
                blocks = await session_manager.get_blocks(self._subtask_id)
                existing_block = next(
                    (block for block in blocks if block.get("id") == str(block_id)),
                    None,
                )
                if existing_block is not None:
                    existing_block.update(updates)
                    await session_manager.add_block(self._subtask_id, existing_block)
                else:
                    await session_manager.add_block(
                        self._subtask_id,
                        {
                            "id": str(block_id),
                            "type": "tool",
                            "tool_use_id": str(block_id),
                            **updates,
                        },
                    )
        elif event.type in STREAM_CONTENT_EVENT_TYPES:
            # Content is persisted by the 1s stream storage buffer.
            pass

        # Handle terminal events - update status before forwarding
        if event.type in STREAM_TERMINAL_EVENT_TYPES:
            await self._flush_stream_storage()
            await self._cancel_pending_storage_flush_task()

            if event.type == EventType.DONE.value:
                final_result = await self._handle_done(event)
                if final_result is not None:
                    event.result = final_result
            elif event.type == EventType.ERROR.value:
                final_result = await self._handle_error(event)
                if final_result is not None:
                    event.result = final_result
            elif event.type == EventType.CANCELLED.value:
                final_result = await self._handle_cancelled(event)
                if final_result is not None:
                    event.result = final_result

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
        if content:
            await self._buffer_stream_content(
                StreamContentType.TEXT,
                content,
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
        await self._flush_stream_storage()
        await self._cancel_pending_storage_flush_task()
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
        await self._flush_stream_storage()
        await self._cancel_pending_storage_flush_task()
        if not self._status_updated:
            error_code = kwargs.get("error_code")
            await self._update_status_failed(error, error_code=error_code)
        await self._wrapped.emit_error(task_id, subtask_id, error, **kwargs)

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        """Update status to CANCELLED and forward cancelled event."""
        await self._flush_stream_storage()
        await self._cancel_pending_storage_flush_task()
        if not self._status_updated:
            await self._update_status_cancelled()
        await self._wrapped.emit_cancelled(task_id, subtask_id, **kwargs)

    async def close(self) -> None:
        """Close the wrapped emitter."""
        await self._flush_stream_storage()
        await self._cancel_pending_storage_flush_task()
        await self._wrapped.close()

    async def _handle_done(self, event: ExecutionEvent) -> Optional[Dict[str, Any]]:
        """Handle DONE event - update status to COMPLETED.

        Args:
            event: The DONE event
        """
        if self._status_updated:
            return event.result

        return await self._update_status_completed(event.result)

    async def _handle_error(self, event: ExecutionEvent) -> Optional[Dict[str, Any]]:
        """Handle ERROR event - update status to FAILED.

        Args:
            event: The ERROR event
        """
        if self._status_updated:
            return event.result

        error_message = event.error or "Unknown error"
        return await self._update_status_failed(
            error_message, error_code=event.error_code
        )

    async def _handle_cancelled(
        self, event: ExecutionEvent
    ) -> Optional[Dict[str, Any]]:
        """Handle CANCELLED event - update status to CANCELLED.

        Args:
            event: The CANCELLED event
        """
        if self._status_updated:
            return event.result

        return await self._update_status_cancelled()

    async def _update_status_completed(
        self, result: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """Update subtask and task status to COMPLETED.

        The actual task status (COMPLETED or PENDING_CONFIRMATION for pipeline mode)
        is determined by the collaboration strategy in db_handler.

        Also publishes TaskCompletedEvent for unified handling by subscription
        task completion handler and other event subscribers.

        Args:
            result: Optional result data from the event
        """
        try:
            final_result = await collect_completed_result(
                self._subtask_id,
                status="COMPLETED",
                result=result,
            )
            await persist_completed_result(
                subtask_id=self._subtask_id,
                task_id=self._task_id,
                status="COMPLETED",
                result=final_result,
                executor_name=self._executor_name,
                executor_namespace=self._executor_namespace,
            )
            self._status_updated = True
            logger.info(
                f"[StatusUpdatingEmitter] Updated subtask {self._subtask_id} "
                f"and task {self._task_id} status to COMPLETED"
            )

            # Publish TaskCompletedEvent for unified handling
            # This ensures subscription execution status is updated regardless of execution mode
            await self._publish_task_completed_event("COMPLETED", final_result, None)
            return final_result

        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to COMPLETED: {e}",
                exc_info=True,
            )
            return result

    async def _update_status_failed(
        self, error_message: str, error_code: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Update subtask and task status to FAILED.

        Also publishes TaskCompletedEvent for unified handling by subscription
        task completion handler and other event subscribers.

        Args:
            error_message: Error message
            error_code: Classified error code (e.g., 'context_length_exceeded')
        """
        try:
            result = await collect_completed_result(
                self._subtask_id,
                status="FAILED",
                error_message=error_message,
                error_code=error_code,
            )
            await persist_completed_result(
                subtask_id=self._subtask_id,
                task_id=self._task_id,
                status="FAILED",
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

            # Publish TaskCompletedEvent for unified handling
            await self._publish_task_completed_event("FAILED", result, error_message)
            return result

        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status to FAILED: {e}",
                exc_info=True,
            )
            return None

    async def _update_status_cancelled(self) -> Optional[Dict[str, Any]]:
        """Update subtask and task status to CANCELLED.

        Also publishes TaskCompletedEvent for unified handling by subscription
        task completion handler and other event subscribers.
        """
        try:
            result = await collect_completed_result(
                self._subtask_id,
                status="CANCELLED",
            )
            await persist_completed_result(
                subtask_id=self._subtask_id,
                task_id=self._task_id,
                status="CANCELLED",
                result=result,
                executor_name=self._executor_name,
                executor_namespace=self._executor_namespace,
            )
            self._status_updated = True
            logger.info(
                f"[StatusUpdatingEmitter] Updated subtask {self._subtask_id} "
                f"and task {self._task_id} status to CANCELLED"
            )

            # Publish TaskCompletedEvent for unified handling
            await self._publish_task_completed_event("CANCELLED", result, None)
            return result

        except Exception as e:
            logger.error(
                f"[StatusUpdatingEmitter] Failed to update status for cancelled: {e}",
                exc_info=True,
            )
            return None

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

        try:
            user_id = self._resolve_owner_user_id()

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
