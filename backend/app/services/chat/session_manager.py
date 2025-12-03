# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session manager for Chat Shell.

Manages chat history and session state in Redis for multi-turn conversations.
"""

import logging
from typing import Any, Dict, List, Optional

from app.core.cache import cache_manager
from app.core.config import settings

logger = logging.getLogger(__name__)


class SessionManager:
    """
    Manages chat session state in Redis.
    
    Stores conversation history for multi-turn chat support.
    Uses task_id as the session identifier.
    """
    
    def __init__(self):
        self._cache = cache_manager
    
    def _get_history_key(self, task_id: int) -> str:
        """Generate Redis key for chat history."""
        return f"chat:history:{task_id}"
    
    async def get_chat_history(self, task_id: int) -> List[Dict[str, str]]:
        """
        Get chat history for a task.
        
        Args:
            task_id: The task ID to get history for
            
        Returns:
            List of message dictionaries with 'role' and 'content' keys
        """
        try:
            key = self._get_history_key(task_id)
            history = await self._cache.get(key)
            
            if history is None:
                return []
            
            # Ensure we return a list
            if isinstance(history, list):
                return history
            
            logger.warning(f"Invalid history format for task {task_id}, returning empty list")
            return []
            
        except Exception as e:
            logger.error(f"Error getting chat history for task {task_id}: {e}")
            return []
    
    async def save_chat_history(
        self,
        task_id: int,
        messages: List[Dict[str, str]],
        expire: Optional[int] = None
    ) -> bool:
        """
        Save chat history for a task.
        
        Args:
            task_id: The task ID to save history for
            messages: List of message dictionaries
            expire: Optional expiration time in seconds
            
        Returns:
            bool: True if save was successful
        """
        try:
            key = self._get_history_key(task_id)
            
            # Limit history size to prevent token overflow
            max_messages = settings.CHAT_HISTORY_MAX_MESSAGES
            if len(messages) > max_messages:
                messages = messages[-max_messages:]
                logger.info(f"Truncated chat history for task {task_id} to {max_messages} messages")
            
            expire_time = expire or settings.CHAT_HISTORY_EXPIRE_SECONDS
            return await self._cache.set(key, messages, expire=expire_time)
            
        except Exception as e:
            logger.error(f"Error saving chat history for task {task_id}: {e}")
            return False
    
    async def append_message(
        self,
        task_id: int,
        role: str,
        content: str
    ) -> bool:
        """
        Append a single message to chat history.
        
        Args:
            task_id: The task ID
            role: Message role ('user', 'assistant', or 'system')
            content: Message content
            
        Returns:
            bool: True if append was successful
        """
        try:
            history = await self.get_chat_history(task_id)
            history.append({"role": role, "content": content})
            return await self.save_chat_history(task_id, history)
            
        except Exception as e:
            logger.error(f"Error appending message for task {task_id}: {e}")
            return False
    
    async def append_user_and_assistant_messages(
        self,
        task_id: int,
        user_message: str,
        assistant_message: str
    ) -> bool:
        """
        Append both user and assistant messages to chat history.
        
        This is the common pattern after a successful chat completion.
        
        Args:
            task_id: The task ID
            user_message: The user's message
            assistant_message: The assistant's response
            
        Returns:
            bool: True if append was successful
        """
        try:
            history = await self.get_chat_history(task_id)
            history.append({"role": "user", "content": user_message})
            history.append({"role": "assistant", "content": assistant_message})
            return await self.save_chat_history(task_id, history)
            
        except Exception as e:
            logger.error(f"Error appending messages for task {task_id}: {e}")
            return False
    
    async def clear_history(self, task_id: int) -> bool:
        """
        Clear chat history for a task.
        
        Args:
            task_id: The task ID to clear history for
            
        Returns:
            bool: True if clear was successful
        """
        try:
            key = self._get_history_key(task_id)
            return await self._cache.delete(key)
            
        except Exception as e:
            logger.error(f"Error clearing chat history for task {task_id}: {e}")
            return False
    
    async def get_history_length(self, task_id: int) -> int:
        """
        Get the number of messages in chat history.
        
        Args:
            task_id: The task ID
            
        Returns:
            int: Number of messages in history
        """
        history = await self.get_chat_history(task_id)
        return len(history)


# Global session manager instance
session_manager = SessionManager()