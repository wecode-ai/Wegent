# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk callback service for device/cloud task execution.

This module provides functionality to send streaming updates and task completion
results back to DingTalk when tasks are executed on devices or cloud executors.

Supports:
- Streaming progress updates via AI Card
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
class DingTalkCallbackInfo(BaseCallbackInfo):
    """Information needed to send callback to DingTalk."""

    webhook_url: Optional[str] = None  # Optional webhook URL for sending messages
    # Serialized incoming_message data for reply
    incoming_message_data: Optional[Dict[str, Any]] = None
    # AI Card instance ID for cross-worker emitter reconstruction
    card_instance_id: Optional[str] = None

    def __init__(
        self,
        channel_id: int,
        conversation_id: str,
        webhook_url: Optional[str] = None,
        incoming_message_data: Optional[Dict[str, Any]] = None,
        card_instance_id: Optional[str] = None,
    ):
        """Initialize DingTalkCallbackInfo.

        Args:
            channel_id: DingTalk channel ID for getting client
            conversation_id: DingTalk conversation ID
            webhook_url: Optional webhook URL for sending messages
            incoming_message_data: Serialized incoming_message data for reply
            card_instance_id: AI Card instance ID for cross-worker reconstruction
        """
        super().__init__(
            channel_type=ChannelType.DINGTALK,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        self.webhook_url = webhook_url
        self.incoming_message_data = incoming_message_data
        self.card_instance_id = card_instance_id

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        data = super().to_dict()
        data.update(
            {
                "webhook_url": self.webhook_url,
                "incoming_message_data": self.incoming_message_data,
                "card_instance_id": self.card_instance_id,
            }
        )
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DingTalkCallbackInfo":
        """Create from dictionary."""
        return cls(
            channel_id=data.get("channel_id", 0),
            conversation_id=data.get("conversation_id", ""),
            webhook_url=data.get("webhook_url"),
            incoming_message_data=data.get("incoming_message_data"),
            card_instance_id=data.get("card_instance_id"),
        )


class DingTalkCallbackService(BaseChannelCallbackService[DingTalkCallbackInfo]):
    """Service for managing DingTalk task callbacks and streaming updates."""

    def __init__(self):
        """Initialize the callback service."""
        super().__init__(ChannelType.DINGTALK)

    def _parse_callback_info(self, data: Dict[str, Any]) -> DingTalkCallbackInfo:
        """Parse callback info from dictionary."""
        return DingTalkCallbackInfo.from_dict(data)

    async def _create_emitter(
        self, task_id: int, subtask_id: int, callback_info: DingTalkCallbackInfo
    ) -> Optional["ResultEmitter"]:
        """Create a streaming emitter for DingTalk.

        If callback_info contains a card_instance_id from a previously started
        AI Card, reconstructs the emitter to continue streaming to the same card
        (cross-worker scenario).

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            callback_info: DingTalk callback information

        Returns:
            StreamingResponseEmitter or None if creation failed
        """
        try:
            # Get DingTalk channel to access the client
            from app.services.channels.manager import get_channel_manager

            channel_manager = get_channel_manager()
            channel = channel_manager.get_channel(callback_info.channel_id)
            if not channel:
                logger.warning(
                    f"[DingTalkCallback] Channel {callback_info.channel_id} not found"
                )
                return None

            # Get the DingTalk client from the channel
            if not hasattr(channel, "_client") or not channel._client:
                logger.warning(
                    f"[DingTalkCallback] Channel {callback_info.channel_id} has no client"
                )
                return None

            # Reconstruct ChatbotMessage from saved data
            from dingtalk_stream import ChatbotMessage

            if not callback_info.incoming_message_data:
                logger.warning(
                    f"[DingTalkCallback] No incoming_message_data for task {task_id}"
                )
                return None

            incoming_message = ChatbotMessage.from_dict(
                callback_info.incoming_message_data
            )

            # Create emitter, reconnecting to existing card if possible
            from app.services.channels.dingtalk.emitter import StreamingResponseEmitter

            existing_card_id = callback_info.card_instance_id
            if existing_card_id:
                logger.info(
                    f"[DingTalkCallback] Reconstructing emitter for existing card "
                    f"{existing_card_id} on task {task_id}"
                )

            emitter = StreamingResponseEmitter(
                dingtalk_client=channel._client,
                incoming_message=incoming_message,
                existing_card_instance_id=existing_card_id,
            )

            # Enable Redis-backed content sharing for multi-pod consistency
            emitter.set_shared_content_key(f"channel:streaming_content:{task_id}")

            return emitter

        except Exception as e:
            logger.exception(
                f"[DingTalkCallback] Failed to create emitter for task {task_id}: {e}"
            )
            return None


# Global instance
dingtalk_callback_service = DingTalkCallbackService()

# Register with the callback registry
get_callback_registry().register(ChannelType.DINGTALK, dingtalk_callback_service)
