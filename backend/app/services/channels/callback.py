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
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Dict, Generic, Optional, TypeVar

from app.core.cache import cache_manager

if TYPE_CHECKING:
    from app.services.chat.trigger.emitter import ChatEventEmitter

logger = logging.getLogger(__name__)

# Redis key prefix for channel task callback info
CHANNEL_TASK_CALLBACK_PREFIX = "channel:task_callback:"
# TTL for task callback info (1 hour - should be enough for most tasks)
CHANNEL_TASK_CALLBACK_TTL = 60 * 60
# Redis key prefix for task result deduplication (prevents duplicate sends in multi-instance)
CHANNEL_TASK_RESULT_DEDUP_PREFIX = "channel:task_result_dedup:"
# TTL for task result deduplication (5 minutes)
CHANNEL_TASK_RESULT_DEDUP_TTL = 300
# Redis key prefix for task streaming ownership (prevents duplicate emitters in multi-instance)
CHANNEL_TASK_STREAM_OWNER_PREFIX = "channel:task_stream_owner:"
# TTL for task streaming ownership (10 minutes - refreshed while streaming)
CHANNEL_TASK_STREAM_OWNER_TTL = 600


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
        # Cache of active streaming emitters: task_id -> ChatEventEmitter
        self._active_emitters: Dict[int, "ChatEventEmitter"] = {}
        # Locks for each task to prevent concurrent emitter creation
        self._emitter_locks: Dict[int, asyncio.Lock] = {}
        # Global lock for accessing _emitter_locks dict
        self._locks_lock = asyncio.Lock()
        # Track last emitted content offset for each task to calculate delta
        self._last_emitted_offsets: Dict[int, int] = {}

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
    ) -> Optional["ChatEventEmitter"]:
        """Create a streaming emitter for the channel.

        This method should be implemented by each channel to create
        the appropriate emitter type.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            callback_info: Channel-specific callback information

        Returns:
            ChatEventEmitter instance or None if creation failed
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
    ) -> Optional["ChatEventEmitter"]:
        """Get existing emitter or create a new one for streaming.

        Uses per-task locking to prevent concurrent creation of multiple emitters
        for the same task. Also uses distributed lock to ensure only one instance
        handles streaming for a given task in multi-instance deployments.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            ChatEventEmitter or None if callback info not found or another instance owns the task
        """
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

            # Try to acquire distributed ownership for this task's streaming
            # Only one instance can own a task at a time
            owner_key = f"{CHANNEL_TASK_STREAM_OWNER_PREFIX}{task_id}"
            is_owner = await cache_manager.setnx(
                owner_key, "1", expire=CHANNEL_TASK_STREAM_OWNER_TTL
            )
            if not is_owner:
                logger.debug(
                    f"[{self._channel_type.value}Callback] Another instance owns streaming for task {task_id}"
                )
                return None

            logger.info(
                f"[{self._channel_type.value}Callback] Creating new emitter for task {task_id}"
            )

            # Get callback info
            callback_info = await self.get_callback_info(task_id)
            if not callback_info:
                # Release ownership since we can't process
                await cache_manager.delete(owner_key)
                return None

            try:
                # Create channel-specific emitter
                emitter = await self._create_emitter(task_id, subtask_id, callback_info)
                if not emitter:
                    # Release ownership since we can't process
                    await cache_manager.delete(owner_key)
                    return None

                # Start the emitter
                await emitter.emit_chat_start(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    shell_type="ClaudeCode",
                )

                # Cache the emitter
                self._active_emitters[task_id] = emitter
                logger.info(
                    f"[{self._channel_type.value}Callback] Created streaming emitter for task {task_id}"
                )

                return emitter

            except Exception as e:
                logger.exception(
                    f"[{self._channel_type.value}Callback] Failed to create emitter for task {task_id}: {e}"
                )
                # Release ownership on failure
                await cache_manager.delete(owner_key)
                return None

    def _remove_emitter(self, task_id: int) -> None:
        """Remove emitter, lock, and offset tracking from cache (sync version)."""
        if task_id in self._active_emitters:
            del self._active_emitters[task_id]
        self._remove_lock_for_task(task_id)
        # Clean up offset tracking
        self._last_emitted_offsets.pop(task_id, None)

    async def _remove_emitter_async(self, task_id: int) -> None:
        """Remove emitter, lock, offset tracking, and distributed ownership from cache."""
        self._remove_emitter(task_id)
        # Release distributed ownership
        owner_key = f"{CHANNEL_TASK_STREAM_OWNER_PREFIX}{task_id}"
        await cache_manager.delete(owner_key)

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
            await emitter.emit_chat_chunk(
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

        Uses distributed lock to prevent duplicate sends in multi-instance deployments.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Result content
            status: Task status (COMPLETED or FAILED)
            error_message: Error message if failed

        Returns:
            True if sent successfully, False otherwise
        """
        # Deduplication check - prevent multiple instances from sending the same result
        dedup_key = f"{CHANNEL_TASK_RESULT_DEDUP_PREFIX}{task_id}"
        is_first = await cache_manager.setnx(
            dedup_key, "1", expire=CHANNEL_TASK_RESULT_DEDUP_TTL
        )
        if not is_first:
            logger.info(
                f"[{self._channel_type.value}Callback] Task result already sent by another instance: task={task_id}"
            )
            return False

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
                    await emitter.emit_chat_error(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        error=error_message or "Task failed",
                    )
                else:
                    await emitter.emit_chat_done(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        offset=len(content),
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
                if status == "FAILED":
                    message = f"任务执行失败\n\n任务 ID: {task_id}\n错误: {error_message or '未知错误'}"
                    await emitter.emit_chat_chunk(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=message,
                        offset=0,
                    )
                    await emitter.emit_chat_error(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        error=error_message or "Task failed",
                    )
                else:
                    # Truncate content if too long
                    max_length = 4000
                    if len(content) > max_length:
                        content = content[:max_length] + "\n\n... (内容已截断)"

                    await emitter.emit_chat_chunk(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=content,
                        offset=0,
                    )
                    await emitter.emit_chat_done(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        offset=len(content),
                    )

                logger.info(
                    f"[{self._channel_type.value}Callback] Sent result for task {task_id}"
                )

            # Clean up (async version to release distributed ownership)
            await self._remove_emitter_async(task_id)
            await self.delete_callback_info(task_id)
            return True

        except Exception as e:
            logger.exception(
                f"[{self._channel_type.value}Callback] Failed to send result for task {task_id}: {e}"
            )
            # Clean up on error (async version to release distributed ownership)
            await self._remove_emitter_async(task_id)
            # Delete dedup key to allow retry by other instances
            await cache_manager.delete(dedup_key)
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


def get_callback_registry() -> ChannelCallbackRegistry:
    """Get the ChannelCallbackRegistry singleton instance."""
    return ChannelCallbackRegistry.get_instance()
