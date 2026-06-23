# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo callback information."""

from dataclasses import dataclass
from typing import Any, Dict

from app.services.channels.callback import BaseCallbackInfo, ChannelType


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
