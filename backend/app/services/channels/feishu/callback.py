# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu callback service."""

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
    get_callback_registry,
)
from app.services.channels.feishu.emitter import StreamingResponseEmitter

logger = logging.getLogger(__name__)


@dataclass
class FeishuCallbackInfo(BaseCallbackInfo):
    """Feishu callback information."""

    chat_id: str = ""

    def __init__(self, channel_id: int, conversation_id: str, chat_id: str):
        super().__init__(
            channel_type=ChannelType.FEISHU,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        self.chat_id = chat_id

    def to_dict(self) -> Dict[str, Any]:
        data = super().to_dict()
        data["chat_id"] = self.chat_id
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FeishuCallbackInfo":
        return cls(
            channel_id=data.get("channel_id", 0),
            conversation_id=data.get("conversation_id", ""),
            chat_id=data.get("chat_id", ""),
        )


class FeishuCallbackService(BaseChannelCallbackService[FeishuCallbackInfo]):
    """Feishu callback implementation."""

    def __init__(self):
        super().__init__(ChannelType.FEISHU)

    def _parse_callback_info(self, data: Dict[str, Any]) -> FeishuCallbackInfo:
        return FeishuCallbackInfo.from_dict(data)

    def _extract_thinking_display(self, thinking: Any) -> str:
        if not thinking:
            return ""
        if isinstance(thinking, str):
            return thinking
        if isinstance(thinking, list) and thinking:
            return str(thinking[-1])
        return ""

    async def _create_emitter(
        self, task_id: int, subtask_id: int, callback_info: FeishuCallbackInfo
    ) -> Optional[StreamingResponseEmitter]:
        try:
            from app.services.channels.manager import get_channel_manager

            manager = get_channel_manager()
            channel = manager.get_channel(callback_info.channel_id)
            if not channel or not hasattr(channel, "sender"):
                return None

            return StreamingResponseEmitter(
                sender=channel.sender,
                chat_id=callback_info.chat_id,
            )
        except Exception as exc:
            logger.exception("[FeishuCallback] Failed to create emitter: %s", exc)
            return None


feishu_callback_service = FeishuCallbackService()
get_callback_registry().register(ChannelType.FEISHU, feishu_callback_service)
