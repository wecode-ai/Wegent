# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session manager for Chat Shell.

Manages chat history and session state in Redis for multi-turn conversations.
Also manages cancellation state for streaming chat requests using Redis
for cross-worker communication in multi-worker deployments.

Additionally manages streaming content and blocks for mixed content rendering,
supporting page refresh recovery during streaming.
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from redis.exceptions import WatchError

from app.core.bounded_executor import BoundedExecutor
from app.core.cache import cache_manager
from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.services.chat.storage import session_codec
from shared.models.blocks import BlockStatus, create_text_block, create_tool_block

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
# Redis key prefix for latest context metrics snapshot
CONTEXT_METRICS_KEY_PREFIX = "chat:context_metrics:"
# Redis Pub/Sub channel prefix for callback-based SSE streaming (ClaudeCode/Agno/Dify)
CALLBACK_CHANNEL_PREFIX = "callback:channel:"
CALLBACK_CODEC_MAX_WORKERS = 2
CALLBACK_CODEC_MAX_IN_FLIGHT = 16
# Unified TTL for all streaming-related data (1 hour)
STREAMING_TTL = 3600
# Redis stream recovery is deliberately bounded per subtask. These are byte
# limits, while client resume cursors remain Unicode character offsets.
MAX_STREAMING_CONTENT_BYTES = 1024 * 1024
MAX_STREAM_BLOCKS = 128
MAX_STREAM_BLOCK_ID_BYTES = 256
MAX_BLOCK_METADATA_BYTES = 128 * 1024
MAX_TOTAL_BLOCK_METADATA_BYTES = 1024 * 1024
MAX_BLOCK_CONTENT_BYTES = 1024 * 1024
MAX_TOTAL_BLOCK_CONTENT_BYTES = 2 * 1024 * 1024
STREAM_STATE_TRANSACTION_ATTEMPTS = 4
# Internal field stored in Redis block metadata. It is stripped before returning
# blocks to callers so API consumers still see the existing block shape.
BLOCK_CONTENT_KEY_FIELD = "_content_key"
BLOCK_METADATA_BYTES_FIELD = "metadata_bytes"
BLOCK_CONTENT_BYTES_FIELD = "content_bytes"
UNRESOLVED_PREVIEW_TOOL_BLOCK_STATUSES = {"pending", "generating_arguments"}
UNRESOLVED_PREVIEW_TOOL_BLOCK_MESSAGE = "Tool call was not executed before the turn completed. The turn may have hit the tool-call limit."
UNRESOLVED_PREVIEW_TOOL_BLOCK_GENERIC_MESSAGE = (
    "Tool call preview did not complete before the turn ended."
)

_callback_codec_executor = BoundedExecutor(
    max_workers=CALLBACK_CODEC_MAX_WORKERS,
    max_in_flight=CALLBACK_CODEC_MAX_IN_FLIGHT,
    thread_name_prefix="wegent-callback-codec",
)

_CONTENT_LENGTHS_SCRIPT = """
local lengths = {}
for index, key in ipairs(KEYS) do
    lengths[index] = redis.call('STRLEN', key)
end
return lengths
"""


class StreamingStateError(RuntimeError):
    """Base error for bounded Redis streaming state."""


class StreamingStateLimitError(StreamingStateError):
    """Raised when one streaming state write or snapshot exceeds its hard cap."""


class StreamingStateCorruptionError(StreamingStateError):
    """Raised when Redis streaming state violates the bounded representation."""


class StreamingStateConflictError(StreamingStateError):
    """Raised after bounded Redis transaction retries are exhausted."""


class _ActiveBlockConflict(StreamingStateConflictError):
    """Internal signal that a stream boundary raced with another append."""


def _serialize_callback_event(event: Any) -> str:
    """Serialize a callback DTO outside the serving event loop."""
    return json.dumps(event.to_dict())


async def _encode_callback_event(event: Any) -> str:
    return await _callback_codec_executor.run(_serialize_callback_event, event)


def _redis_value_size(value: Any) -> int:
    """Return the exact Redis string payload size for supported values."""
    if isinstance(value, bytes):
        return len(value)
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    return len(str(value).encode("utf-8"))


def _require_max_bytes(name: str, value: Any, maximum: int) -> int:
    size = _redis_value_size(value)
    if size > maximum:
        raise StreamingStateLimitError(
            f"{name} uses {size} bytes; maximum is {maximum} bytes"
        )
    return size


def _decode_counter(value: Any, field: str) -> int:
    try:
        counter = int(value)
    except (TypeError, ValueError) as error:
        raise StreamingStateCorruptionError(
            f"Redis streaming usage field {field!r} is missing or invalid"
        ) from error
    if counter < 0:
        raise StreamingStateCorruptionError(
            f"Redis streaming usage field {field!r} is negative"
        )
    return counter


def _normalize_streaming_timestamp(value: Any) -> Any:
    """Normalize timezone-aware timestamps and reject ambiguous legacy values."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat()


class StreamContentType(str, Enum):
    """Content-bearing streaming event types persisted in Redis."""

    TEXT = "text"
    THINKING = "thinking"


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

    async def attach_stream(self, subtask_id: int) -> asyncio.Event:
        """Attach a worker to an existing distributed stream lifecycle.

        Unlike ``register_stream``, attaching must preserve a cancellation flag
        that may have been written before the worker accepted the IPC request.
        """
        cancel_event = asyncio.Event()
        self._local_events[subtask_id] = cancel_event
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

    def _get_context_metrics_key(self, subtask_id: int) -> str:
        """Generate Redis key for the latest context metrics snapshot."""
        return f"{CONTEXT_METRICS_KEY_PREFIX}{subtask_id}"

    async def _read_bounded_streaming_content(
        self,
        redis_client: Any,
        key: str,
    ) -> Any:
        """Read one size-checked Redis string from a consistent snapshot."""
        for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
            try:
                async with redis_client.pipeline(transaction=True) as pipe:
                    await pipe.watch(key)
                    byte_length = int(await pipe.strlen(key) or 0)
                    if byte_length > MAX_STREAMING_CONTENT_BYTES:
                        raise StreamingStateLimitError(
                            "Accumulated streaming content uses "
                            f"{byte_length} bytes; maximum is "
                            f"{MAX_STREAMING_CONTENT_BYTES} bytes"
                        )
                    content = await pipe.get(key)
                    if (
                        content is not None
                        and _redis_value_size(content) != byte_length
                    ):
                        raise StreamingStateCorruptionError(
                            "Accumulated streaming content length changed inside snapshot"
                        )
                    pipe.multi()
                    pipe.strlen(key)
                    await pipe.execute()
                    return content
            except WatchError:
                if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                    break
        raise StreamingStateConflictError(
            "Accumulated streaming content changed during every snapshot attempt"
        )

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
        _require_max_bytes(
            "Accumulated streaming content",
            content,
            MAX_STREAMING_CONTENT_BYTES,
        )
        try:
            key = self._get_streaming_key(subtask_id)
            expire_time = expire or settings.STREAMING_REDIS_TTL
            redis_client = await self._cache._get_client()
            try:
                return bool(await redis_client.set(key, content, ex=expire_time))
            finally:
                await redis_client.aclose()
        except StreamingStateError:
            raise
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
            redis_client = await self._cache._get_client()
            try:
                content = await self._read_bounded_streaming_content(
                    redis_client,
                    key,
                )
                if content is not None:
                    result = await run_payload_codec(
                        session_codec.decode_redis_text,
                        content,
                        payload_hint=content,
                    )
                    logger.debug(
                        f"[SessionManager] get_streaming_content: subtask_id={subtask_id}, "
                        f"content_len={len(result)}, content_preview={result[:100] if result else 'None'}..."
                    )
                    return result
                logger.debug(
                    f"[SessionManager] get_streaming_content: subtask_id={subtask_id}, "
                    f"content=None (key not found)"
                )
                return None
            finally:
                await redis_client.aclose()
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"Error getting streaming content for subtask {subtask_id}: {e}"
            )
            return None

    async def get_streaming_content_length(self, subtask_id: int) -> int:
        """Return the Unicode character cursor for recovery comparisons."""
        content = await self.get_streaming_content(subtask_id)
        return len(content) if content is not None else 0

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

    async def save_context_metrics(
        self,
        subtask_id: int,
        context_metrics: Dict[str, Any],
        expire: int = None,
    ) -> bool:
        """Save the latest context metrics snapshot for refresh recovery."""
        try:
            key = self._get_context_metrics_key(subtask_id)
            expire_time = expire or settings.STREAMING_REDIS_TTL
            return await self._cache.set(key, context_metrics, expire=expire_time)
        except Exception as e:
            logger.error(
                "Error saving context metrics for subtask %s: %s",
                subtask_id,
                e,
            )
            return False

    async def get_context_metrics(self, subtask_id: int) -> Optional[Dict[str, Any]]:
        """Get the latest cached context metrics snapshot."""
        try:
            key = self._get_context_metrics_key(subtask_id)
            value = await self._cache.get(key)
            return value if isinstance(value, dict) else None
        except Exception as e:
            logger.error(
                "Error getting context metrics for subtask %s: %s",
                subtask_id,
                e,
            )
            return None

    async def delete_context_metrics(self, subtask_id: int) -> bool:
        """Delete cached context metrics snapshot."""
        try:
            key = self._get_context_metrics_key(subtask_id)
            return await self._cache.delete(key)
        except Exception as e:
            logger.error(
                "Error deleting context metrics for subtask %s: %s",
                subtask_id,
                e,
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
                done_message = await run_payload_codec(
                    session_codec.serialize_stream_done,
                    result,
                    payload_hint=result,
                )
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

    # ==================== Callback Event Pub/Sub (ClaudeCode/Agno streaming) ====================

    def _get_callback_channel_key(self, subtask_id: int) -> str:
        """Generate Redis Pub/Sub channel key for callback-based streaming."""
        return f"{CALLBACK_CHANNEL_PREFIX}{subtask_id}"

    async def publish_callback_event(self, subtask_id: int, event: Any) -> bool:
        """Publish an execution event to the callback stream channel.

        Used by the /internal/callback handler to forward executor events to
        any SSE consumers that are streaming a ClaudeCode/Agno/Dify task.

        Args:
            subtask_id: Subtask ID
            event: ExecutionEvent instance with to_dict() method

        Returns:
            bool: True if publish was successful
        """
        try:
            channel = self._get_callback_channel_key(subtask_id)
            event_json = await _encode_callback_event(event)
            redis_client = await self._cache._get_client()
            try:
                await redis_client.publish(channel, event_json)
                return True
            finally:
                await redis_client.aclose()
        except Exception as e:
            logger.error(
                f"[SessionManager] publish_callback_event failed for subtask {subtask_id}: {e}"
            )
            return False

    async def subscribe_callback_channel(self, subtask_id: int):
        """Subscribe to the callback event channel for a subtask.

        Returns (redis_client, pubsub) so the caller can poll with
        pubsub.get_message() and close the client when done.

        Args:
            subtask_id: Subtask ID

        Returns:
            Tuple of (redis_client, pubsub) or (None, None) on failure.
        """
        try:
            channel = self._get_callback_channel_key(subtask_id)
            redis_client = await self._cache._get_client()
            pubsub = redis_client.pubsub()
            await pubsub.subscribe(channel)
            return redis_client, pubsub
        except Exception as e:
            logger.error(
                f"[SessionManager] subscribe_callback_channel failed for subtask {subtask_id}: {e}"
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
            now_iso = datetime.now(timezone.utc).isoformat()
            value = {
                "subtask_id": subtask_id,
                "user_id": user_id,
                "username": username,
                "started_at": now_iso,
                "last_activity_at": now_iso,
            }
            logger.info(
                f"[SessionManager] set_task_streaming_status: key={key}, "
                f"task_id={task_id}, subtask_id={subtask_id}, user_id={user_id}, "
                f"expire={STREAMING_TTL}"
            )
            result = await self._cache.set(key, value, expire=STREAMING_TTL)
            logger.info(f"[SessionManager] set_task_streaming_status result: {result}")
            return result
        except Exception as e:
            logger.error(
                f"Error setting task streaming status for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def touch_task_streaming_activity(self, task_id: int) -> bool:
        """
        Refresh task-level streaming last activity timestamp.

        Args:
            task_id: Task ID

        Returns:
            bool: True if updated successfully, False otherwise
        """
        try:
            key = self._get_task_streaming_key(task_id)
            status = await self._cache.get(key)
            if not status:
                return False

            if not isinstance(status, dict):
                logger.warning(
                    "[SessionManager] Invalid task streaming status format for task_id=%s",
                    task_id,
                )
                return False

            status["last_activity_at"] = datetime.now(timezone.utc).isoformat()
            return await self._cache.set(key, status, expire=STREAMING_TTL)
        except Exception as e:
            logger.error(
                f"Error touching task streaming activity for task {task_id}: {e}",
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
            if isinstance(result, dict):
                result = dict(result)
                result["started_at"] = _normalize_streaming_timestamp(
                    result.get("started_at")
                )
                result["last_activity_at"] = _normalize_streaming_timestamp(
                    result.get("last_activity_at")
                )
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

    # ==================== Blocks Collection (Mixed Content Rendering) ====================
    # Uses Redis atomic operations for high performance:
    # - accumulated_content: APPEND for O(1) content addition
    # - blocks: RPUSH for O(1) block addition
    # - current_text_block_id: separate key for O(1) read/write

    def _get_blocks_key(self, subtask_id: int) -> str:
        """Generate Redis key for blocks list."""
        return f"{STREAMING_KEY_PREFIX}blocks:{subtask_id}"

    def _get_current_text_block_key(self, subtask_id: int) -> str:
        """Generate Redis key for current text block ID."""
        return f"{STREAMING_KEY_PREFIX}text_block:{subtask_id}"

    def _get_current_thinking_block_key(self, subtask_id: int) -> str:
        """Generate Redis key for current thinking block ID."""
        return f"{STREAMING_KEY_PREFIX}thinking_block:{subtask_id}"

    def _get_block_content_key(self, subtask_id: int, block_id: str) -> str:
        """Generate Redis key for high-frequency stream block content."""
        return f"{STREAMING_KEY_PREFIX}block_content:{subtask_id}:{block_id}"

    def _get_blocks_usage_key(self, subtask_id: int) -> str:
        """Generate the key holding byte counters for bounded block state."""
        return f"{STREAMING_KEY_PREFIX}blocks_usage:{subtask_id}"

    async def _read_raw_block_state(
        self,
        pipe: Any,
        subtask_id: int,
        blocks_key: str,
        usage_key: str,
    ) -> tuple[List[Any], int, int]:
        """Read bounded metadata plus its atomically maintained byte counters."""
        block_count = int(await pipe.llen(blocks_key) or 0)
        if block_count > MAX_STREAM_BLOCKS:
            raise StreamingStateLimitError(
                f"Stream has {block_count} blocks; maximum is {MAX_STREAM_BLOCKS}"
            )

        blocks_raw = await pipe.lrange(blocks_key, 0, MAX_STREAM_BLOCKS - 1)
        if len(blocks_raw) != block_count:
            raise StreamingStateCorruptionError(
                "Block count changed inside the watched Redis snapshot"
            )
        actual_metadata_bytes = 0
        for block_raw in blocks_raw:
            actual_metadata_bytes += _require_max_bytes(
                "Block metadata",
                block_raw,
                MAX_BLOCK_METADATA_BYTES,
            )
        if actual_metadata_bytes > MAX_TOTAL_BLOCK_METADATA_BYTES:
            raise StreamingStateLimitError(
                "Block metadata usage exceeds the hard per-stream limit"
            )

        metadata_raw = await pipe.hget(usage_key, BLOCK_METADATA_BYTES_FIELD)
        content_raw = await pipe.hget(usage_key, BLOCK_CONTENT_BYTES_FIELD)
        if metadata_raw is None and content_raw is None:
            if not blocks_raw:
                return [], 0, 0
            return await self._measure_legacy_block_state(
                pipe,
                subtask_id,
                blocks_raw,
                actual_metadata_bytes,
            )
        if metadata_raw is None or content_raw is None:
            raise StreamingStateCorruptionError(
                "Redis streaming usage counters are incomplete"
            )

        metadata_bytes = _decode_counter(
            metadata_raw,
            BLOCK_METADATA_BYTES_FIELD,
        )
        content_bytes = _decode_counter(content_raw, BLOCK_CONTENT_BYTES_FIELD)
        if metadata_bytes > MAX_TOTAL_BLOCK_METADATA_BYTES:
            raise StreamingStateLimitError(
                "Block metadata usage exceeds the hard per-stream limit"
            )
        if content_bytes > MAX_TOTAL_BLOCK_CONTENT_BYTES:
            raise StreamingStateLimitError(
                "Block content usage exceeds the hard per-stream limit"
            )
        if actual_metadata_bytes != metadata_bytes:
            raise StreamingStateCorruptionError(
                "Block metadata byte counter does not match the Redis list"
            )
        return blocks_raw, metadata_bytes, content_bytes

    async def _measure_legacy_block_state(
        self,
        pipe: Any,
        subtask_id: int,
        blocks_raw: List[Any],
        metadata_bytes: int,
    ) -> tuple[List[Any], int, int]:
        """Bound an active stream created before usage counters existed."""
        try:
            blocks, content_refs = await run_payload_codec(
                session_codec.decode_block_metadata,
                blocks_raw,
                BLOCK_CONTENT_KEY_FIELD,
                payload_hint=blocks_raw,
            )
        except Exception as error:
            raise StreamingStateCorruptionError(
                "Legacy block metadata is not valid JSON"
            ) from error
        content_keys = self._validate_block_content_refs(
            subtask_id,
            blocks,
            content_refs,
        )
        if content_keys:
            await pipe.watch(*content_keys)
            lengths = await pipe.eval(
                _CONTENT_LENGTHS_SCRIPT,
                len(content_keys),
                *content_keys,
            )
        else:
            lengths = []
        content_bytes = 0
        for length in lengths:
            block_bytes = int(length or 0)
            if block_bytes > MAX_BLOCK_CONTENT_BYTES:
                raise StreamingStateLimitError(
                    "Legacy block content exceeds the per-block byte limit"
                )
            content_bytes += block_bytes
        if content_bytes > MAX_TOTAL_BLOCK_CONTENT_BYTES:
            raise StreamingStateLimitError(
                "Legacy block content exceeds the per-stream byte limit"
            )
        return blocks_raw, metadata_bytes, content_bytes

    def _validate_block_content_refs(
        self,
        subtask_id: int,
        blocks: List[Dict[str, Any]],
        content_refs: List[tuple[int, str]],
    ) -> List[str]:
        """Require every external content key to be owned by this subtask/block."""
        keys: List[str] = []
        for block_index, content_key in content_refs:
            block_id = blocks[block_index].get("id")
            if not isinstance(block_id, str) or not block_id:
                raise StreamingStateCorruptionError(
                    "External block content is missing a valid block id"
                )
            _require_max_bytes("Block id", block_id, MAX_STREAM_BLOCK_ID_BYTES)
            if content_key != self._get_block_content_key(subtask_id, block_id):
                raise StreamingStateCorruptionError(
                    "External block content key is not owned by its block"
                )
            if content_key in keys:
                raise StreamingStateCorruptionError(
                    "Multiple blocks reference the same external content key"
                )
            keys.append(content_key)
        return keys

    async def _load_blocks_from_client(
        self,
        redis_client: Any,
        subtask_id: int,
        blocks_key: str,
    ) -> List[Dict[str, Any]]:
        """Load block metadata and hydrate content from per-block content keys."""
        usage_key = self._get_blocks_usage_key(subtask_id)
        for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
            try:
                async with redis_client.pipeline(transaction=True) as pipe:
                    await pipe.watch(blocks_key, usage_key)
                    blocks_raw, _, content_usage = await self._read_raw_block_state(
                        pipe,
                        subtask_id,
                        blocks_key,
                        usage_key,
                    )
                    if not blocks_raw:
                        return []
                    try:
                        blocks, content_refs = await run_payload_codec(
                            session_codec.decode_block_metadata,
                            blocks_raw,
                            BLOCK_CONTENT_KEY_FIELD,
                            payload_hint=blocks_raw,
                        )
                    except Exception as error:
                        raise StreamingStateCorruptionError(
                            "Block metadata is not valid JSON"
                        ) from error
                    content_keys = self._validate_block_content_refs(
                        subtask_id,
                        blocks,
                        content_refs,
                    )
                    content_values = await self._read_block_content_snapshot(
                        pipe,
                        content_keys,
                        content_usage,
                    )
                return await run_payload_codec(
                    session_codec.hydrate_block_content,
                    blocks,
                    content_refs,
                    content_values,
                    BLOCK_CONTENT_KEY_FIELD,
                    payload_hint=(blocks, content_values),
                )
            except WatchError:
                if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                    break
        raise StreamingStateConflictError(
            "Block state changed during every snapshot attempt"
        )

    async def _read_block_content_snapshot(
        self,
        pipe: Any,
        content_keys: List[str],
        expected_total_bytes: int,
    ) -> List[Any]:
        """Read content only after server-side lengths pass all hard limits."""
        if content_keys:
            await pipe.watch(*content_keys)
            lengths = await pipe.eval(
                _CONTENT_LENGTHS_SCRIPT,
                len(content_keys),
                *content_keys,
            )
        else:
            lengths = []
        total_bytes = 0
        for length in lengths:
            content_bytes = int(length or 0)
            if content_bytes > MAX_BLOCK_CONTENT_BYTES:
                raise StreamingStateLimitError(
                    "One block content value exceeds the hard byte limit"
                )
            total_bytes += content_bytes
        if total_bytes != expected_total_bytes:
            raise StreamingStateCorruptionError(
                "Block content byte counter does not match Redis values"
            )

        pipe.multi()
        if content_keys:
            pipe.mget(content_keys)
        else:
            pipe.ping()
        results = await pipe.execute()
        if not content_keys:
            return []
        content_values = results[0]
        for value, expected_length in zip(content_values, lengths):
            if value is not None and _redis_value_size(value) != int(expected_length):
                raise StreamingStateCorruptionError(
                    "Block content length changed inside Redis transaction"
                )
        return content_values

    async def add_stream_content(
        self,
        subtask_id: int,
        content_type: StreamContentType,
        content: str,
    ) -> bool:
        """Add buffered stream content by explicit content type."""
        if content_type == StreamContentType.TEXT:
            return await self.add_text_content(subtask_id, content)
        if content_type == StreamContentType.THINKING:
            return await self.add_thinking_content(subtask_id, content)

        logger.warning(
            "[SessionManager] Unsupported stream content type for subtask %s: %s",
            subtask_id,
            content_type,
        )
        return False

    async def add_tool_block(
        self,
        subtask_id: int,
        tool_use_id: str,
        tool_name: str,
        tool_input: Optional[Dict[str, Any]] = None,
        display_name: Optional[str] = None,
        tool_protocol: Optional[str] = None,
        server_label: Optional[str] = None,
    ) -> None:
        """Add a tool block for a subtask.

        This also finalizes any current text block before upserting the tool block.
        Reuses block ids to make duplicate start callbacks idempotent.

        Args:
            subtask_id: Subtask ID
            tool_use_id: Tool use ID
            tool_name: Tool name
            tool_input: Tool input parameters
            display_name: Optional display name for the tool
            tool_protocol: Optional Responses protocol type
            server_label: Optional MCP server label
        """
        try:
            # Finalize current text block before adding tool block
            await self._finalize_current_text_block(subtask_id)
            await self._finalize_current_thinking_block(subtask_id)

            # Create tool block using unified function
            block = create_tool_block(
                tool_use_id=tool_use_id,
                tool_name=tool_name,
                tool_input=tool_input,
                display_name=display_name,
                tool_protocol=tool_protocol,
                server_label=server_label,
            )

            # Upsert by block id so callback retries do not duplicate tool blocks.
            await self.add_block(subtask_id, block)

            logger.debug(
                f"[SessionManager] Upserted tool block for subtask {subtask_id}: "
                f"id={block['id']}, tool_name={tool_name}"
            )
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to add tool block for subtask {subtask_id}: {e}"
            )

    async def update_tool_block_status(
        self,
        subtask_id: int,
        tool_use_id: str,
        status: Optional[str] = None,
        tool_output: Optional[str] = None,
        tool_input: Optional[Dict[str, Any]] = None,
        render_payload: Optional[Dict[str, Any]] = None,
        tool_protocol: Optional[str] = None,
        server_label: Optional[str] = None,
    ) -> None:
        """Update tool block status, output, and/or input.

        This is a convenience wrapper around add_block() for tool blocks.
        It retrieves the existing block, updates the specified fields, and
        calls add_block() with upsert semantics.

        Args:
            subtask_id: Subtask ID
            tool_use_id: Tool use ID
            status: New status (optional, e.g. "done", "error")
            tool_output: Optional tool output to set
            tool_input: Optional tool input/arguments to update
            render_payload: Optional UI-only renderer payload to update
            tool_protocol: Optional Responses protocol type
            server_label: Optional MCP server label
        """
        try:
            # Get existing blocks to find the tool block
            blocks = await self.get_blocks(subtask_id)
            existing_block = None
            for block in blocks:
                if (
                    block.get("type") == "tool"
                    and block.get("tool_use_id") == tool_use_id
                ):
                    existing_block = block
                    break

            if existing_block:
                # Update existing block
                if status is not None:
                    existing_block["status"] = status
                if tool_output is not None:
                    existing_block["tool_output"] = tool_output
                if tool_input is not None:
                    existing_block["tool_input"] = tool_input
                if render_payload is not None:
                    existing_block["render_payload"] = render_payload
                if tool_protocol is not None:
                    existing_block["tool_protocol"] = tool_protocol
                if server_label is not None:
                    existing_block["server_label"] = server_label
                await self.add_block(subtask_id, existing_block)
                logger.debug(
                    f"[SessionManager] Updated tool block for subtask {subtask_id}: "
                    f"id={tool_use_id}, status={status}, "
                    f"has_tool_input={tool_input is not None}"
                )
            else:
                logger.warning(
                    f"[SessionManager] Tool block not found for subtask {subtask_id}: "
                    f"tool_use_id={tool_use_id}"
                )
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to update tool block status for subtask {subtask_id}: {e}"
            )

    async def add_block(self, subtask_id: int, block: Dict[str, Any]) -> None:
        """Add or update a block for the subtask.

        This is the unified method for block management (upsert semantics):
        - If block with same id exists -> update it
        - If block doesn't exist -> append it
        - If no id provided -> generate one and append

        Used for custom block types like subscription_preview, video, image,
        and also as the internal implementation for tool block updates.

        Args:
            subtask_id: Subtask ID
            block: Block data dict with at least 'type', optionally 'id'
        """
        if BLOCK_CONTENT_KEY_FIELD in block:
            raise StreamingStateCorruptionError(
                f"{BLOCK_CONTENT_KEY_FIELD} is reserved for Redis storage"
            )
        block_id = block.get("id")
        if not block_id:
            block_id = f"block-{int(time.time() * 1000)}"
            block["id"] = block_id
        if not isinstance(block_id, str):
            raise StreamingStateCorruptionError("Block id must be a string")
        _require_max_bytes("Block id", block_id, MAX_STREAM_BLOCK_ID_BYTES)
        if "timestamp" not in block:
            block["timestamp"] = int(time.time() * 1000)

        try:
            for transition_attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
                await self._finalize_current_text_block(subtask_id)
                await self._finalize_current_thinking_block(subtask_id)
                try:
                    await self._upsert_block_atomic(
                        subtask_id,
                        block_id,
                        block,
                    )
                    return
                except _ActiveBlockConflict:
                    if transition_attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                        raise
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to add block for subtask {subtask_id}: {e}"
            )

    async def _upsert_block_atomic(
        self,
        subtask_id: int,
        block_id: str,
        block: Dict[str, Any],
    ) -> None:
        """Atomically upsert one block and both storage usage counters."""
        redis_client = await self._cache._get_client()
        try:
            for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
                try:
                    await self._upsert_block_once(
                        redis_client,
                        subtask_id,
                        block_id,
                        block,
                    )
                    return
                except WatchError:
                    if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                        break
        finally:
            await redis_client.aclose()
        raise StreamingStateConflictError(
            "Block state changed during every atomic upsert attempt"
        )

    async def _upsert_block_once(
        self,
        redis_client: Any,
        subtask_id: int,
        block_id: str,
        block: Dict[str, Any],
    ) -> None:
        blocks_key = self._get_blocks_key(subtask_id)
        usage_key = self._get_blocks_usage_key(subtask_id)
        text_key = self._get_current_text_block_key(subtask_id)
        thinking_key = self._get_current_thinking_block_key(subtask_id)
        async with redis_client.pipeline(transaction=True) as pipe:
            await pipe.watch(blocks_key, usage_key, text_key, thinking_key)
            if await pipe.get(text_key) or await pipe.get(thinking_key):
                raise _ActiveBlockConflict(
                    "A content block became active during the block boundary"
                )
            blocks_raw, metadata_usage, content_usage = (
                await self._read_raw_block_state(
                    pipe,
                    subtask_id,
                    blocks_key,
                    usage_key,
                )
            )
            try:
                prepared = await run_payload_codec(
                    session_codec.prepare_block_upsert,
                    blocks_raw,
                    block_id,
                    block,
                    BLOCK_CONTENT_KEY_FIELD,
                    payload_hint=(blocks_raw, block),
                )
            except Exception as error:
                raise StreamingStateCorruptionError(
                    "Block upsert metadata is not valid JSON"
                ) from error
            existing_index, serialized, content_key, content_value = prepared
            new_metadata_bytes = _require_max_bytes(
                "Block metadata",
                serialized,
                MAX_BLOCK_METADATA_BYTES,
            )
            if existing_index is None:
                if len(blocks_raw) >= MAX_STREAM_BLOCKS:
                    raise StreamingStateLimitError(
                        f"Stream already has {MAX_STREAM_BLOCKS} blocks"
                    )
                old_metadata_bytes = 0
            else:
                old_metadata_bytes = _redis_value_size(blocks_raw[existing_index])
            next_metadata_usage = (
                metadata_usage - old_metadata_bytes + new_metadata_bytes
            )
            if next_metadata_usage > MAX_TOTAL_BLOCK_METADATA_BYTES:
                raise StreamingStateLimitError(
                    "Block metadata write exceeds the per-stream byte limit"
                )
            next_content_usage = await self._prepare_upsert_content(
                pipe,
                subtask_id,
                block_id,
                content_key,
                content_value,
                content_usage,
            )
            pipe.multi()
            if isinstance(content_key, str):
                pipe.set(content_key, content_value, ex=STREAMING_TTL)
            if existing_index is None:
                pipe.rpush(blocks_key, serialized)
            else:
                pipe.lset(blocks_key, existing_index, serialized)
            pipe.hset(
                usage_key,
                mapping={
                    BLOCK_METADATA_BYTES_FIELD: next_metadata_usage,
                    BLOCK_CONTENT_BYTES_FIELD: next_content_usage,
                },
            )
            pipe.expire(blocks_key, STREAMING_TTL)
            pipe.expire(usage_key, STREAMING_TTL)
            await pipe.execute()

    async def _prepare_upsert_content(
        self,
        pipe: Any,
        subtask_id: int,
        block_id: str,
        content_key: Any,
        content_value: Any,
        content_usage: int,
    ) -> int:
        if not isinstance(content_key, str):
            return content_usage
        if content_key != self._get_block_content_key(subtask_id, block_id):
            raise StreamingStateCorruptionError(
                "Existing block content key is not owned by its block"
            )
        content_bytes = _require_max_bytes(
            "Block content",
            content_value,
            MAX_BLOCK_CONTENT_BYTES,
        )
        await pipe.watch(content_key)
        previous_bytes = int(await pipe.strlen(content_key) or 0)
        next_usage = content_usage - previous_bytes + content_bytes
        if next_usage < 0:
            raise StreamingStateCorruptionError(
                "Block content byte counter is smaller than its current value"
            )
        if next_usage > MAX_TOTAL_BLOCK_CONTENT_BYTES:
            raise StreamingStateLimitError(
                "Block content write exceeds the per-stream byte limit"
            )
        return next_usage

    async def add_text_content(self, subtask_id: int, content: str) -> bool:
        """Add text content to the current text block.

        Creates a new text block if there isn't one currently active.
        Uses Redis APPEND for O(1) content addition and keeps block metadata
        separate from high-frequency content updates.

        Args:
            subtask_id: Subtask ID
            content: Text content to add
        """
        if not content:
            return True

        block = create_text_block(content="")
        content_key = self._get_block_content_key(subtask_id, block["id"])
        block[BLOCK_CONTENT_KEY_FIELD] = content_key
        serialized = await run_payload_codec(
            session_codec.serialize_block,
            block,
            payload_hint=block,
        )
        try:
            for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
                if not await self._finalize_current_thinking_block(subtask_id):
                    return False
                try:
                    await self._append_stream_content_atomic(
                        subtask_id=subtask_id,
                        content=content,
                        active_key=self._get_current_text_block_key(subtask_id),
                        opposite_key=self._get_current_thinking_block_key(subtask_id),
                        new_block_id=block["id"],
                        new_block_metadata=serialized,
                        include_accumulated=True,
                    )
                    return True
                except _ActiveBlockConflict:
                    if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                        raise
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to add text content for subtask {subtask_id}: {e}"
            )
            return False

    async def add_thinking_content(self, subtask_id: int, content: str) -> bool:
        """Add reasoning content to the current thinking block."""
        if not content:
            return True

        ts = int(time.time() * 1000)
        block_id = f"thinking-{uuid.uuid4().hex[:12]}"
        content_key = self._get_block_content_key(subtask_id, block_id)
        block = {
            "id": block_id,
            "type": "thinking",
            "content": "",
            "status": BlockStatus.STREAMING.value,
            "timestamp": ts,
            BLOCK_CONTENT_KEY_FIELD: content_key,
        }
        serialized = await run_payload_codec(
            session_codec.serialize_block,
            block,
            payload_hint=block,
        )
        try:
            for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
                if not await self._finalize_current_text_block(subtask_id):
                    return False
                try:
                    await self._append_stream_content_atomic(
                        subtask_id=subtask_id,
                        content=content,
                        active_key=self._get_current_thinking_block_key(subtask_id),
                        opposite_key=self._get_current_text_block_key(subtask_id),
                        new_block_id=block_id,
                        new_block_metadata=serialized,
                        include_accumulated=False,
                    )
                    return True
                except _ActiveBlockConflict:
                    if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                        raise
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to add thinking content for subtask {subtask_id}: {e}"
            )
            return False

    async def _append_stream_content_atomic(
        self,
        *,
        subtask_id: int,
        content: str,
        active_key: str,
        opposite_key: str,
        new_block_id: str,
        new_block_metadata: str,
        include_accumulated: bool,
    ) -> None:
        chunk_bytes = _require_max_bytes(
            "Stream content chunk",
            content,
            MAX_BLOCK_CONTENT_BYTES,
        )
        redis_client = await self._cache._get_client()
        try:
            for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
                try:
                    await self._append_stream_content_once(
                        redis_client=redis_client,
                        subtask_id=subtask_id,
                        content=content,
                        chunk_bytes=chunk_bytes,
                        active_key=active_key,
                        opposite_key=opposite_key,
                        new_block_id=new_block_id,
                        new_block_metadata=new_block_metadata,
                        include_accumulated=include_accumulated,
                    )
                    return
                except WatchError:
                    if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                        break
        finally:
            await redis_client.aclose()
        raise StreamingStateConflictError(
            "Stream content changed during every atomic append attempt"
        )

    async def _append_stream_content_once(
        self,
        *,
        redis_client: Any,
        subtask_id: int,
        content: str,
        chunk_bytes: int,
        active_key: str,
        opposite_key: str,
        new_block_id: str,
        new_block_metadata: str,
        include_accumulated: bool,
    ) -> None:
        blocks_key = self._get_blocks_key(subtask_id)
        usage_key = self._get_blocks_usage_key(subtask_id)
        streaming_key = self._get_streaming_key(subtask_id)
        watched_keys = [blocks_key, usage_key, active_key, opposite_key]
        if include_accumulated:
            watched_keys.append(streaming_key)
        async with redis_client.pipeline(transaction=True) as pipe:
            await pipe.watch(*watched_keys)
            if await pipe.get(opposite_key):
                raise _ActiveBlockConflict(
                    "Opposite content type became active during transition"
                )
            blocks_raw, metadata_usage, content_usage = (
                await self._read_raw_block_state(
                    pipe,
                    subtask_id,
                    blocks_key,
                    usage_key,
                )
            )
            current_block_id = await pipe.get(active_key)
            block_id, next_metadata_usage = await self._resolve_append_block(
                pipe,
                current_block_id,
                new_block_id,
                new_block_metadata,
                blocks_raw,
                metadata_usage,
            )
            content_key = self._get_block_content_key(subtask_id, block_id)
            await pipe.watch(content_key)
            previous_block_bytes = int(await pipe.strlen(content_key) or 0)
            if previous_block_bytes + chunk_bytes > MAX_BLOCK_CONTENT_BYTES:
                raise StreamingStateLimitError(
                    "Appending content would exceed the per-block byte limit"
                )
            next_content_usage = content_usage + chunk_bytes
            if next_content_usage > MAX_TOTAL_BLOCK_CONTENT_BYTES:
                raise StreamingStateLimitError(
                    "Appending content would exceed the per-stream block byte limit"
                )
            if include_accumulated:
                accumulated_bytes = int(await pipe.strlen(streaming_key) or 0)
                if accumulated_bytes + chunk_bytes > MAX_STREAMING_CONTENT_BYTES:
                    raise StreamingStateLimitError(
                        "Appending content would exceed the recovery byte limit"
                    )
            self._queue_stream_append(
                pipe=pipe,
                content=content,
                content_key=content_key,
                active_key=active_key,
                new_block_id=block_id,
                create_block=current_block_id is None,
                new_block_metadata=new_block_metadata,
                blocks_key=blocks_key,
                usage_key=usage_key,
                metadata_usage=next_metadata_usage,
                content_usage=next_content_usage,
                streaming_key=streaming_key if include_accumulated else None,
            )
            await pipe.execute()

    async def _resolve_append_block(
        self,
        pipe: Any,
        current_block_id: Any,
        new_block_id: str,
        new_block_metadata: str,
        blocks_raw: List[Any],
        metadata_usage: int,
    ) -> tuple[str, int]:
        if current_block_id is not None:
            block_id = await run_payload_codec(
                session_codec.decode_block_id,
                current_block_id,
                payload_hint=current_block_id,
            )
            _require_max_bytes("Block id", block_id, MAX_STREAM_BLOCK_ID_BYTES)
            return block_id, metadata_usage
        if len(blocks_raw) >= MAX_STREAM_BLOCKS:
            raise StreamingStateLimitError(
                f"Stream already has {MAX_STREAM_BLOCKS} blocks"
            )
        metadata_bytes = _require_max_bytes(
            "Block metadata",
            new_block_metadata,
            MAX_BLOCK_METADATA_BYTES,
        )
        next_metadata_usage = metadata_usage + metadata_bytes
        if next_metadata_usage > MAX_TOTAL_BLOCK_METADATA_BYTES:
            raise StreamingStateLimitError(
                "Creating a block would exceed the metadata byte limit"
            )
        return new_block_id, next_metadata_usage

    def _queue_stream_append(
        self,
        *,
        pipe: Any,
        content: str,
        content_key: str,
        active_key: str,
        new_block_id: str,
        create_block: bool,
        new_block_metadata: str,
        blocks_key: str,
        usage_key: str,
        metadata_usage: int,
        content_usage: int,
        streaming_key: Optional[str],
    ) -> None:
        pipe.multi()
        if create_block:
            pipe.rpush(blocks_key, new_block_metadata)
            pipe.set(active_key, new_block_id, ex=STREAMING_TTL)
        if streaming_key is not None:
            pipe.append(streaming_key, content)
            pipe.expire(streaming_key, STREAMING_TTL)
        pipe.append(content_key, content)
        pipe.hset(
            usage_key,
            mapping={
                BLOCK_METADATA_BYTES_FIELD: metadata_usage,
                BLOCK_CONTENT_BYTES_FIELD: content_usage,
            },
        )
        for key in (content_key, blocks_key, active_key, usage_key):
            pipe.expire(key, STREAMING_TTL)

    async def _finalize_current_text_block(self, subtask_id: int) -> bool:
        """Finalize the current text block by setting status to done."""
        try:
            return await self._finalize_current_block_atomic(
                subtask_id,
                self._get_current_text_block_key(subtask_id),
            )
        except StreamingStateError:
            raise
        except Exception as e:
            logger.warning(
                f"[SessionManager] Failed to finalize text block for subtask {subtask_id}: {e}"
            )
            return False

    async def _finalize_current_thinking_block(self, subtask_id: int) -> bool:
        """Finalize the current thinking block by setting status to done."""
        try:
            return await self._finalize_current_block_atomic(
                subtask_id,
                self._get_current_thinking_block_key(subtask_id),
            )
        except StreamingStateError:
            raise
        except Exception as e:
            logger.warning(
                f"[SessionManager] Failed to finalize thinking block for subtask {subtask_id}: {e}"
            )
            return False

    async def _finalize_current_block_atomic(
        self,
        subtask_id: int,
        active_key: str,
    ) -> bool:
        redis_client = await self._cache._get_client()
        try:
            for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
                try:
                    await self._finalize_current_block_once(
                        redis_client,
                        subtask_id,
                        active_key,
                    )
                    return True
                except WatchError:
                    if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                        break
        finally:
            await redis_client.aclose()
        raise StreamingStateConflictError(
            "Block state changed during every atomic finalize attempt"
        )

    async def _finalize_current_block_once(
        self,
        redis_client: Any,
        subtask_id: int,
        active_key: str,
    ) -> None:
        blocks_key = self._get_blocks_key(subtask_id)
        usage_key = self._get_blocks_usage_key(subtask_id)
        async with redis_client.pipeline(transaction=True) as pipe:
            await pipe.watch(active_key, blocks_key, usage_key)
            current_block_id = await pipe.get(active_key)
            if not current_block_id:
                return
            block_id = await run_payload_codec(
                session_codec.decode_block_id,
                current_block_id,
                payload_hint=current_block_id,
            )
            blocks_raw, metadata_usage, content_usage = (
                await self._read_raw_block_state(
                    pipe,
                    subtask_id,
                    blocks_key,
                    usage_key,
                )
            )
            try:
                finalized = await run_payload_codec(
                    session_codec.finalize_block,
                    blocks_raw,
                    block_id,
                    BlockStatus.DONE.value,
                    payload_hint=blocks_raw,
                )
            except Exception as error:
                raise StreamingStateCorruptionError(
                    "Active block metadata is not valid JSON"
                ) from error
            pipe.multi()
            if finalized is None:
                pipe.delete(active_key)
                await pipe.execute()
                return
            block_index, serialized = finalized
            serialized_bytes = _require_max_bytes(
                "Finalized block metadata",
                serialized,
                MAX_BLOCK_METADATA_BYTES,
            )
            previous_bytes = _redis_value_size(blocks_raw[block_index])
            next_metadata_usage = metadata_usage - previous_bytes + serialized_bytes
            if next_metadata_usage > MAX_TOTAL_BLOCK_METADATA_BYTES:
                raise StreamingStateLimitError(
                    "Finalizing a block would exceed the metadata byte limit"
                )
            pipe.lset(blocks_key, block_index, serialized)
            pipe.delete(active_key)
            pipe.hset(
                usage_key,
                mapping={
                    BLOCK_METADATA_BYTES_FIELD: next_metadata_usage,
                    BLOCK_CONTENT_BYTES_FIELD: content_usage,
                },
            )
            pipe.expire(blocks_key, STREAMING_TTL)
            pipe.expire(usage_key, STREAMING_TTL)
            await pipe.execute()

    async def get_blocks(self, subtask_id: int) -> List[Dict[str, Any]]:
        """Get all blocks for a subtask without finalizing.

        This is used for page refresh recovery to get the current state
        of blocks during streaming without modifying them.

        Args:
            subtask_id: Subtask ID

        Returns:
            List of all blocks for the subtask
        """
        try:
            blocks_key = self._get_blocks_key(subtask_id)
            redis_client = await self._cache._get_client()
            try:
                blocks = await self._load_blocks_from_client(
                    redis_client,
                    subtask_id,
                    blocks_key,
                )
                logger.debug(
                    f"[SessionManager] get_blocks for subtask {subtask_id}: "
                    f"count={len(blocks)}"
                )
                return blocks
            finally:
                await redis_client.aclose()
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to get blocks for subtask {subtask_id}: {e}"
            )
            return []

    async def finalize_and_get_blocks(
        self,
        subtask_id: int,
        *,
        termination_reason: Optional[str] = None,
        terminal_status: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Finalize any pending text block and return all blocks.

        This should be called when the subtask completes (DONE event).

        Args:
            subtask_id: Subtask ID

        Returns:
            List of all blocks for the subtask
        """
        try:
            # Finalize current text block
            await self._finalize_current_text_block(subtask_id)
            await self._finalize_current_thinking_block(subtask_id)

            # Get all blocks
            blocks_key = self._get_blocks_key(subtask_id)
            redis_client = await self._cache._get_client()
            try:
                blocks = await self._load_blocks_from_client(
                    redis_client,
                    subtask_id,
                    blocks_key,
                )
                blocks = await run_payload_codec(
                    self._finalize_unresolved_preview_tool_blocks,
                    blocks,
                    termination_reason,
                    terminal_status,
                    payload_hint=blocks,
                )
                logger.debug(
                    f"[SessionManager] Finalized blocks for subtask {subtask_id}: "
                    f"count={len(blocks)}"
                )
                return blocks
            finally:
                await redis_client.aclose()
        except StreamingStateError:
            raise
        except Exception as e:
            logger.error(
                f"[SessionManager] Failed to get blocks for subtask {subtask_id}: {e}"
            )
            return []

    def _finalize_unresolved_preview_tool_blocks(
        self,
        blocks: List[Dict[str, Any]],
        termination_reason: Optional[str] = None,
        terminal_status: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Convert unresolved preview-only tool blocks into terminal error blocks.

        Preview tool blocks are created while tool arguments stream, before real tool
        execution begins. If the turn ends without a matching TOOL_RESULT, those
        blocks would otherwise stay stuck in a pending state in the final result.

        A successful Claude Code terminal result is authoritative. In that case,
        unresolved preview-only blocks are treated as display-state loss and
        closed as done so UI recovery cannot turn a completed task into a failure.
        Explicit unexecuted-tool termination still stays an error.

        Only preview-only blocks without tool_output are rewritten. Legitimate
        pending blocks that already carry a semantic output payload (for example
        deferred interactive forms waiting for user input) are preserved.
        """
        inferred_tool_limit = (
            termination_reason == "completed_with_unexecuted_tool_calls"
        )
        successful_terminal = str(terminal_status or "").upper() == "COMPLETED"
        has_explicit_tool_error = any(
            block.get("type") == "tool"
            and block.get("status") == BlockStatus.ERROR.value
            and block.get("tool_output")
            for block in blocks
        )
        unresolved_message = (
            UNRESOLVED_PREVIEW_TOOL_BLOCK_MESSAGE
            if inferred_tool_limit and not has_explicit_tool_error
            else UNRESOLVED_PREVIEW_TOOL_BLOCK_GENERIC_MESSAGE
        )
        finalized_blocks: List[Dict[str, Any]] = []
        for block in blocks:
            if (
                block.get("type") == "tool"
                and block.get("status") in UNRESOLVED_PREVIEW_TOOL_BLOCK_STATUSES
                and not block.get("tool_output")
            ):
                if successful_terminal and not inferred_tool_limit:
                    finalized_blocks.append(
                        {
                            **block,
                            "status": BlockStatus.DONE.value,
                        }
                    )
                    continue
                finalized_blocks.append(
                    {
                        **block,
                        "status": BlockStatus.ERROR.value,
                        "tool_output": unresolved_message,
                    }
                )
                continue
            finalized_blocks.append(block)
        return finalized_blocks

    async def get_accumulated_content(self, subtask_id: int) -> str:
        """Get accumulated content for a subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            Accumulated content string
        """
        # Use the existing streaming content cache
        content = await self.get_streaming_content(subtask_id)
        return content or ""

    async def cleanup_streaming_state(
        self, subtask_id: int, task_id: Optional[int] = None
    ) -> None:
        """Clean up all streaming state for a completed subtask.

        Args:
            subtask_id: Subtask ID
            task_id: Optional Task ID for clearing task-level streaming status
        """
        try:
            streaming_key = self._get_streaming_key(subtask_id)
            blocks_key = self._get_blocks_key(subtask_id)
            usage_key = self._get_blocks_usage_key(subtask_id)
            text_block_key = self._get_current_text_block_key(subtask_id)
            thinking_block_key = self._get_current_thinking_block_key(subtask_id)
            context_metrics_key = self._get_context_metrics_key(subtask_id)

            redis_client = await self._cache._get_client()
            try:
                await self._cleanup_streaming_state_atomic(
                    redis_client=redis_client,
                    subtask_id=subtask_id,
                    keys=(
                        streaming_key,
                        blocks_key,
                        usage_key,
                        text_block_key,
                        thinking_block_key,
                        context_metrics_key,
                    ),
                )
                logger.debug(
                    f"[SessionManager] Cleaned up streaming state for subtask {subtask_id}"
                )
            finally:
                await redis_client.aclose()

            # Also clear task-level streaming status if task_id is provided
            if task_id:
                await self.clear_task_streaming_status(task_id)
        except StreamingStateError:
            raise
        except Exception as e:
            logger.warning(
                f"[SessionManager] Failed to cleanup streaming state for subtask {subtask_id}: {e}"
            )

    async def _cleanup_streaming_state_atomic(
        self,
        *,
        redis_client: Any,
        subtask_id: int,
        keys: tuple[str, ...],
    ) -> None:
        blocks_key = self._get_blocks_key(subtask_id)
        usage_key = self._get_blocks_usage_key(subtask_id)
        for attempt in range(STREAM_STATE_TRANSACTION_ATTEMPTS):
            try:
                async with redis_client.pipeline(transaction=True) as pipe:
                    await pipe.watch(blocks_key, usage_key)
                    blocks_raw, _, _ = await self._read_raw_block_state(
                        pipe,
                        subtask_id,
                        blocks_key,
                        usage_key,
                    )
                    try:
                        blocks, content_refs = await run_payload_codec(
                            session_codec.decode_block_metadata,
                            blocks_raw,
                            BLOCK_CONTENT_KEY_FIELD,
                            payload_hint=blocks_raw,
                        )
                    except Exception as error:
                        raise StreamingStateCorruptionError(
                            "Cleanup refused invalid block metadata"
                        ) from error
                    content_keys = self._validate_block_content_refs(
                        subtask_id,
                        blocks,
                        content_refs,
                    )
                    if content_keys:
                        await pipe.watch(*content_keys)
                    pipe.multi()
                    pipe.delete(*keys, *content_keys)
                    await pipe.execute()
                    return
            except WatchError:
                if attempt + 1 == STREAM_STATE_TRANSACTION_ATTEMPTS:
                    break
        raise StreamingStateConflictError(
            "Streaming state changed during every atomic cleanup attempt"
        )


# Global session manager instance
session_manager = SessionManager()
