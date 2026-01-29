# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event handlers for local executor mode.

This module implements handlers for events received from the Backend server.
"""

from typing import TYPE_CHECKING, Any, Dict

from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor.modes.local.runner import LocalRunner

logger = setup_logger("local_handlers")


class TaskHandler:
    """Handler for task-related events from Backend."""

    def __init__(self, runner: "LocalRunner"):
        """Initialize the task handler.

        Args:
            runner: The LocalRunner instance for task execution.
        """
        self.runner = runner

    async def handle_task_dispatch(self, data: Dict[str, Any]) -> None:
        """Handle task dispatch event from Backend.

        This is called when Backend pushes a new task to execute.

        Args:
            data: Task data dictionary containing:
                - task_id: Task ID
                - subtask_id: Subtask ID
                - prompt: Task prompt
                - bot: Bot configuration (includes agent_config.env for Claude API)
                - auth_token: JWT token for HTTP API calls (Skills, attachments)
                - attachments: List of attachments
                - git_url, branch_name, etc.
        """
        task_id = data.get("task_id", -1)
        subtask_id = data.get("subtask_id", -1)
        logger.info(
            f"Received task dispatch: task_id={task_id}, subtask_id={subtask_id}"
        )

        # Enqueue task for execution
        await self.runner.enqueue_task(data)

    async def handle_task_cancel(self, data: Dict[str, Any]) -> None:
        """Handle task cancel event from Backend.

        Args:
            data: Cancel data containing task_id.
        """
        task_id = data.get("task_id")
        if task_id is not None:
            logger.info(f"Received task cancel request: task_id={task_id}")
            await self.runner.cancel_task(task_id)
        else:
            logger.warning("Received cancel request without task_id")

    async def handle_chat_message(self, data: Dict[str, Any]) -> None:
        """Handle chat message event from Backend.

        This is used for follow-up messages in an existing chat session.

        Args:
            data: Chat message data (same structure as task dispatch).
        """
        task_id = data.get("task_id", -1)
        subtask_id = data.get("subtask_id", -1)
        logger.info(
            f"Received chat message: task_id={task_id}, subtask_id={subtask_id}"
        )

        # Chat messages are processed as tasks
        await self.runner.enqueue_task(data)


class ConnectionHandler:
    """Handler for connection-related events."""

    def __init__(self, runner: "LocalRunner"):
        """Initialize the connection handler.

        Args:
            runner: The LocalRunner instance.
        """
        self.runner = runner

    async def handle_connect(self) -> None:
        """Handle successful connection."""
        logger.info("Connected to Backend WebSocket")
        # Note: Registration is handled by LocalRunner.start() after connection
        # and by reconnection logic in the internal handlers.

    async def handle_disconnect(self) -> None:
        """Handle disconnection."""
        logger.warning("Disconnected from Backend WebSocket")
        # The WebSocket client will handle automatic reconnection

    async def handle_connect_error(self, data: Any) -> None:
        """Handle connection error.

        Args:
            data: Error information.
        """
        logger.error(f"WebSocket connection error: {data}")
