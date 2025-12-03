# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session Manager for Direct Chat

Manages chat session state in Redis:
- Chat type: Message history storage
- Dify type: Conversation ID storage
"""

import logging
from typing import Any, Dict, List, Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Session expiration time (2 hours in seconds)
SESSION_EXPIRE_TIME = 7200


class SessionManager:
    """
    Manages chat session state in Redis.

    Provides session storage for:
    - Chat type: Message history (list of messages)
    - Dify type: Conversation ID for multi-turn conversations
    """

    # Key prefixes
    CHAT_HISTORY_PREFIX = "chat:history"
    DIFY_CONVERSATION_PREFIX = "chat:dify_conv"
    CANCELLED_PREFIX = "chat:cancelled"

    # Chat message history

    async def get_chat_history(self, task_id: int) -> List[Dict[str, str]]:
        """
        Get chat message history for a task.

        Args:
            task_id: Task ID

        Returns:
            List of message dictionaries with 'role' and 'content' keys
        """
        key = f"{self.CHAT_HISTORY_PREFIX}:{task_id}"
        history = await cache_manager.get(key)
        if history is None:
            return []
        if isinstance(history, list):
            return history
        return []

    async def append_chat_message(
        self,
        task_id: int,
        role: str,
        content: str
    ) -> bool:
        """
        Append a message to chat history.

        Args:
            task_id: Task ID
            role: Message role ('user' or 'assistant')
            content: Message content

        Returns:
            bool: True if successful
        """
        key = f"{self.CHAT_HISTORY_PREFIX}:{task_id}"
        history = await self.get_chat_history(task_id)
        history.append({"role": role, "content": content})
        return await cache_manager.set(key, history, expire=SESSION_EXPIRE_TIME)

    async def save_chat_history(
        self,
        task_id: int,
        messages: List[Dict[str, str]]
    ) -> bool:
        """
        Save complete chat history.

        Args:
            task_id: Task ID
            messages: List of message dictionaries

        Returns:
            bool: True if successful
        """
        key = f"{self.CHAT_HISTORY_PREFIX}:{task_id}"
        return await cache_manager.set(key, messages, expire=SESSION_EXPIRE_TIME)

    async def clear_chat_history(self, task_id: int) -> bool:
        """
        Clear chat history for a task.

        Args:
            task_id: Task ID

        Returns:
            bool: True if successful
        """
        key = f"{self.CHAT_HISTORY_PREFIX}:{task_id}"
        return await cache_manager.delete(key)

    # Dify conversation management

    async def get_dify_conversation_id(self, task_id: int) -> str:
        """
        Get Dify conversation ID for a task.

        Args:
            task_id: Task ID

        Returns:
            Conversation ID or empty string if not found
        """
        key = f"{self.DIFY_CONVERSATION_PREFIX}:{task_id}"
        conv_id = await cache_manager.get(key)
        if conv_id is None:
            return ""
        if isinstance(conv_id, str):
            return conv_id
        return str(conv_id) if conv_id else ""

    async def save_dify_conversation_id(
        self,
        task_id: int,
        conversation_id: str
    ) -> bool:
        """
        Save Dify conversation ID.

        Args:
            task_id: Task ID
            conversation_id: Dify conversation ID

        Returns:
            bool: True if successful
        """
        key = f"{self.DIFY_CONVERSATION_PREFIX}:{task_id}"
        return await cache_manager.set(key, conversation_id, expire=SESSION_EXPIRE_TIME)

    async def clear_dify_conversation(self, task_id: int) -> bool:
        """
        Clear Dify conversation ID.

        Args:
            task_id: Task ID

        Returns:
            bool: True if successful
        """
        key = f"{self.DIFY_CONVERSATION_PREFIX}:{task_id}"
        return await cache_manager.delete(key)

    # Cancellation management

    async def set_cancelled(self, task_id: int) -> bool:
        """
        Mark a task as cancelled.

        Args:
            task_id: Task ID

        Returns:
            bool: True if successful
        """
        key = f"{self.CANCELLED_PREFIX}:{task_id}"
        return await cache_manager.set(key, True, expire=300)  # 5 minutes

    async def is_cancelled(self, task_id: int) -> bool:
        """
        Check if a task is cancelled.

        Args:
            task_id: Task ID

        Returns:
            bool: True if cancelled
        """
        key = f"{self.CANCELLED_PREFIX}:{task_id}"
        result = await cache_manager.get(key)
        return result is True

    async def clear_cancelled(self, task_id: int) -> bool:
        """
        Clear cancellation flag.

        Args:
            task_id: Task ID

        Returns:
            bool: True if successful
        """
        key = f"{self.CANCELLED_PREFIX}:{task_id}"
        return await cache_manager.delete(key)

    # Cleanup

    async def cleanup_session(self, task_id: int) -> None:
        """
        Clean up all session data for a task.

        Args:
            task_id: Task ID
        """
        await self.clear_chat_history(task_id)
        await self.clear_dify_conversation(task_id)
        await self.clear_cancelled(task_id)


# Global session manager instance
session_manager = SessionManager()
