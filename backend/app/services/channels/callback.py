# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generic Channel Callback Service.

This module provides a generic callback service for IM channel integrations
(DingTalk, Feishu, Telegram, etc.) to send streaming updates and task completion
results back to the channel.

The design follows the Strategy pattern, allowing each channel to implement
its own callback logic while sharing common infrastructure.
"""

import asyncio
import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Dict, Generic, Iterator, Optional, Tuple, TypeVar

from app.core.cache import cache_manager

if TYPE_CHECKING:
    from app.services.execution.emitters import ResultEmitter
    from shared.models import ExecutionEvent

logger = logging.getLogger(__name__)

# Redis key prefix for channel task callback info
CHANNEL_TASK_CALLBACK_PREFIX = "channel:task_callback:"
# TTL for task callback info (1 hour - should be enough for most tasks)
CHANNEL_TASK_CALLBACK_TTL = 60 * 60


class ChannelType(str, Enum):
    """Supported IM channel types."""

    DINGTALK = "dingtalk"
    FEISHU = "feishu"
    TELEGRAM = "telegram"
    SLACK = "slack"
    WECHAT = "wechat"


@dataclass
class BaseCallbackInfo:
    """Base class for channel callback information.

    Each channel implementation should extend this class with
    channel-specific fields.
    """

    channel_type: ChannelType
    channel_id: int  # Channel ID for getting client
    conversation_id: str  # Conversation/chat ID

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        return {
            "channel_type": self.channel_type.value,
            "channel_id": self.channel_id,
            "conversation_id": self.conversation_id,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "BaseCallbackInfo":
        """Create from dictionary.

        Subclasses should override this method to handle their specific fields.
        """
        return cls(
            channel_type=ChannelType(data.get("channel_type", "dingtalk")),
            channel_id=data.get("channel_id", 0),
            conversation_id=data.get("conversation_id", ""),
        )


# Type variable for callback info
T = TypeVar("T", bound=BaseCallbackInfo)


class BaseChannelCallbackService(ABC, Generic[T]):
    """Abstract base class for channel callback services.

    Each channel implementation should extend this class and implement
    the abstract methods for channel-specific behavior.

    The service manages:
    - Storing/retrieving callback info in Redis
    - Creating and managing streaming emitters
    - Sending progress updates and task results
    """

    def __init__(self, channel_type: ChannelType):
        """Initialize the callback service.

        Args:
            channel_type: The type of channel this service handles
        """
        self._channel_type = channel_type
        # Cache of active streaming emitters: task_id -> ResultEmitter
        self._active_emitters: Dict[int, "ResultEmitter"] = {}
        # Locks for each task to prevent concurrent emitter creation
        self._emitter_locks: Dict[int, asyncio.Lock] = {}
        # Global lock for accessing _emitter_locks dict
        self._locks_lock = asyncio.Lock()
        # Track last emitted content offset for each task to calculate delta
        self._last_emitted_offsets: Dict[int, int] = {}
        # Track emitter creation time for TTL cleanup
        self._emitter_created_at: Dict[int, float] = {}
        # Emitter TTL in seconds (30 minutes)
        self._emitter_ttl = 30 * 60

    @property
    def channel_type(self) -> ChannelType:
        """Get the channel type."""
        return self._channel_type

    @property
    def redis_key_prefix(self) -> str:
        """Get the Redis key prefix for this channel type."""
        return f"{CHANNEL_TASK_CALLBACK_PREFIX}{self._channel_type.value}:"

    async def _get_lock_for_task(self, task_id: int) -> asyncio.Lock:
        """Get or create a lock for a specific task."""
        async with self._locks_lock:
            if task_id not in self._emitter_locks:
                self._emitter_locks[task_id] = asyncio.Lock()
            return self._emitter_locks[task_id]

    def _remove_lock_for_task(self, task_id: int) -> None:
        """Remove lock for a task (called during cleanup)."""
        self._emitter_locks.pop(task_id, None)

    @abstractmethod
    async def _create_emitter(
        self, task_id: int, subtask_id: int, callback_info: T
    ) -> Optional["ResultEmitter"]:
        """Create a streaming emitter for the channel.

        This method should be implemented by each channel to create
        the appropriate emitter type.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            callback_info: Channel-specific callback information

        Returns:
            ResultEmitter instance or None if creation failed
        """
        pass

    @abstractmethod
    def _parse_callback_info(self, data: Dict[str, Any]) -> T:
        """Parse callback info from dictionary.

        This method should be implemented by each channel to parse
        channel-specific callback information.

        Args:
            data: Dictionary containing callback info

        Returns:
            Channel-specific CallbackInfo instance
        """
        pass

    @abstractmethod
    def _extract_thinking_display(self, thinking: Any) -> str:
        """Extract thinking content for display.

        This method should be implemented by each channel to format
        thinking content appropriately for the channel's UI.

        Args:
            thinking: Thinking content from AI response

        Returns:
            Formatted thinking text for display
        """
        pass

    async def _get_or_create_emitter(
        self, task_id: int, subtask_id: int
    ) -> Optional["ResultEmitter"]:
        """Get existing emitter or create a new one for streaming.

        Uses per-task locking to prevent concurrent creation of multiple emitters
        for the same task. Automatically cleans up expired emitters before lookup.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            ResultEmitter or None if callback info not found
        """
        # Clean up expired emitters to prevent memory leaks
        await self._cleanup_expired_emitters()

        # Quick check without lock - if emitter exists, return it
        if task_id in self._active_emitters:
            logger.debug(
                f"[{self._channel_type.value}Callback] Reusing existing emitter for task {task_id}"
            )
            return self._active_emitters[task_id]

        # Get lock for this task to prevent concurrent creation
        task_lock = await self._get_lock_for_task(task_id)

        async with task_lock:
            # Double-check after acquiring lock
            if task_id in self._active_emitters:
                logger.debug(
                    f"[{self._channel_type.value}Callback] Reusing existing emitter for task {task_id} (after lock)"
                )
                return self._active_emitters[task_id]

            logger.info(
                f"[{self._channel_type.value}Callback] Creating new emitter for task {task_id}"
            )

            # Get callback info
            callback_info = await self.get_callback_info(task_id)
            if not callback_info:
                return None

            try:
                # Create channel-specific emitter
                emitter = await self._create_emitter(task_id, subtask_id, callback_info)
                if not emitter:
                    return None

                # Start the emitter
                await emitter.emit_start(
                    task_id=task_id,
                    subtask_id=subtask_id,
                )

                # Cache the emitter and track creation time
                self._active_emitters[task_id] = emitter
                self._emitter_created_at[task_id] = time.time()
                logger.info(
                    f"[{self._channel_type.value}Callback] Created streaming emitter for task {task_id}"
                )

                return emitter

            except Exception as e:
                logger.exception(
                    f"[{self._channel_type.value}Callback] Failed to create emitter for task {task_id}: {e}"
                )
                return None

    async def _remove_emitter(self, task_id: int) -> None:
        """Remove emitter, lock, and offset tracking from cache.

        Closes the emitter if it has a close() method to release resources.
        """
        emitter = self._active_emitters.pop(task_id, None)
        if emitter and hasattr(emitter, "close"):
            try:
                await emitter.close()
            except Exception:
                logger.exception(
                    f"[{self._channel_type.value}Callback] Failed to close emitter "
                    f"for task {task_id}"
                )
        # Safety cleanup: delete shared streaming content key
        streaming_content_key = f"channel:streaming_content:{task_id}"
        try:
            await cache_manager.delete(streaming_content_key)
        except Exception:
            pass
        self._remove_lock_for_task(task_id)
        # Clean up offset tracking
        self._last_emitted_offsets.pop(task_id, None)
        self._emitter_created_at.pop(task_id, None)

    async def _cleanup_expired_emitters(self) -> None:
        """Remove emitters that have exceeded the TTL to prevent memory leaks."""
        now = time.time()
        expired = [
            task_id
            for task_id, created_at in self._emitter_created_at.items()
            if now - created_at > self._emitter_ttl
        ]
        for task_id in expired:
            logger.warning(
                f"[{self._channel_type.value}Callback] Emitter for task {task_id} "
                f"expired after {self._emitter_ttl}s, cleaning up"
            )
            await self._remove_emitter(task_id)

    async def register_emitter(self, task_id: int, emitter: "ResultEmitter") -> None:
        """Register an externally created emitter for a task.

        This allows channel handlers to reuse an existing streaming emitter
        (e.g., an AI Card already started for an acknowledgment message)
        instead of creating a new one when callback events arrive.

        If an emitter already exists for the task, it is closed before replacing.

        Args:
            task_id: Task ID
            emitter: ResultEmitter instance to register
        """
        if task_id in self._active_emitters:
            old_emitter = self._active_emitters[task_id]
            if old_emitter is not emitter and hasattr(old_emitter, "close"):
                try:
                    await old_emitter.close()
                except Exception:
                    logger.exception(
                        f"[{self._channel_type.value}Callback] Failed to close old emitter "
                        f"for task {task_id}"
                    )
        self._active_emitters[task_id] = emitter
        self._emitter_created_at[task_id] = time.time()
        logger.info(
            f"[{self._channel_type.value}Callback] Registered external emitter for task {task_id}"
        )

    async def emit_event(
        self, task_id: int, subtask_id: int, event: "ExecutionEvent"
    ) -> bool:
        """Emit a single execution event to the channel.

        Forwards non-terminal events (START, CHUNK, THINKING, etc.) to the
        channel's streaming emitter. Terminal events (DONE, ERROR, CANCELLED)
        are skipped and should be handled by send_task_result() via
        TaskCompletedEvent to ensure proper cleanup.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            event: Execution event to emit

        Returns:
            True if the event was forwarded, False otherwise
        """
        from shared.models import EventType

        # Skip terminal events - let TaskCompletedEvent handle them for cleanup
        if event.type in (
            EventType.DONE.value,
            EventType.ERROR.value,
            EventType.CANCEL.value,
            EventType.CANCELLED.value,
        ):
            return False

        # Fast path: skip if no callback info exists for this task
        if not await self.has_callback_info(task_id):
            return False

        try:
            emitter = await self._get_or_create_emitter(task_id, subtask_id)
            if not emitter:
                return False

            await emitter.emit(event)
            return True

        except Exception:
            logger.exception(
                f"[{self._channel_type.value}Callback] Failed to emit event "
                f"{event.type} for task {task_id}"
            )
            return False

    async def send_progress(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        thinking: Optional[Any] = None,
    ) -> bool:
        """Send streaming progress update to the channel.

        This method receives FULL content but calculates and sends only the DELTA
        (incremental content) to the emitter. It tracks the last emitted offset
        for each task to avoid sending duplicate content.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Full content (result.value) - NOT delta
            offset: Current offset in full content (used for tracking)
            thinking: Thinking content (optional)

        Returns:
            True if sent successfully, False otherwise
        """
        try:
            emitter = await self._get_or_create_emitter(task_id, subtask_id)
            if not emitter:
                return False

            # Get last emitted offset for this task
            last_offset = self._last_emitted_offsets.get(task_id, 0)

            # Build display content - include thinking if available
            # For thinking, we always show the latest status (not accumulated)
            thinking_text = ""
            if thinking:
                thinking_text = self._extract_thinking_display(thinking)

            # Calculate delta content (only new content since last emit)
            delta_content = ""
            if content and len(content) > last_offset:
                delta_content = content[last_offset:]

            # If no new content and no thinking update, skip
            if not delta_content and not thinking_text:
                return False

            # Build the chunk to send
            # For the first chunk, include thinking prefix if present
            chunk_to_send = ""
            if last_offset == 0 and thinking_text:
                # First chunk: include thinking status
                chunk_to_send = f"{thinking_text}\n\n"
                if delta_content:
                    chunk_to_send += "**回复:**\n"
                    chunk_to_send += delta_content
            elif delta_content:
                # Subsequent chunks: only send delta content
                chunk_to_send = delta_content
            elif thinking_text:
                # Only thinking update (tool use), send thinking status
                chunk_to_send = f"{thinking_text}\n\n"

            if not chunk_to_send:
                return False

            # Update last emitted offset
            if content:
                self._last_emitted_offsets[task_id] = len(content)

            # Send chunk update with delta content
            await emitter.emit_chunk(
                task_id=task_id,
                subtask_id=subtask_id,
                content=chunk_to_send,
                offset=offset,
            )

            logger.debug(
                f"[{self._channel_type.value}Callback] Sent progress delta: "
                f"task={task_id}, last_offset={last_offset}, new_offset={len(content) if content else 0}, "
                f"delta_len={len(delta_content)}, has_thinking={bool(thinking_text)}"
            )

            return True

        except Exception as e:
            logger.warning(
                f"[{self._channel_type.value}Callback] Failed to send progress for task {task_id}: {e}"
            )
            return False

    async def save_callback_info(
        self,
        task_id: int,
        callback_info: T,
    ) -> None:
        """Save callback info for a task.

        Args:
            task_id: Task ID
            callback_info: Channel-specific callback information
        """
        key = f"{self.redis_key_prefix}{task_id}"
        data = json.dumps(callback_info.to_dict())
        await cache_manager.set(key, data, expire=CHANNEL_TASK_CALLBACK_TTL)
        logger.info(
            f"[{self._channel_type.value}Callback] Saved callback info for task {task_id}"
        )

    async def get_callback_info(self, task_id: int) -> Optional[T]:
        """Get callback info for a task.

        Args:
            task_id: Task ID

        Returns:
            CallbackInfo or None if not found
        """
        key = f"{self.redis_key_prefix}{task_id}"
        data = await cache_manager.get(key)
        if data:
            try:
                return self._parse_callback_info(json.loads(data))
            except (json.JSONDecodeError, TypeError) as e:
                logger.error(
                    f"[{self._channel_type.value}Callback] Failed to parse callback info for task {task_id}: {e}"
                )
        return None

    async def has_callback_info(self, task_id: int) -> bool:
        """Check if callback info exists for a task without full deserialization.

        Args:
            task_id: Task ID

        Returns:
            True if callback info exists, False otherwise
        """
        key = f"{self.redis_key_prefix}{task_id}"
        data = await cache_manager.get(key)
        return data is not None

    async def delete_callback_info(self, task_id: int) -> None:
        """Delete callback info for a task.

        Args:
            task_id: Task ID
        """
        key = f"{self.redis_key_prefix}{task_id}"
        await cache_manager.delete(key)
        logger.debug(
            f"[{self._channel_type.value}Callback] Deleted callback info for task {task_id}"
        )

    async def send_task_result(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        status: str = "COMPLETED",
        error_message: Optional[str] = None,
    ) -> bool:
        """Send task result back to the channel.

        If streaming was active (emitter exists), finishes the stream.
        Otherwise creates a new emitter and sends the complete result.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Result content
            status: Task status (COMPLETED or FAILED)
            error_message: Error message if failed

        Returns:
            True if sent successfully, False otherwise
        """
        callback_info = await self.get_callback_info(task_id)
        if not callback_info:
            logger.debug(
                f"[{self._channel_type.value}Callback] No callback info for task {task_id}, skipping"
            )
            return False

        try:
            # Check if we have an active streaming emitter
            emitter = self._active_emitters.get(task_id)

            if emitter:
                # Streaming was active, just finish it
                if status == "FAILED":
                    await emitter.emit_error(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        error=error_message or "Task failed",
                    )
                else:
                    # Pass result content to emitter so it can use the actual
                    # AI response instead of stale accumulated content.
                    # This is essential for device mode where executor events
                    # arrive via device WebSocket rather than /callback.
                    result = {"value": content} if content else None
                    await emitter.emit_done(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        result=result,
                    )
                logger.info(
                    f"[{self._channel_type.value}Callback] Finished streaming for task {task_id}"
                )
            else:
                # No active streaming, create new emitter and send complete result
                emitter = await self._get_or_create_emitter(task_id, subtask_id)
                if not emitter:
                    logger.warning(
                        f"[{self._channel_type.value}Callback] Failed to create emitter for task {task_id}"
                    )
                    return False

                # Build message content
                # Build message content
                if status == "FAILED":
                    message = f"❌ 任务执行失败\n\n任务 ID: {task_id}\n错误: {error_message or '未知错误'}"
                    await emitter.emit_chunk(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=message,
                        offset=0,
                    )
                    await emitter.emit_error(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        error=error_message or "Task failed",
                    )
                else:
                    # Truncate content if too long
                    max_length = 4000
                    if len(content) > max_length:
                        content = content[:max_length] + "\n\n... (内容已截断)"

                    await emitter.emit_chunk(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=content,
                        offset=0,
                    )
                    await emitter.emit_done(
                        task_id=task_id,
                        subtask_id=subtask_id,
                    )
                logger.info(
                    f"[{self._channel_type.value}Callback] Sent result for task {task_id}"
                )

            # Clean up
            await self._remove_emitter(task_id)
            await self.delete_callback_info(task_id)
            return True

        except Exception as e:
            logger.exception(
                f"[{self._channel_type.value}Callback] Failed to send result for task {task_id}: {e}"
            )
            # Clean up on error
            await self._remove_emitter(task_id)
            return False


class ChannelCallbackRegistry:
    """Registry for channel callback services.

    Provides a centralized way to access callback services for different
    channel types.
    """

    _instance: Optional["ChannelCallbackRegistry"] = None
    _services: Dict[ChannelType, BaseChannelCallbackService]

    def __new__(cls) -> "ChannelCallbackRegistry":
        """Ensure singleton pattern."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._services = {}
        return cls._instance

    @classmethod
    def get_instance(cls) -> "ChannelCallbackRegistry":
        """Get the singleton instance."""
        if cls._instance is None:
            cls._instance = ChannelCallbackRegistry()
        return cls._instance

    def register(
        self, channel_type: ChannelType, service: BaseChannelCallbackService
    ) -> None:
        """Register a callback service for a channel type.

        Args:
            channel_type: The channel type
            service: The callback service instance
        """
        self._services[channel_type] = service
        logger.info(
            f"[CallbackRegistry] Registered callback service for {channel_type.value}"
        )

    def get_service(
        self, channel_type: ChannelType
    ) -> Optional[BaseChannelCallbackService]:
        """Get the callback service for a channel type.

        Args:
            channel_type: The channel type

        Returns:
            The callback service or None if not registered
        """
        return self._services.get(channel_type)

    def iter_services(
        self,
    ) -> Iterator[Tuple[ChannelType, BaseChannelCallbackService]]:
        """Iterate over all registered callback services.

        Yields:
            Tuples of (channel_type, service)
        """
        yield from self._services.items()

    def get_service_by_name(
        self, channel_type_name: str
    ) -> Optional[BaseChannelCallbackService]:
        """Get the callback service by channel type name.

        Args:
            channel_type_name: The channel type name (e.g., "dingtalk")

        Returns:
            The callback service or None if not registered
        """
        try:
            channel_type = ChannelType(channel_type_name)
            return self.get_service(channel_type)
        except ValueError:
            logger.warning(
                f"[CallbackRegistry] Unknown channel type: {channel_type_name}"
            )
            return None

    async def handle_task_completed(
        self,
        task_id: int,
        subtask_id: int,
        status: str,
        result: Any,
        error: Optional[str] = None,
    ) -> bool:
        """Handle task completion by sending results to all channel callbacks.

        This method is called when a task completes (typically from TaskCompletedEvent).
        It checks all registered channel callback services for callback info
        and sends the result to any channels that have saved callback info for this task.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            status: Task status ("COMPLETED", "FAILED", "CANCELLED")
            result: Result dictionary containing output value
            error: Error message if failed

        Returns:
            True if at least one callback was sent successfully
        """
        sent_any = False

        # Extract content from result
        content = ""
        if result and isinstance(result, dict):
            content = result.get("value", "") or result.get("output", "") or ""

        for channel_type, service in self._services.items():
            try:
                # Check if this service has callback info for the task
                callback_info = await service.get_callback_info(task_id)
                if callback_info:
                    logger.info(
                        f"[CallbackRegistry] Found callback info for task {task_id} "
                        f"in channel {channel_type.value}, sending result"
                    )
                    success = await service.send_task_result(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=content,
                        status=status,
                        error_message=error,
                    )
                    if success:
                        sent_any = True
                        logger.info(
                            f"[CallbackRegistry] Successfully sent result to "
                            f"{channel_type.value} for task {task_id}"
                        )
            except Exception as e:
                logger.error(
                    f"[CallbackRegistry] Error sending callback to {channel_type.value} "
                    f"for task {task_id}: {e}",
                    exc_info=True,
                )

        return sent_any


def get_callback_registry() -> ChannelCallbackRegistry:
    """Get the ChannelCallbackRegistry singleton instance."""
    return ChannelCallbackRegistry.get_instance()


async def handle_channel_task_completed(event: Any) -> None:
    """Handle TaskCompletedEvent for IM channel callbacks.

    This function is subscribed to the event bus and forwards task completion
    events to all registered channel callback services.

    Args:
        event: TaskCompletedEvent from app.core.events
    """
    registry = get_callback_registry()
    await registry.handle_task_completed(
        task_id=event.task_id,
        subtask_id=event.subtask_id,
        status=event.status,
        result=event.result,
        error=event.error,
    )
