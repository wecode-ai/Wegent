# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage handler module for LangGraph Chat Service.

This module provides a unified interface for storage operations,
wrapping the existing db_handler and session_manager from the chat service.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


class StorageHandler:
    """Unified storage handler for LangGraph Chat Service.

    Provides a clean interface to database and Redis operations,
    delegating to the existing handlers from the chat service.
    """

    def __init__(self):
        """Initialize storage handler with references to existing handlers."""
        from app.services.chat.db_handler import db_handler
        from app.services.chat.session_manager import session_manager

        self._db_handler = db_handler
        self._session_manager = session_manager

    # ==================== Database Operations ====================

    async def update_subtask_status(
        self,
        subtask_id: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        """
        Update subtask status in database.

        Args:
            subtask_id: Subtask ID
            status: New status (PENDING, RUNNING, COMPLETED, FAILED)
            result: Optional result data
            error: Optional error message
        """
        await self._db_handler.update_subtask_status(subtask_id, status, result, error)

    async def save_partial_response(
        self,
        subtask_id: int,
        content: str,
        is_streaming: bool = True,
    ) -> None:
        """
        Save partial response during streaming.

        Args:
            subtask_id: Subtask ID
            content: Current accumulated content
            is_streaming: Whether streaming is still in progress
        """
        await self._db_handler.save_partial_response(subtask_id, content, is_streaming)

    # ==================== Session/Redis Operations ====================

    async def get_chat_history(self, task_id: int) -> list[dict[str, str]]:
        """
        Get chat history for a task.

        Args:
            task_id: Task ID

        Returns:
            List of message dictionaries
        """
        return await self._session_manager.get_chat_history(task_id)

    async def save_chat_history(
        self,
        task_id: int,
        messages: list[dict[str, str]],
        expire: int | None = None,
    ) -> bool:
        """
        Save chat history for a task.

        Args:
            task_id: Task ID
            messages: List of message dictionaries
            expire: Optional expiration time in seconds

        Returns:
            True if save was successful
        """
        return await self._session_manager.save_chat_history(task_id, messages, expire)

    async def append_messages(
        self,
        task_id: int,
        user_message: Any,
        assistant_message: str,
    ) -> bool:
        """
        Append user and assistant messages to chat history.

        Args:
            task_id: Task ID
            user_message: User's message (string or vision dict)
            assistant_message: Assistant's response

        Returns:
            True if append was successful
        """
        return await self._session_manager.append_user_and_assistant_messages(
            task_id, user_message, assistant_message
        )

    async def clear_history(self, task_id: int) -> bool:
        """
        Clear chat history for a task.

        Args:
            task_id: Task ID

        Returns:
            True if clear was successful
        """
        return await self._session_manager.clear_history(task_id)

    # ==================== Streaming Management ====================

    async def register_stream(self, subtask_id: int):
        """
        Register a new streaming request.

        Args:
            subtask_id: Subtask ID

        Returns:
            asyncio.Event for cancellation signaling
        """
        return await self._session_manager.register_stream(subtask_id)

    async def unregister_stream(self, subtask_id: int) -> None:
        """
        Unregister a streaming request.

        Args:
            subtask_id: Subtask ID
        """
        await self._session_manager.unregister_stream(subtask_id)

    async def cancel_stream(self, subtask_id: int) -> bool:
        """
        Request cancellation of a streaming request.

        Args:
            subtask_id: Subtask ID

        Returns:
            True if cancellation flag was set
        """
        return await self._session_manager.cancel_stream(subtask_id)

    async def is_cancelled(self, subtask_id: int) -> bool:
        """
        Check if a streaming request has been cancelled.

        Args:
            subtask_id: Subtask ID

        Returns:
            True if cancelled
        """
        return await self._session_manager.is_cancelled(subtask_id)

    # ==================== Streaming Content Cache ====================

    async def save_streaming_content(
        self,
        subtask_id: int,
        content: str,
        expire: int | None = None,
    ) -> bool:
        """
        Save streaming content to Redis cache.

        Args:
            subtask_id: Subtask ID
            content: Current accumulated content
            expire: Optional expiration time

        Returns:
            True if save was successful
        """
        return await self._session_manager.save_streaming_content(
            subtask_id, content, expire
        )

    async def get_streaming_content(self, subtask_id: int) -> str | None:
        """
        Get streaming content from Redis cache.

        Args:
            subtask_id: Subtask ID

        Returns:
            Cached content or None
        """
        return await self._session_manager.get_streaming_content(subtask_id)

    async def delete_streaming_content(self, subtask_id: int) -> bool:
        """
        Delete streaming content from Redis cache.

        Args:
            subtask_id: Subtask ID

        Returns:
            True if delete was successful
        """
        return await self._session_manager.delete_streaming_content(subtask_id)

    async def publish_streaming_chunk(self, subtask_id: int, chunk: str) -> bool:
        """
        Publish a streaming chunk to Redis Pub/Sub.

        Args:
            subtask_id: Subtask ID
            chunk: Content chunk

        Returns:
            True if publish was successful
        """
        return await self._session_manager.publish_streaming_chunk(subtask_id, chunk)

    async def publish_streaming_done(
        self,
        subtask_id: int,
        result: dict[str, Any] | None = None,
    ) -> bool:
        """
        Publish a "done" signal to Redis Pub/Sub.

        Args:
            subtask_id: Subtask ID
            result: Optional result data

        Returns:
            True if publish was successful
        """
        return await self._session_manager.publish_streaming_done(subtask_id, result)


# Global storage handler instance
storage_handler = StorageHandler()
