# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session Manager for Direct Chat.

Manages chat session state including message history and
Dify conversation IDs using Redis for multi-worker support.
"""

import logging
from typing import Any, Dict, List, Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Redis key prefixes
CHAT_HISTORY_PREFIX = "direct_chat:history"
DIFY_CONVERSATION_PREFIX = "direct_chat:dify_conv"
SESSION_EXPIRE_SECONDS = 7200  # 2 hours


class SessionManager:
    """
    Manages chat session state in Redis.

    Provides methods to store and retrieve:
    - Chat message history for Chat type
    - Dify conversation IDs for Dify type
    """

    @staticmethod
    async def get_chat_history(task_id: int) -> List[Dict[str, str]]:
        """
        Get chat message history for a task.

        Args:
            task_id: The task ID

        Returns:
            List of message dictionaries with 'role' and 'content' keys
        """
        key = f"{CHAT_HISTORY_PREFIX}:{task_id}"
        try:
            history = await cache_manager.get(key)
            if history is None:
                return []
            return history if isinstance(history, list) else []
        except Exception as e:
            logger.error(f"Error getting chat history for task {task_id}: {e}")
            return []

    @staticmethod
    async def save_chat_history(task_id: int, messages: List[Dict[str, str]]) -> bool:
        """
        Save chat message history for a task.

        Args:
            task_id: The task ID
            messages: List of message dictionaries

        Returns:
            bool: True if save was successful
        """
        key = f"{CHAT_HISTORY_PREFIX}:{task_id}"
        try:
            return await cache_manager.set(key, messages, expire=SESSION_EXPIRE_SECONDS)
        except Exception as e:
            logger.error(f"Error saving chat history for task {task_id}: {e}")
            return False

    @staticmethod
    async def append_message(task_id: int, role: str, content: str) -> bool:
        """
        Append a single message to chat history.

        Args:
            task_id: The task ID
            role: Message role ('user' or 'assistant')
            content: Message content

        Returns:
            bool: True if append was successful
        """
        try:
            history = await SessionManager.get_chat_history(task_id)
            history.append({"role": role, "content": content})
            return await SessionManager.save_chat_history(task_id, history)
        except Exception as e:
            logger.error(f"Error appending message for task {task_id}: {e}")
            return False

    @staticmethod
    async def get_dify_conversation_id(task_id: int) -> str:
        """
        Get Dify conversation ID for a task.

        Args:
            task_id: The task ID

        Returns:
            Conversation ID string or empty string if not found
        """
        key = f"{DIFY_CONVERSATION_PREFIX}:{task_id}"
        try:
            conv_id = await cache_manager.get(key)
            return conv_id if isinstance(conv_id, str) else ""
        except Exception as e:
            logger.error(f"Error getting Dify conversation ID for task {task_id}: {e}")
            return ""

    @staticmethod
    async def save_dify_conversation_id(task_id: int, conversation_id: str) -> bool:
        """
        Save Dify conversation ID for a task.

        Args:
            task_id: The task ID
            conversation_id: The Dify conversation ID

        Returns:
            bool: True if save was successful
        """
        key = f"{DIFY_CONVERSATION_PREFIX}:{task_id}"
        try:
            return await cache_manager.set(
                key, conversation_id, expire=SESSION_EXPIRE_SECONDS
            )
        except Exception as e:
            logger.error(f"Error saving Dify conversation ID for task {task_id}: {e}")
            return False

    @staticmethod
    async def clear_session(task_id: int) -> bool:
        """
        Clear all session data for a task.

        Args:
            task_id: The task ID

        Returns:
            bool: True if clear was successful
        """
        try:
            history_key = f"{CHAT_HISTORY_PREFIX}:{task_id}"
            conv_key = f"{DIFY_CONVERSATION_PREFIX}:{task_id}"
            await cache_manager.delete(history_key)
            await cache_manager.delete(conv_key)
            logger.info(f"Cleared session data for task {task_id}")
            return True
        except Exception as e:
            logger.error(f"Error clearing session for task {task_id}: {e}")
            return False
