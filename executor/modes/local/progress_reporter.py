# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket-based progress reporter for local executor mode.

This module implements a progress reporter that sends task progress
and results via WebSocket, replacing the HTTP-based CallbackClient
used in Docker mode.
"""

from typing import TYPE_CHECKING, Any, Dict, Optional

from executor.modes.local.events import ChatEvents, TaskEvents
from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor.modes.local.websocket_client import WebSocketClient

logger = setup_logger("websocket_progress_reporter")


class WebSocketProgressReporter:
    """Progress reporter that sends updates via WebSocket.

    This class replaces the HTTP CallbackClient for local mode,
    sending progress updates and results through the WebSocket connection.
    """

    def __init__(
        self,
        websocket_client: "WebSocketClient",
        task_id: int,
        subtask_id: int,
        task_title: str = "",
        subtask_title: str = "",
    ):
        """Initialize the progress reporter.

        Args:
            websocket_client: WebSocket client for sending events.
            task_id: Task ID.
            subtask_id: Subtask ID.
            task_title: Task title.
            subtask_title: Subtask title.
        """
        self.client = websocket_client
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.task_title = task_title
        self.subtask_title = subtask_title

    async def report_progress(
        self,
        progress: int,
        status: str,
        message: str,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Report task progress to Backend.

        Args:
            progress: Progress percentage (0-100).
            status: Status string (e.g., 'running', 'completed', 'failed').
            message: Progress message.
            result: Optional result data.
        """
        try:
            await self.client.emit(
                TaskEvents.PROGRESS,
                {
                    "task_id": self.task_id,
                    "subtask_id": self.subtask_id,
                    "task_title": self.task_title,
                    "subtask_title": self.subtask_title,
                    "progress": progress,
                    "status": status,
                    "message": message,
                    "result": result,
                },
            )
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
        """Report final task result to Backend.

        Args:
            status: Final status (e.g., 'completed', 'failed').
            result: Result data dictionary.
            message: Optional result message.

        Raises:
            Exception: If the emit fails, re-raised after logging.
        """
        try:
            data = {
                "task_id": self.task_id,
                "subtask_id": self.subtask_id,
                "task_title": self.task_title,
                "subtask_title": self.subtask_title,
                "status": status,
                "result": result,
                "message": message,
            }
            logger.info(f"Reporting result: {data}")
            await self.client.emit(TaskEvents.RESULT, data)
            logger.info(f"Result reported: task_id={self.task_id}, status={status}")
        except Exception as e:
            logger.exception(f"Failed to report result for task {self.task_id}: {e}")
            raise

    async def send_chat_start(
        self,
        model: str = "",
        message_id: Optional[str] = None,
    ) -> None:
        """Send chat start event.

        Args:
            model: Model name being used.
            message_id: Optional message ID.
        """
        try:
            await self.client.emit(
                ChatEvents.START,
                {
                    "task_id": self.task_id,
                    "subtask_id": self.subtask_id,
                    "model": model,
                    "message_id": message_id,
                },
            )
            logger.debug(f"Chat start sent: task_id={self.task_id}")
        except Exception as e:
            logger.error(f"Failed to send chat start for task {self.task_id}: {e}")

    async def send_chat_chunk(
        self,
        chunk: str,
        message_id: Optional[str] = None,
    ) -> None:
        """Send streaming chat message chunk.

        Args:
            chunk: Message chunk content.
            message_id: Optional message ID for grouping chunks.
        """
        try:
            await self.client.emit(
                ChatEvents.CHUNK,
                {
                    "task_id": self.task_id,
                    "subtask_id": self.subtask_id,
                    "chunk": chunk,
                    "message_id": message_id,
                },
            )
            # Don't log every chunk to avoid spam
        except Exception as e:
            logger.error(f"Failed to send chat chunk for task {self.task_id}: {e}")

    async def send_chat_done(
        self,
        full_content: str,
        message_id: Optional[str] = None,
        usage: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Send chat completion event.

        Args:
            full_content: Full message content.
            message_id: Optional message ID.
            usage: Optional token usage statistics.
        """
        try:
            await self.client.emit(
                ChatEvents.DONE,
                {
                    "task_id": self.task_id,
                    "subtask_id": self.subtask_id,
                    "content": full_content,
                    "message_id": message_id,
                    "usage": usage,
                },
            )
            logger.debug(f"Chat done sent: task_id={self.task_id}")
        except Exception as e:
            logger.error(f"Failed to send chat done for task {self.task_id}: {e}")

    async def send_chat_error(
        self,
        error: str,
        message_id: Optional[str] = None,
    ) -> None:
        """Send chat error event.

        Args:
            error: Error message.
            message_id: Optional message ID.
        """
        try:
            await self.client.emit(
                ChatEvents.ERROR,
                {
                    "task_id": self.task_id,
                    "subtask_id": self.subtask_id,
                    "error": error,
                    "message_id": message_id,
                },
            )
            logger.info(f"Chat error sent: task_id={self.task_id}, error={error}")
        except Exception as e:
            logger.error(f"Failed to send chat error for task {self.task_id}: {e}")
