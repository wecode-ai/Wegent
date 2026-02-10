# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket-based progress reporter for local executor mode.

This module implements a progress reporter that sends task progress
and results via WebSocket, replacing the HTTP-based CallbackClient
used in Docker mode.

Uses unified ExecutionEvent format from shared.models.execution.
All legacy methods have been removed - use ExecutionEvent-based methods only.
"""

from typing import TYPE_CHECKING, Any, Dict, Optional

from executor.modes.local.events import ChatEvents, TaskEvents
from shared.logger import setup_logger
from shared.models.execution import EventType, ExecutionEvent

if TYPE_CHECKING:
    from executor.modes.local.websocket_client import WebSocketClient

logger = setup_logger("websocket_progress_reporter")


class WebSocketProgressReporter:
    """Progress reporter that sends updates via WebSocket.

    This class replaces the HTTP CallbackClient for local mode,
    sending progress updates and results through the WebSocket connection.
    Uses unified ExecutionEvent format for all events.
    """

    def __init__(
        self,
        websocket_client: "WebSocketClient",
        task_id: int,
        subtask_id: int,
    ):
        """Initialize the progress reporter.

        Args:
            websocket_client: WebSocket client for sending events.
            task_id: Task ID.
            subtask_id: Subtask ID.
        """
        self.client = websocket_client
        self.task_id = task_id
        self.subtask_id = subtask_id

    def _get_socket_event(self, event_type: str) -> str:
        """Map EventType to Socket.IO event name.

        Args:
            event_type: EventType value string.

        Returns:
            Socket.IO event name.
        """
        mapping = {
            EventType.START.value: ChatEvents.START,
            EventType.CHUNK.value: ChatEvents.CHUNK,
            EventType.DONE.value: ChatEvents.DONE,
            EventType.ERROR.value: ChatEvents.ERROR,
            EventType.PROGRESS.value: TaskEvents.PROGRESS,
            EventType.CANCEL.value: TaskEvents.CANCEL,
            EventType.CANCELLED.value: TaskEvents.CANCEL,
        }
        return mapping.get(event_type, TaskEvents.PROGRESS)

    async def send_event(self, event: ExecutionEvent) -> None:
        """Send an ExecutionEvent directly.

        This is the primary method for sending events using the unified format.

        Args:
            event: ExecutionEvent to send.
        """
        try:
            # Map EventType to Socket.IO event name
            socket_event = self._get_socket_event(event.type)
            data = event.to_dict()

            await self.client.emit(socket_event, data)
            logger.debug(f"Event sent: type={event.type}, task_id={self.task_id}")
        except Exception as e:
            logger.error(
                f"Failed to send event {event.type} for task {self.task_id}: {e}"
            )

    async def send_start_event(
        self,
        model: str = "",
        message_id: Optional[int] = None,
    ) -> None:
        """Send start event using unified ExecutionEvent format.

        Args:
            model: Model name being used.
            message_id: Optional message ID.
        """
        event = ExecutionEvent.create(
            event_type=EventType.START,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            message_id=message_id,
            data={"model": model},
        )
        await self.send_event(event)

    async def send_chunk_event(
        self,
        content: str,
        offset: int = 0,
        message_id: Optional[int] = None,
    ) -> None:
        """Send chunk event using unified ExecutionEvent format.

        Args:
            content: Chunk content.
            offset: Content offset.
            message_id: Optional message ID.
        """
        event = ExecutionEvent.create(
            event_type=EventType.CHUNK,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            content=content,
            offset=offset,
            message_id=message_id,
        )
        await self.send_event(event)

    async def send_done_event(
        self,
        content: str = "",
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
        usage: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Send done event using unified ExecutionEvent format.

        Args:
            content: Full content.
            result: Optional result data.
            message_id: Optional message ID.
            usage: Optional token usage statistics.
        """
        event = ExecutionEvent.create(
            event_type=EventType.DONE,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            content=content,
            result=result,
            message_id=message_id,
            data={"usage": usage} if usage else {},
        )
        await self.send_event(event)

    async def send_error_event(
        self,
        error: str,
        error_code: Optional[str] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Send error event using unified ExecutionEvent format.

        Args:
            error: Error message.
            error_code: Optional error code.
            message_id: Optional message ID.
        """
        event = ExecutionEvent.create(
            event_type=EventType.ERROR,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            error=error,
            error_code=error_code,
            message_id=message_id,
        )
        await self.send_event(event)

    async def send_progress_event(
        self,
        progress: int,
        status: str,
        content: str = "",
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Send progress event using unified ExecutionEvent format.

        Args:
            progress: Progress percentage (0-100).
            status: Status string.
            content: Optional content/message.
            result: Optional result data.
        """
        event = ExecutionEvent.create(
            event_type=EventType.PROGRESS,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            progress=progress,
            status=status,
            content=content,
            result=result,
        )
        await self.send_event(event)

    async def send_cancelled_event(
        self,
        message_id: Optional[int] = None,
    ) -> None:
        """Send cancelled event using unified ExecutionEvent format.

        Args:
            message_id: Optional message ID.
        """
        event = ExecutionEvent.create(
            event_type=EventType.CANCELLED,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            message_id=message_id,
        )
        await self.send_event(event)

    async def report_progress(
        self,
        progress: int,
        status: str,
        message: str,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Report task progress to Backend using unified ExecutionEvent format.

        This is a convenience method that wraps send_progress_event.

        Args:
            progress: Progress percentage (0-100).
            status: Status string (e.g., 'running', 'completed', 'failed').
            message: Progress message.
            result: Optional result data.
        """
        try:
            event = ExecutionEvent.create(
                event_type=EventType.PROGRESS,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                progress=progress,
                status=status,
                content=message,
                result=result,
            )
            data = event.to_dict()

            await self.client.emit(TaskEvents.PROGRESS, data)
            logger.debug(
                f"Progress reported: task_id={self.task_id}, progress={progress}%, status={status}"
            )
        except Exception as e:
            logger.error(f"Failed to report progress for task {self.task_id}: {e}")

    async def report_result(
        self,
        status: str,
        result: Dict[str, Any],
        message: str = "",
    ) -> None:
        """Report final task result to Backend using unified ExecutionEvent format.

        Args:
            status: Final status (e.g., 'completed', 'failed').
            result: Result data dictionary.
            message: Optional result message.

        Raises:
            Exception: If the emit fails, re-raised after logging.
        """
        try:
            # Determine event type based on status
            event_type = (
                EventType.DONE
                if status.upper() in ("COMPLETED", "SUCCESS")
                else EventType.ERROR
            )

            # Create unified ExecutionEvent
            event = ExecutionEvent.create(
                event_type=event_type,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                status=status,
                result=result,
                content=message,
                progress=100,
            )

            data = event.to_dict()

            # Truncate data to 20 characters for logging
            data_str = str(data)
            truncated_data = data_str[:20] + "..." if len(data_str) > 20 else data_str
            logger.info(f"Reporting result: {truncated_data}")
            await self.client.emit(TaskEvents.COMPLETE, data)
            logger.info(f"Result reported: task_id={self.task_id}, status={status}")
        except Exception as e:
            logger.exception(f"Failed to report result for task {self.task_id}: {e}")
            raise
