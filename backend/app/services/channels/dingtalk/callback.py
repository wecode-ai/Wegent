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
    from app.services.chat.trigger.emitter import ChatEventEmitter

logger = logging.getLogger(__name__)


@dataclass
class DingTalkCallbackInfo(BaseCallbackInfo):
    """Information needed to send callback to DingTalk."""

    webhook_url: Optional[str] = None  # Optional webhook URL for sending messages
    # Serialized incoming_message data for reply
    incoming_message_data: Optional[Dict[str, Any]] = None

    def __init__(
        self,
        channel_id: int,
        conversation_id: str,
        webhook_url: Optional[str] = None,
        incoming_message_data: Optional[Dict[str, Any]] = None,
    ):
        """Initialize DingTalkCallbackInfo.

        Args:
            channel_id: DingTalk channel ID for getting client
            conversation_id: DingTalk conversation ID
            webhook_url: Optional webhook URL for sending messages
            incoming_message_data: Serialized incoming_message data for reply
        """
        super().__init__(
            channel_type=ChannelType.DINGTALK,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        self.webhook_url = webhook_url
        self.incoming_message_data = incoming_message_data

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        data = super().to_dict()
        data.update(
            {
                "webhook_url": self.webhook_url,
                "incoming_message_data": self.incoming_message_data,
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
        )


class DingTalkCallbackService(BaseChannelCallbackService[DingTalkCallbackInfo]):
    """Service for managing DingTalk task callbacks and streaming updates."""

    def __init__(self):
        """Initialize the callback service."""
        super().__init__(ChannelType.DINGTALK)

    def _parse_callback_info(self, data: Dict[str, Any]) -> DingTalkCallbackInfo:
        """Parse callback info from dictionary."""
        return DingTalkCallbackInfo.from_dict(data)

    def _extract_thinking_display(self, thinking: Any) -> str:
        """Extract the latest thinking step in human-readable format.

        Only returns the most recent thinking step to avoid accumulation.

        Thinking is a list of ThinkingStep objects with structure:
        {
            "title": str,  # i18n key like "thinking.tool_use"
            "next_action": str,
            "details": {
                "type": str,  # e.g., "tool_use", "tool_result", "assistant", "system", etc.
                "name": str,  # tool name for tool_use
                "tool_name": str,  # tool name for tool_result
                "message": {  # for assistant type
                    "content": [
                        {"type": "text", "text": "..."},
                        {"type": "tool_use", "name": "Bash", "input": {...}}
                    ]
                }
                ...
            }
        }
        """
        if not thinking:
            return ""

        if not isinstance(thinking, list) or len(thinking) == 0:
            return ""

        # Get the latest thinking step
        latest = thinking[-1]
        if not isinstance(latest, dict):
            return str(latest) if latest else ""

        details = latest.get("details", {})
        if not isinstance(details, dict):
            return ""

        detail_type = details.get("type", "")

        # Format based on type
        if detail_type == "tool_use":
            tool_name = details.get("name", "") or details.get("tool_name", "")
            if tool_name:
                return f"工具使用: {tool_name}"
            return "工具使用中..."

        elif detail_type == "tool_result":
            tool_name = details.get("tool_name", "") or details.get("name", "")
            is_error = details.get("is_error", False)
            if is_error:
                return f"工具执行失败: {tool_name}"
            if tool_name:
                return f"工具完成: {tool_name}"
            return "工具执行完成"

        elif detail_type == "assistant":
            # Assistant message - check content for tool_use or text
            message = details.get("message", {})
            if isinstance(message, dict):
                content_list = message.get("content", [])
                if isinstance(content_list, list):
                    for content_item in content_list:
                        if isinstance(content_item, dict):
                            content_type = content_item.get("type", "")
                            if content_type == "tool_use":
                                tool_name = content_item.get("name", "")
                                if tool_name:
                                    return f"工具使用: {tool_name}"
                                return "工具使用中..."
                            elif content_type == "text":
                                text = content_item.get("text", "")
                                if text:
                                    # Truncate if too long
                                    if len(text) > 100:
                                        return f"{text[:100]}..."
                                    return text
            return "思考中..."

        elif detail_type == "text":
            # For text type, try to extract actual text content
            message = details.get("message", {})
            if isinstance(message, dict):
                content_list = message.get("content", [])
                if isinstance(content_list, list):
                    for content_item in content_list:
                        if isinstance(content_item, dict):
                            text = content_item.get("text", "")
                            if text:
                                # Truncate if too long
                                if len(text) > 100:
                                    return f"{text[:100]}..."
                                return text
            return "思考中..."

        elif detail_type == "system":
            subtype = details.get("subtype", "")
            if subtype == "init":
                return "系统初始化"
            return "系统消息"

        elif detail_type == "result":
            return "生成结果中..."

        # Default: return a generic message
        return "处理中..."

    async def _create_emitter(
        self, task_id: int, subtask_id: int, callback_info: DingTalkCallbackInfo
    ) -> Optional["ChatEventEmitter"]:
        """Create a streaming emitter for DingTalk.

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

            # Create new emitter
            from app.services.channels.dingtalk.emitter import StreamingResponseEmitter

            emitter = StreamingResponseEmitter(
                dingtalk_client=channel._client,
                incoming_message=incoming_message,
            )

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
