# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base classes and interfaces for IM integration.
"""

from app.services.im.base.formatter import IMFormatter
from app.services.im.base.message import (
    IMMessage,
    IMMessageType,
    IMOutboundMessage,
    IMPlatform,
    IMUser,
)
from app.services.im.base.provider import IMProvider
from app.services.im.base.session import IMSession

__all__ = [
    "IMProvider",
    "IMFormatter",
    "IMMessage",
    "IMOutboundMessage",
    "IMUser",
    "IMPlatform",
    "IMMessageType",
    "IMSession",
]
