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
