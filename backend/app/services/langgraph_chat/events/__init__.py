# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Event emitter module for LangGraph Chat Service.

This module provides WebSocket event emission capabilities,
wrapping the existing ws_emitter from the chat service.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


class EventEmitter:
    """WebSocket event emitter for LangGraph Chat Service.

    Provides methods to emit various chat and task events
    via WebSocket to connected clients.
    """

    def __init__(self):
        """Initialize event emitter."""
        self._ws_emitter = None

    def _get_emitter(self):
        """Lazily get the WebSocket emitter instance.

        Only caches a valid emitter and keeps retrying until one is available.
        Returns None if no emitter is available yet.
        """
        if self._ws_emitter is not None:
            return self._ws_emitter

        from app.services.chat.ws_emitter import get_ws_emitter
        emitter = get_ws_emitter()

        # Only cache if we got a valid emitter
        if emitter is not None:
            self._ws_emitter = emitter

        return emitter

    # ==================== Chat Events ====================

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """
        Emit chat:start event when streaming begins.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_start(task_id=task_id, subtask_id=subtask_id)

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
    ) -> None:
        """
        Emit chat:chunk event for streaming content.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Content chunk
            offset: Current offset in the stream
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_chunk(
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                offset=offset,
            )

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict[str, Any] | None = None,
    ) -> None:
        """
        Emit chat:done event when streaming completes.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            offset: Final offset
            result: Optional result data
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_done(
                task_id=task_id,
                subtask_id=subtask_id,
                offset=offset,
                result=result,
            )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
    ) -> None:
        """
        Emit chat:error event when an error occurs.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            error: Error message
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error=error,
            )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """
        Emit chat:cancelled event when streaming is cancelled.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_cancelled(
                task_id=task_id,
                subtask_id=subtask_id,
            )

    async def emit_chat_message(
        self,
        task_id: int,
        subtask_id: int,
        message_id: int,
        role: str,
        content: str,
        sender: dict[str, Any] | None = None,
        created_at: str | None = None,
    ) -> None:
        """
        Emit chat:message event for group chat messages.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Message ID
            role: Message role (user/assistant)
            content: Message content
            sender: Optional sender info
            created_at: Optional timestamp
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_message(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                role=role,
                content=content,
                sender=sender,
                created_at=created_at,
            )

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: dict[str, Any] | None = None,
    ) -> None:
        """
        Emit event when bot response is complete (for multi-device sync).

        Args:
            user_id: User ID
            task_id: Task ID
            subtask_id: Subtask ID
            content: Full response content
            result: Optional result data
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_chat_bot_complete(
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                result=result,
            )

    # ==================== Task Events ====================

    async def emit_task_created(
        self,
        user_id: int,
        task_id: int,
        title: str,
        team_id: int,
        team_name: str,
    ) -> None:
        """
        Emit task:created event when a new task is created.

        Args:
            user_id: User ID
            task_id: Task ID
            title: Task title
            team_id: Team ID
            team_name: Team name
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_task_created(
                user_id=user_id,
                task_id=task_id,
                title=title,
                team_id=team_id,
                team_name=team_name,
            )

    async def emit_task_status(
        self,
        user_id: int,
        task_id: int,
        status: str,
        progress: int | None = None,
    ) -> None:
        """
        Emit task:status event when task status changes.

        Args:
            user_id: User ID
            task_id: Task ID
            status: New status
            progress: Optional progress percentage
        """
        emitter = self._get_emitter()
        if emitter:
            await emitter.emit_task_status(
                user_id=user_id,
                task_id=task_id,
                status=status,
                progress=progress,
            )


# Global event emitter instance
event_emitter = EventEmitter()
