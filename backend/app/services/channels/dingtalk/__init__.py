# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk channel provider module.

Provides DingTalk Stream mode integration for Wegent.
"""

from app.services.channels.dingtalk.emitter import (
    StreamingResponseEmitter,
    SyncResponseEmitter,
)
from app.services.channels.dingtalk.handler import WegentChatbotHandler
from app.services.channels.dingtalk.service import DingTalkChannelProvider
from app.services.channels.dingtalk.user_mapping import (
    BaseUserMapper,
    DefaultUserMapper,
    MappedUserInfo,
    get_user_mapper,
    set_user_mapper,
)
from app.services.channels.dingtalk.user_resolver import DingTalkUserResolver

__all__ = [
    "DingTalkChannelProvider",
    "WegentChatbotHandler",
    "DingTalkUserResolver",
    "SyncResponseEmitter",
    "StreamingResponseEmitter",
    "BaseUserMapper",
    "DefaultUserMapper",
    "MappedUserInfo",
    "get_user_mapper",
    "set_user_mapper",
]
