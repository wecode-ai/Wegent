# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Channels service module.

This module provides support for multiple IM platform integrations:
- DingTalk (Stream mode)
- Feishu/Lark (planned)
- WeChat Work (planned)

Each channel is configured via the database (im_channels table) and managed
by the ChannelManager singleton.
"""

from app.services.channels.base import BaseChannelProvider
from app.services.channels.manager import ChannelManager, get_channel_manager

__all__ = [
    "BaseChannelProvider",
    "ChannelManager",
    "get_channel_manager",
]
