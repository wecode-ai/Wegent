# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo callback service and callback information."""

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
class WeiboCallbackInfo(BaseCallbackInfo):
    """Information needed to send task callbacks to Weibo."""

    to_user_id: str = ""

    def __init__(self, channel_id: int, conversation_id: str, to_user_id: str):
        super().__init__(
            channel_type=ChannelType.WEIBO,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        self.to_user_id = to_user_id

    def to_dict(self) -> Dict[str, Any]:
        data = super().to_dict()
        data["to_user_id"] = self.to_user_id
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WeiboCallbackInfo":
        return cls(
            channel_id=data.get("channel_id", 0),
            conversation_id=data.get("conversation_id", ""),
            to_user_id=data.get("to_user_id", ""),
        )


class WeiboCallbackService(BaseChannelCallbackService[WeiboCallbackInfo]):
    """Service for managing Weibo task callbacks and streaming updates."""

    def __init__(self):
        super().__init__(ChannelType.WEIBO)

    def _parse_callback_info(self, data: Dict[str, Any]) -> WeiboCallbackInfo:
        return WeiboCallbackInfo.from_dict(data)

    def _extract_thinking_display(self, thinking: Any) -> str:
        if not thinking or not isinstance(thinking, list):
            return ""
        latest = thinking[-1] if thinking else None
        if not isinstance(latest, dict):
            return str(latest) if latest else ""

        details = latest.get("details", {})
        if not isinstance(details, dict):
            return ""

        detail_type = details.get("type", "")
        if detail_type == "tool_use":
            tool_name = details.get("name", "") or details.get("tool_name", "")
            return f"工具使用: {tool_name}" if tool_name else "工具使用中..."
        if detail_type == "tool_result":
            tool_name = details.get("tool_name", "") or details.get("name", "")
            return f"工具完成: {tool_name}" if tool_name else "工具执行完成"
        if detail_type == "result":
            return "生成结果中..."
        return "处理中..."

    async def _create_emitter(
        self,
        task_id: int,
        subtask_id: int,
        callback_info: WeiboCallbackInfo,
    ) -> Optional["ResultEmitter"]:
        try:
            from app.services.channels.manager import get_channel_manager
            from app.services.channels.weibo.emitter import (
                WeiboStreamingResponseEmitter,
            )

            channel = get_channel_manager().get_channel(callback_info.channel_id)
            if not channel:
                logger.warning(
                    "[WeiboCallback] Channel %s not found",
                    callback_info.channel_id,
                )
                return None

            sender = getattr(channel, "sender", None)
            if not sender:
                logger.warning(
                    "[WeiboCallback] Channel %s has no sender",
                    callback_info.channel_id,
                )
                return None

            return WeiboStreamingResponseEmitter(
                channel_id=callback_info.channel_id,
                to_user_id=callback_info.to_user_id,
                sender=sender,
            )
        except Exception as exc:
            logger.exception(
                "[WeiboCallback] Failed to create emitter for task %s: %s",
                task_id,
                exc,
            )
            return None


weibo_callback_service = WeiboCallbackService()
get_callback_registry().register(ChannelType.WEIBO, weibo_callback_service)
