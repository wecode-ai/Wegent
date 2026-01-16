# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Executor streaming state manager.

Manages streaming state in Redis for executor tasks,
including content caching, state tracking, and pub/sub for real-time updates.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from app.core.cache import cache_manager
from app.schemas.streaming import StreamingStateData

logger = logging.getLogger(__name__)

# Redis key prefixes for executor streaming
EXECUTOR_STREAMING_CONTENT_PREFIX = "executor:streaming:"
EXECUTOR_STREAMING_STATE_PREFIX = "executor:streaming:state:"
EXECUTOR_STREAMING_CHANNEL_PREFIX = "executor:stream_channel:"
EXECUTOR_CANCEL_PREFIX = "executor:cancel:"

# TTL values (in seconds)
STREAMING_CONTENT_TTL = 3600  # 1 hour
STREAMING_STATE_TTL = 3600  # 1 hour
CANCEL_FLAG_TTL = 300  # 5 minutes


class ExecutorStreamingStateManager:
    """
    Manages executor streaming state in Redis.

    Provides methods for:
    - Storing and retrieving streaming content
    - Managing streaming session state
    - Publishing streaming events via Pub/Sub
    - Handling cancellation flags
    """

    def __init__(self):
        self._cache = cache_manager

    # ==================== Content Management ====================

    def _get_content_key(self, subtask_id: int) -> str:
        """Generate Redis key for streaming content."""
        return f"{EXECUTOR_STREAMING_CONTENT_PREFIX}{subtask_id}"

    async def save_streaming_content(
        self, subtask_id: int, content: str, expire: int = STREAMING_CONTENT_TTL
    ) -> bool:
        """
        Save accumulated streaming content to Redis.

        Args:
            subtask_id: Subtask ID
            content: Accumulated content string
            expire: TTL in seconds

        Returns:
            bool: True if save was successful
        """
        try:
            key = self._get_content_key(subtask_id)
            result = await self._cache.set(key, content, expire=expire)
            logger.debug(
                f"[ExecutorStreaming] Saved content for subtask {subtask_id}, "
                f"length={len(content)}"
            )
            return result
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to save content for subtask {subtask_id}: {e}"
            )
            return False

    async def get_streaming_content(self, subtask_id: int) -> Optional[str]:
        """
        Get streaming content from Redis.

        Args:
            subtask_id: Subtask ID

        Returns:
            str or None: Cached content, or None if not found
        """
        try:
            key = self._get_content_key(subtask_id)
            content = await self._cache.get(key)
            if content is not None and isinstance(content, str):
                return content
            return None
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to get content for subtask {subtask_id}: {e}"
            )
            return None

    async def append_streaming_content(
        self, subtask_id: int, chunk: str, expire: int = STREAMING_CONTENT_TTL
    ) -> tuple:
        """
        Append content chunk to existing content.

        Args:
            subtask_id: Subtask ID
            chunk: Content chunk to append
            expire: TTL in seconds

        Returns:
            Tuple of (success, new_total_length)
        """
        try:
            existing = await self.get_streaming_content(subtask_id) or ""
            new_content = existing + chunk
            success = await self.save_streaming_content(subtask_id, new_content, expire)
            return success, len(new_content)
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to append content for subtask {subtask_id}: {e}"
            )
            return False, 0

    async def delete_streaming_content(self, subtask_id: int) -> bool:
        """
        Delete streaming content from Redis.

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if delete was successful
        """
        try:
            key = self._get_content_key(subtask_id)
            return await self._cache.delete(key)
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to delete content for subtask {subtask_id}: {e}"
            )
            return False

    # ==================== State Management ====================

    def _get_state_key(self, subtask_id: int) -> str:
        """Generate Redis key for streaming state."""
        return f"{EXECUTOR_STREAMING_STATE_PREFIX}{subtask_id}"

    async def set_streaming_state(
        self,
        subtask_id: int,
        state: StreamingStateData,
        expire: int = STREAMING_STATE_TTL,
    ) -> bool:
        """
        Set streaming state in Redis.

        Args:
            subtask_id: Subtask ID
            state: StreamingStateData object
            expire: TTL in seconds

        Returns:
            bool: True if save was successful
        """
        try:
            key = self._get_state_key(subtask_id)
            state_dict = state.model_dump(mode="json")
            result = await self._cache.set(key, state_dict, expire=expire)
            logger.debug(
                f"[ExecutorStreaming] Set state for subtask {subtask_id}: "
                f"status={state.status}, content_length={state.content_length}"
            )
            return result
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to set state for subtask {subtask_id}: {e}"
            )
            return False

    async def get_streaming_state(
        self, subtask_id: int
    ) -> Optional[StreamingStateData]:
        """
        Get streaming state from Redis.

        Args:
            subtask_id: Subtask ID

        Returns:
            StreamingStateData or None if not found
        """
        try:
            key = self._get_state_key(subtask_id)
            state_dict = await self._cache.get(key)
            if state_dict and isinstance(state_dict, dict):
                return StreamingStateData.model_validate(state_dict)
            return None
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to get state for subtask {subtask_id}: {e}"
            )
            return None

    async def update_streaming_state(
        self, subtask_id: int, updates: Dict[str, Any]
    ) -> bool:
        """
        Update specific fields in streaming state.

        Args:
            subtask_id: Subtask ID
            updates: Dictionary of fields to update

        Returns:
            bool: True if update was successful
        """
        try:
            state = await self.get_streaming_state(subtask_id)
            if not state:
                return False

            # Update fields
            for key, value in updates.items():
                if hasattr(state, key):
                    setattr(state, key, value)

            state.last_update_at = datetime.now()
            return await self.set_streaming_state(subtask_id, state)
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to update state for subtask {subtask_id}: {e}"
            )
            return False

    async def delete_streaming_state(self, subtask_id: int) -> bool:
        """
        Delete streaming state from Redis.

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if delete was successful
        """
        try:
            key = self._get_state_key(subtask_id)
            return await self._cache.delete(key)
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to delete state for subtask {subtask_id}: {e}"
            )
            return False

    # ==================== Pub/Sub Management ====================

    def _get_channel_key(self, subtask_id: int) -> str:
        """Generate Redis Pub/Sub channel key."""
        return f"{EXECUTOR_STREAMING_CHANNEL_PREFIX}{subtask_id}"

    async def publish_streaming_event(
        self, subtask_id: int, event_type: str, data: Dict[str, Any]
    ) -> bool:
        """
        Publish a streaming event to Redis Pub/Sub.

        Args:
            subtask_id: Subtask ID
            event_type: Type of event (chunk, done, error)
            data: Event data

        Returns:
            bool: True if publish was successful
        """
        try:
            channel = self._get_channel_key(subtask_id)
            message = json.dumps({"event_type": event_type, "data": data})

            redis_client = await self._cache._get_client()
            try:
                await redis_client.publish(channel, message)
                logger.debug(
                    f"[ExecutorStreaming] Published {event_type} event for subtask {subtask_id}"
                )
                return True
            finally:
                await redis_client.aclose()
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to publish event for subtask {subtask_id}: {e}"
            )
            return False

    async def publish_stream_done(
        self, subtask_id: int, result: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Publish stream done signal.

        Args:
            subtask_id: Subtask ID
            result: Final result data

        Returns:
            bool: True if publish was successful
        """
        try:
            channel = self._get_channel_key(subtask_id)
            message = json.dumps({"__type__": "STREAM_DONE", "result": result})

            redis_client = await self._cache._get_client()
            try:
                await redis_client.publish(channel, message)
                logger.info(
                    f"[ExecutorStreaming] Published stream_done for subtask {subtask_id}"
                )
                return True
            finally:
                await redis_client.aclose()
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to publish stream_done for subtask {subtask_id}: {e}"
            )
            return False

    async def subscribe_streaming_channel(self, subtask_id: int):
        """
        Subscribe to a streaming channel.

        Args:
            subtask_id: Subtask ID

        Returns:
            Tuple of (Redis client, PubSub object) or (None, None)
        """
        try:
            channel = self._get_channel_key(subtask_id)
            redis_client = await self._cache._get_client()
            pubsub = redis_client.pubsub()
            await pubsub.subscribe(channel)
            return redis_client, pubsub
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to subscribe for subtask {subtask_id}: {e}"
            )
            return None, None

    # ==================== Cancellation Management ====================

    def _get_cancel_key(self, subtask_id: int) -> str:
        """Generate Redis key for cancellation flag."""
        return f"{EXECUTOR_CANCEL_PREFIX}{subtask_id}"

    async def set_cancel_flag(self, subtask_id: int) -> bool:
        """
        Set cancellation flag for a streaming session.

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if flag was set successfully
        """
        try:
            key = self._get_cancel_key(subtask_id)
            return await self._cache.set(key, True, expire=CANCEL_FLAG_TTL)
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to set cancel flag for subtask {subtask_id}: {e}"
            )
            return False

    async def is_cancelled(self, subtask_id: int) -> bool:
        """
        Check if a streaming session has been cancelled.

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if cancelled
        """
        try:
            key = self._get_cancel_key(subtask_id)
            result = await self._cache.get(key)
            return result is True
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to check cancel flag for subtask {subtask_id}: {e}"
            )
            return False

    async def clear_cancel_flag(self, subtask_id: int) -> bool:
        """
        Clear cancellation flag.

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if cleared successfully
        """
        try:
            key = self._get_cancel_key(subtask_id)
            return await self._cache.delete(key)
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to clear cancel flag for subtask {subtask_id}: {e}"
            )
            return False

    # ==================== Cleanup ====================

    async def cleanup_streaming_session(self, subtask_id: int) -> bool:
        """
        Clean up all Redis keys for a streaming session.

        Args:
            subtask_id: Subtask ID

        Returns:
            bool: True if cleanup was successful
        """
        try:
            await self.delete_streaming_content(subtask_id)
            await self.delete_streaming_state(subtask_id)
            await self.clear_cancel_flag(subtask_id)
            logger.info(
                f"[ExecutorStreaming] Cleaned up session for subtask {subtask_id}"
            )
            return True
        except Exception as e:
            logger.error(
                f"[ExecutorStreaming] Failed to cleanup session for subtask {subtask_id}: {e}"
            )
            return False


# Global singleton instance
executor_streaming_state = ExecutorStreamingStateManager()
