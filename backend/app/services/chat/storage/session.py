# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session manager for Chat Shell.

Manages chat history and session state in Redis for multi-turn conversations.
Also manages cancellation state for streaming chat requests using Redis
for cross-worker communication in multi-worker deployments.
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.core.cache import cache_manager
from app.core.config import settings

logger = logging.getLogger(__name__)

# Redis key prefix for cancellation flags
CANCEL_KEY_PREFIX = "chat:cancel:"
# Cancellation flag TTL in seconds (5 minutes should be enough for any chat)
CANCEL_FLAG_TTL = 300

# Redis key prefix for streaming content cache
STREAMING_KEY_PREFIX = "chat:streaming:"
# Redis Pub/Sub channel prefix for streaming updates
STREAMING_CHANNEL_PREFIX = "chat:stream_channel:"
# Redis key prefix for task-level streaming status (for group chat)
TASK_STREAMING_KEY_PREFIX = "chat:task_streaming:"
# Task streaming status TTL (1 hour)
TASK_STREAMING_TTL = 3600


class SessionManager:
    """
    Manages chat session state in Redis.

    Stores conversation history for multi-turn chat support.
    Uses task_id as the session identifier.

    Also manages cancellation state for streaming chat requests.
    Uses Redis for cancellation flags to support multi-worker deployments.
    Uses subtask_id as the cancellation identifier.
    """

    def __init__(self):
        self._cache = cache_manager
        # Local asyncio events for in-process signaling (optimization)
        # Key: subtask_id, Value: asyncio.Event
        self._local_events: Dict[int, asyncio.Event] = {}

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

            logger.warning(
                f"Invalid history format for task {task_id}, returning empty list"
            )
            return []

        except Exception as e:
            logger.error(f"Error getting chat history for task {task_id}: {e}")
            return []

    async def save_chat_history(
        self, task_id: int, messages: List[Dict[str, str]], expire: Optional[int] = None
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
                logger.info(
                    f"Truncated chat history for task {task_id} to {max_messages} messages"
                )

            expire_time = expire or settings.CHAT_HISTORY_EXPIRE_SECONDS
            return await self._cache.set(key, messages, expire=expire_time)

        except Exception as e:
            logger.error(f"Error saving chat history for task {task_id}: {e}")
            return False

    async def append_message(self, task_id: int, role: str, content: str) -> bool:
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
        self, task_id: int, user_message: Any, assistant_message: str
    ) -> bool:
        """
        Append both user and assistant messages to chat history.

        This is the common pattern after a successful chat completion.

        Args:
            task_id: The task ID
            user_message: The user's message (string or vision dict)
            assistant_message: The assistant's response

        Returns:
            bool: True if append was successful
        """
        try:
            history = await self.get_chat_history(task_id)

            # Normalize user message content for storage
            # If it's a vision message dict, convert to standard OpenAI format
            if isinstance(user_message, dict) and user_message.get("type") == "vision":
                # Convert vision message to OpenAI format (array of content blocks)
                user_content = [
                    {"type": "text", "text": user_message.get("text", "")},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{user_message['mime_type']};base64,{user_message['image_base64']}"
                        },
                    },
                ]
            elif isinstance(user_message, str):
                # Regular text message
                user_content = user_message
            else:
                # Fallback: convert to string
                user_content = str(user_message)

            history.append({"role": "user", "content": user_content})
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

    # ==================== Cancellation Management ====================

    def _get_cancel_key(self, subtask_id: int) -> str:
        """Generate Redis key for cancellation flag."""
        return f"{CANCEL_KEY_PREFIX}{subtask_id}"

    async def register_stream(self, subtask_id: int) -> asyncio.Event:
        """
        Register a new streaming request and return its cancellation event.

        Creates a local asyncio.Event for in-process signaling and
        clears any existing cancellation flag in Redis.

        Args:
            subtask_id: The subtask ID for the stream

        Returns:
            asyncio.Event: Event that will be set when cancellation is requested
        """
        # Create local event for in-process signaling
        cancel_event = asyncio.Event()
        self._local_events[subtask_id] = cancel_event

        # Clear any existing cancellation flag in Redis (in case of retry)
        cancel_key = self._get_cancel_key(subtask_id)
        try:
            await self._cache.delete(cancel_key)
        except Exception as e:
            logger.warning(f"Failed to clear cancel flag for subtask {subtask_id}: {e}")

        return cancel_event

    async def cancel_stream(self, subtask_id: int) -> bool:
        """
        Request cancellation of a streaming request.

        Sets cancellation flag in Redis (for cross-worker communication)
        and also sets local event if the stream is in this process.

        Args:
            subtask_id: The subtask ID to cancel

        Returns:
            bool: True if cancellation flag was set successfully
        """
        cancel_key = self._get_cancel_key(subtask_id)

        # Set cancellation flag in Redis (cross-worker)
        try:
            success = await self._cache.set(cancel_key, True, expire=CANCEL_FLAG_TTL)
        except Exception as e:
            logger.error(
                f"Failed to set Redis cancel flag for subtask {subtask_id}: {e}"
            )
            success = False

        # Also set local event if stream is in this process (optimization)
        local_event = self._local_events.get(subtask_id)
        if local_event:
            local_event.set()

        return success

    async def unregister_stream(self, subtask_id: int):
        """
        Unregister a streaming request (cleanup after completion or cancellation).

        Removes local event and cleans up Redis cancellation flag.

        Args:
            subtask_id: The subtask ID to unregister
        """
        # Clean up local event
        if subtask_id in self._local_events:
            del self._local_events[subtask_id]

        # Clean up Redis cancellation flag
        cancel_key = self._get_cancel_key(subtask_id)
        try:
            await self._cache.delete(cancel_key)
        except Exception as e:
            logger.warning(
                f"Failed to delete cancel flag for subtask {subtask_id}: {e}"
            )

    async def is_cancelled(self, subtask_id: int) -> bool:
        """
        Check if a streaming request has been cancelled.

        Checks both local event (fast path) and Redis flag (cross-worker).
        If Redis flag is set, also sets local event for consistency.

        Args:
            subtask_id: The subtask ID to check

        Returns:
            bool: True if cancellation has been requested
        """
        # Fast path: check local event first
        local_event = self._local_events.get(subtask_id)
        if local_event and local_event.is_set():
            return True

        # Slow path: check Redis flag (for cross-worker cancellation)
        cancel_key = self._get_cancel_key(subtask_id)
        try:
            redis_flag = await self._cache.get(cancel_key)
            if redis_flag is True:
                # Set local event for consistency
                if local_event:
                    local_event.set()
                return True
        except Exception as e:
            logger.warning(
                f"Failed to check Redis cancel flag for subtask {subtask_id}: {e}"
            )

        return False

    # ==================== Streaming Content Cache ====================

    def _get_streaming_key(self, subtask_id: int) -> str:
        """Generate Redis key for streaming content cache."""
        return f"{STREAMING_KEY_PREFIX}{subtask_id}"

    async def save_streaming_content(
        self, subtask_id: int, content: str, expire: int = None
    ) -> bool:
        """
        Save streaming content to Redis (temporary cache).

        This is used for fast recovery when user refreshes during streaming.
        Content is saved frequently (every 1 second) to minimize data loss.

        Args:
            subtask_id: Subtask ID
            content: Current accumulated content
            expire: Expiration time in seconds (default from settings)

        Returns:
            bool: True if save was successful
        """
        try:
            key = self._get_streaming_key(subtask_id)
            expire_time = expire or settings.STREAMING_REDIS_TTL
            return await self._cache.set(key, content, expire=expire_time)
        except Exception as e:
            logger.error(
                f"Error saving streaming content for subtask {subtask_id}: {e}"
            )
            return False

    async def get_streaming_content(self, subtask_id: int) -> Optional[str]:
        """
        Get streaming content from Redis cache.

        Used for recovery when user refreshes during streaming.

        Args:
            subtask_id: Subtask ID

        Returns:
            str or None: Cached streaming content, or None if not found
        """
        try:
            key = self._get_streaming_key(subtask_id)
            content = await self._cache.get(key)
            if content is not None and isinstance(content, str):
                return content
            return None
        except Exception as e:
            logger.error(
                f"Error getting streaming content for subtask {subtask_id}: {e}"
            )
            return None

    async def delete_streaming_content(self, subtask_id: int) -> bool:
        """
        Delete streaming content from Redis cache.

        Called after streaming completes (success, cancel, or error).

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if delete was successful
        """
        try:
            key = self._get_streaming_key(subtask_id)
            return await self._cache.delete(key)
        except Exception as e:
            logger.error(
                f"Error deleting streaming content for subtask {subtask_id}: {e}"
            )
            return False

    def _get_channel_key(self, subtask_id: int) -> str:
        """Generate Redis Pub/Sub channel key for streaming updates."""
        return f"{STREAMING_CHANNEL_PREFIX}{subtask_id}"

    async def publish_streaming_chunk(self, subtask_id: int, chunk: str) -> bool:
        """
        Publish a streaming chunk to Redis Pub/Sub.

        This allows other clients (e.g., reconnected browsers) to receive
        real-time updates for an ongoing stream.

        Args:
            subtask_id: Subtask ID
            chunk: Content chunk to publish

        Returns:
            bool: True if publish was successful
        """
        try:
            channel = self._get_channel_key(subtask_id)
            # Get a Redis client for pub/sub
            redis_client = await self._cache._get_client()
            try:
                await redis_client.publish(channel, chunk)
                return True
            finally:
                await redis_client.aclose()
        except Exception as e:
            logger.error(
                f"Error publishing streaming chunk for subtask {subtask_id}: {e}"
            )
            return False

    async def publish_streaming_done(
        self, subtask_id: int, result: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Publish a "done" signal to Redis Pub/Sub with optional result data.

        The done signal is JSON-encoded and contains:
        - __type__: "STREAM_DONE" (marker to identify this as a done signal)
        - result: The final result data (optional)

        Args:
            subtask_id: Subtask ID
            result: Optional result data to include in the done signal

        Returns:
            bool: True if publish was successful
        """
        try:
            channel = self._get_channel_key(subtask_id)
            redis_client = await self._cache._get_client()
            try:
                # Encode done signal with result data
                done_message = json.dumps({"__type__": "STREAM_DONE", "result": result})
                await redis_client.publish(channel, done_message)
                return True
            finally:
                await redis_client.aclose()
        except Exception as e:
            logger.error(f"Error publishing stream done for subtask {subtask_id}: {e}")
            return False

    async def subscribe_streaming_channel(self, subtask_id: int):
        """
        Subscribe to a streaming channel for real-time updates.

        Args:
            subtask_id: Subtask ID

        Returns:
            Tuple of (Redis client, PubSub object) or (None, None)
            Caller is responsible for closing the client when done.
        """
        try:
            channel = self._get_channel_key(subtask_id)
            redis_client = await self._cache._get_client()
            pubsub = redis_client.pubsub()
            await pubsub.subscribe(channel)
            # Return both client and pubsub so caller can close client when done
            return redis_client, pubsub
        except Exception as e:
            logger.error(
                f"Error subscribing to streaming channel for subtask {subtask_id}: {e}"
            )
            return None, None

    # ==================== Task-Level Streaming Status (Group Chat) ====================

    def _get_task_streaming_key(self, task_id: int) -> str:
        """Generate Redis key for task-level streaming status."""
        return f"{TASK_STREAMING_KEY_PREFIX}{task_id}"

    async def set_task_streaming_status(
        self,
        task_id: int,
        subtask_id: int,
        user_id: int,
        username: str,
    ) -> bool:
        """
        Set task-level streaming status (used for group chat).

        Args:
            task_id: Task ID
            subtask_id: Subtask ID that is streaming
            user_id: User who triggered the stream
            username: Username of the user

        Returns:
            bool: True if set was successful
        """
        try:
            key = self._get_task_streaming_key(task_id)
            value = {
                "subtask_id": subtask_id,
                "user_id": user_id,
                "username": username,
                "started_at": datetime.now().isoformat(),
            }
            logger.info(
                f"[SessionManager] set_task_streaming_status: key={key}, "
                f"task_id={task_id}, subtask_id={subtask_id}, user_id={user_id}, "
                f"expire={TASK_STREAMING_TTL}"
            )
            result = await self._cache.set(key, value, expire=TASK_STREAMING_TTL)
            logger.info(f"[SessionManager] set_task_streaming_status result: {result}")
            return result
        except Exception as e:
            logger.error(
                f"Error setting task streaming status for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def get_task_streaming_status(self, task_id: int) -> Optional[Dict[str, Any]]:
        """
        Get task-level streaming status.

        Args:
            task_id: Task ID

        Returns:
            dict or None: Streaming status data, or None if not streaming
        """
        try:
            key = self._get_task_streaming_key(task_id)
            logger.info(
                f"[SessionManager] get_task_streaming_status: key={key}, task_id={task_id}"
            )
            result = await self._cache.get(key)
            logger.info(f"[SessionManager] get_task_streaming_status result: {result}")
            return result
        except Exception as e:
            logger.error(
                f"Error getting task streaming status for task {task_id}: {e}",
                exc_info=True,
            )
            return None

    async def clear_task_streaming_status(self, task_id: int) -> bool:
        """
        Clear task-level streaming status.

        Args:
            task_id: Task ID

        Returns:
            bool: True if clear was successful
        """
        try:
            key = self._get_task_streaming_key(task_id)
            logger.info(
                f"[SessionManager] clear_task_streaming_status: key={key}, task_id={task_id}"
            )
            result = await self._cache.delete(key)
            logger.info(
                f"[SessionManager] clear_task_streaming_status result: {result}"
            )
            return result
        except Exception as e:
            logger.error(
                f"Error clearing task streaming status for task {task_id}: {e}",
                exc_info=True,
            )
            return False


# Global session manager instance
session_manager = SessionManager()
