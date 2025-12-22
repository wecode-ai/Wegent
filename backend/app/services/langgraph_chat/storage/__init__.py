# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage handler module for LangGraph Chat Service.

This module provides a unified interface for storage operations by
re-exporting the existing db_handler and session_manager from the chat service.

Usage:
    from .storage import storage_handler
    await storage_handler.update_subtask_status(subtask_id, "RUNNING")
"""

from typing import Any


class _StorageProxy:
    """Lazy proxy to storage handlers to avoid circular imports."""

    _db_handler = None
    _session_manager = None

    @classmethod
    def _ensure_handlers(cls):
        if cls._db_handler is None:
            from app.services.chat.db_handler import db_handler
            from app.services.chat.session_manager import session_manager

            cls._db_handler = db_handler
            cls._session_manager = session_manager

    def __getattr__(self, name: str):
        self._ensure_handlers()
        # Try db_handler first, then session_manager
        if hasattr(self._db_handler, name):
            return getattr(self._db_handler, name)
        if hasattr(self._session_manager, name):
            return getattr(self._session_manager, name)
        raise AttributeError(f"'{type(self).__name__}' has no attribute '{name}'")

    # Explicit methods for IDE autocomplete and type hints

    async def update_subtask_status(
        self,
        subtask_id: int,
        status: str,
        result: dict | None = None,
        error: str | None = None,
    ) -> None:
        """Update subtask status in database."""
        self._ensure_handlers()
        await self._db_handler.update_subtask_status(subtask_id, status, result, error)

    async def save_partial_response(
        self, subtask_id: int, content: str, is_streaming: bool = True
    ) -> None:
        """Save partial response during streaming."""
        self._ensure_handlers()
        await self._db_handler.save_partial_response(subtask_id, content, is_streaming)

    async def get_chat_history(self, task_id: int) -> list[dict[str, str]]:
        """Get chat history for a task."""
        self._ensure_handlers()
        return await self._session_manager.get_chat_history(task_id)

    async def append_messages(
        self, task_id: int, user_message: Any, assistant_message: str
    ) -> bool:
        """Append user and assistant messages to chat history."""
        self._ensure_handlers()
        return await self._session_manager.append_user_and_assistant_messages(
            task_id, user_message, assistant_message
        )

    async def register_stream(self, subtask_id: int):
        """Register a new streaming request, returns asyncio.Event for cancellation."""
        self._ensure_handlers()
        return await self._session_manager.register_stream(subtask_id)

    async def unregister_stream(self, subtask_id: int) -> None:
        """Unregister a streaming request."""
        self._ensure_handlers()
        await self._session_manager.unregister_stream(subtask_id)

    async def save_streaming_content(
        self, subtask_id: int, content: str, expire: int | None = None
    ) -> bool:
        """Save streaming content to Redis cache."""
        self._ensure_handlers()
        return await self._session_manager.save_streaming_content(
            subtask_id, content, expire
        )

    async def delete_streaming_content(self, subtask_id: int) -> bool:
        """Delete streaming content from Redis cache."""
        self._ensure_handlers()
        return await self._session_manager.delete_streaming_content(subtask_id)

    async def publish_streaming_done(
        self, subtask_id: int, result: dict | None = None
    ) -> bool:
        """Publish a 'done' signal to Redis Pub/Sub."""
        self._ensure_handlers()
        return await self._session_manager.publish_streaming_done(subtask_id, result)


# Global storage handler instance
storage_handler = _StorageProxy()
