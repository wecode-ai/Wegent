# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket result emitter.

Emits execution events to frontend via WebSocket.
Supports block events for tool call visualization.

Uses unified block types from shared.models.blocks for consistency.
"""

import logging
from typing import Any, Optional

from backend.app.services.chat.webpage_ws_chat_emitter import WebPageSocketEmitter
from shared.models import EventType, ExecutionEvent
from shared.models.blocks import BlockStatus, create_tool_block

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
        team_id: Optional[int] = None,
        team_name: Optional[str] = None,
        task_title: Optional[str] = None,
        is_group_chat: bool = False,
    ):
        """Initialize the WebSocket emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            user_id: Optional user ID for progress events and task:created/task:status
            team_id: Optional team ID for task:created event
            team_name: Optional team name for task:created event
            task_title: Optional task title for task:created event
            is_group_chat: Whether this is a group chat task
        """
        super().__init__(task_id, subtask_id)
        self.user_id = user_id
        self.team_id = team_id
        self.team_name = team_name
        self.task_title = task_title
        self.is_group_chat = is_group_chat

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit event via WebSocket.

        Args:
            event: Execution event to emit
        """
        from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter

        webpage_ws_emitter = get_webpage_ws_emitter()
        if not webpage_ws_emitter:
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
            await webpage_ws_emitter.emit_chat_start(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                message_id=event.message_id,
                shell_type=shell_type,
            )
            # Also emit task:created event to update task list
            await self._emit_task_created(webpage_ws_emitter)

        elif event.type == EventType.CHUNK.value:
            # Extract block_id and block_offset from event.data if present
            block_id = event.data.get("block_id") if event.data else None
            block_offset = event.data.get("block_offset") if event.data else None

            await webpage_ws_emitter.emit_chat_chunk(
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
            await self._emit_block_created(event, webpage_ws_emitter)

        elif event.type == EventType.TOOL_RESULT.value:
            # Emit chat:block_updated event for tool result
            await self._emit_block_updated(event, webpage_ws_emitter)

        elif event.type == EventType.DONE.value:
            await webpage_ws_emitter.emit_chat_done(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                offset=event.offset,
                result=event.result,
                message_id=event.message_id,
            )
            # Also emit task:status event to update task list
            await self._emit_task_status(webpage_ws_emitter, "COMPLETED")

        elif event.type == EventType.ERROR.value:
            await webpage_ws_emitter.emit_chat_error(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                error=event.error or "Unknown error",
                message_id=event.message_id,
            )
            # Also emit task:status event to update task list
            await self._emit_task_status(webpage_ws_emitter, "FAILED")

        elif event.type == EventType.PROGRESS.value:
            await self._emit_progress(event, webpage_ws_emitter)

        elif event.type == EventType.CANCELLED.value:
            await webpage_ws_emitter.emit_chat_cancelled(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
            )
            # Also emit task:status event to update task list
            await self._emit_task_status(webpage_ws_emitter, "CANCELLED")

    async def _emit_task_created(self, ws_emitter) -> None:
        """Emit task:created event to user room.

        This notifies the frontend to update the task list when a new task starts.
        Only emits if all required parameters (user_id, team_id, team_name, task_title)
        are available.

        Args:
            ws_emitter: WebSocket emitter instance
        """
        # Only emit if we have all required parameters
        if not all([self.user_id, self.team_id, self.team_name, self.task_title]):
            logger.debug(
                f"[WebSocketResultEmitter] Skipping task:created - missing params: "
                f"user_id={self.user_id}, team_id={self.team_id}, "
                f"team_name={self.team_name}, task_title={self.task_title}"
            )
            return

        await ws_emitter.emit_task_created(
            user_id=self.user_id,
            task_id=self.task_id,
            title=self.task_title,
            team_id=self.team_id,
            team_name=self.team_name,
            is_group_chat=self.is_group_chat,
        )
        logger.debug(
            f"[WebSocketResultEmitter] task:created emitted: "
            f"user_id={self.user_id}, task_id={self.task_id}"
        )

    async def _emit_task_status(
        self, ws_emitter: WebPageSocketEmitter, status: str
    ) -> None:
        """Emit task:status event to user room.

        This notifies the frontend to update the task status in the task list
        when a task completes, fails, or is cancelled.

        Args:
            ws_emitter: WebSocket emitter instance
            status: Task status (COMPLETED, FAILED, CANCELLED)
        """
        # Only emit if we have user_id (should be passed during initialization)
        if not self.user_id:
            logger.debug(
                f"[WebSocketResultEmitter] Skipping task:status - no user_id for task {self.task_id}"
            )
            return

        await ws_emitter.emit_task_status(
            user_id=self.user_id,
            task_id=self.task_id,
            status=status,
        )
        logger.debug(
            f"[WebSocketResultEmitter] task:status emitted: "
            f"user_id={self.user_id}, task_id={self.task_id}, status={status}"
        )

    async def _emit_block_created(self, event: ExecutionEvent, ws_emitter) -> None:
        """Emit chat:block_created event for tool start.

        Args:
            event: Execution event with tool start information
            ws_emitter: WebSocket emitter instance
        """
        # Use unified create_tool_block function
        display_name = event.data.get("display_name") if event.data else None
        block = create_tool_block(
            tool_use_id=event.tool_use_id or "",
            tool_name=event.tool_name or "",
            tool_input=event.tool_input or {},
            display_name=display_name,
        )

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
        # Determine status using unified BlockStatus enum
        status = BlockStatus.DONE
        if event.data and event.data.get("status") == "error":
            status = BlockStatus.ERROR

        await ws_emitter.emit_block_updated(
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            block_id=event.tool_use_id or "",
            tool_output=event.tool_output,
            status=status.value,
        )
        logger.debug(
            f"[WebSocketResultEmitter] chat:block_updated emitted: "
            f"task_id={event.task_id}, tool_use_id={event.tool_use_id}, status={status.value}"
        )

    async def _emit_progress(self, event: ExecutionEvent, ws_emitter) -> None:
        """Emit progress event.

        Args:
            event: Execution event with progress information
            ws_emitter: WebSocket emitter instance
        """
        # Only emit if we have user_id (should be passed during initialization)
        if not self.user_id:
            logger.debug(
                f"[WebSocketResultEmitter] Skipping progress - no user_id for task {event.task_id}"
            )
            return

        await ws_emitter.emit_task_status(
            user_id=self.user_id,
            task_id=event.task_id,
            status=event.status or "RUNNING",
            progress=event.progress,
        )
