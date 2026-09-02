# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram callback service for device/cloud task execution.

This module provides functionality to send streaming updates and task completion
results back to Telegram when tasks are executed on devices or cloud executors.

Supports:
- Streaming progress updates via message editing
- Task completion notifications
"""

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Optional

from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
    get_callback_registry,
)

if TYPE_CHECKING:
    from app.services.execution.emitters import ResultEmitter

logger = logging.getLogger(__name__)


@dataclass
class TelegramCallbackInfo(BaseCallbackInfo):
    """Information needed to send callback to Telegram."""

    chat_id: int = 0  # Telegram chat ID
    message_id: Optional[int] = None  # Message ID for editing (streaming mode)

    def __init__(
        self,
        channel_id: int,
        conversation_id: str,
        chat_id: int = 0,
        message_id: Optional[int] = None,
    ):
        """Initialize TelegramCallbackInfo.

        Args:
            channel_id: Telegram channel ID (Kind.id)
            conversation_id: Telegram chat_id as string
            chat_id: Telegram chat ID as integer
            message_id: Message ID for editing during streaming
        """
        super().__init__(
            channel_type=ChannelType.TELEGRAM,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        self.chat_id = chat_id
        self.message_id = message_id

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        data = super().to_dict()
        data.update(
            {
                "chat_id": self.chat_id,
                "message_id": self.message_id,
            }
        )
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TelegramCallbackInfo":
        """Create from dictionary."""
        return cls(
            channel_id=data.get("channel_id", 0),
            conversation_id=data.get("conversation_id", ""),
            chat_id=data.get("chat_id", 0),
            message_id=data.get("message_id"),
        )


class TelegramCallbackService(BaseChannelCallbackService[TelegramCallbackInfo]):
    """Service for managing Telegram task callbacks and streaming updates."""

    def __init__(self):
        """Initialize the callback service."""
        super().__init__(ChannelType.TELEGRAM)

    def _parse_callback_info(self, data: Dict[str, Any]) -> TelegramCallbackInfo:
        """Parse callback info from dictionary."""
        return TelegramCallbackInfo.from_dict(data)

    async def _create_emitter(
        self, task_id: int, subtask_id: int, callback_info: TelegramCallbackInfo
    ) -> Optional["ResultEmitter"]:
        """Create a streaming emitter for Telegram.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            callback_info: Telegram callback information

        Returns:
            StreamingResponseEmitter or None if creation failed
        """
        try:
            # Get Telegram channel to access the bot
            from app.services.channels.manager import get_channel_manager

            channel_manager = get_channel_manager()
            channel = channel_manager.get_channel(callback_info.channel_id)
            if not channel:
                logger.warning(
                    f"[TelegramCallback] Channel {callback_info.channel_id} not found"
                )
                return None

            # Get the Telegram bot from the channel
            if not hasattr(channel, "_bot") or not channel._bot:
                logger.warning(
                    f"[TelegramCallback] Channel {callback_info.channel_id} has no bot"
                )
                return None

            # Create new emitter
            from app.services.channels.telegram.emitter import StreamingResponseEmitter

            emitter = StreamingResponseEmitter(
                bot=channel._bot,
                chat_id=callback_info.chat_id,
                message_id=callback_info.message_id,
            )

            return emitter

        except Exception as e:
            logger.exception(
                f"[TelegramCallback] Failed to create emitter for task {task_id}: {e}"
            )
            return None


# Global instance
telegram_callback_service = TelegramCallbackService()

# Register with the callback registry
get_callback_registry().register(ChannelType.TELEGRAM, telegram_callback_service)
