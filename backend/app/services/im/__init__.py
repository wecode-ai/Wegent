# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Integration Framework

A provider-based abstraction layer for integrating various IM platforms
(Telegram, Slack, Discord, Feishu, DingTalk, WeChat, etc.) with Wegent.
"""

from app.services.im.base.message import (
    IMMessage,
    IMMessageType,
    IMOutboundMessage,
    IMPlatform,
    IMUser,
)
from app.services.im.base.provider import IMProvider
from app.services.im.base.session import IMSession
from app.services.im.registry import IMProviderRegistry

# Note: im_manager is not imported here to avoid circular imports
# Import it directly when needed: from app.services.im.manager import im_manager

__all__ = [
    # Base classes
    "IMProvider",
    "IMMessage",
    "IMOutboundMessage",
    "IMUser",
    "IMPlatform",
    "IMMessageType",
    "IMSession",
    # Registry
    "IMProviderRegistry",
]
