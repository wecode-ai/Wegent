# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Command Parser.

This module re-exports the generic channel commands for backward compatibility.
The actual implementation is in app.services.channels.commands.
"""

# Re-export all from generic commands module for backward compatibility
from app.services.channels.commands import (
    DEVICE_ITEM_TEMPLATE,
    DEVICES_EMPTY,
    DEVICES_FOOTER,
    DEVICES_HEADER,
    HELP_MESSAGE,
    STATUS_TEMPLATE,
    CommandType,
    ParsedCommand,
    is_command,
    parse_command,
)

__all__ = [
    "CommandType",
    "ParsedCommand",
    "parse_command",
    "is_command",
    "HELP_MESSAGE",
    "STATUS_TEMPLATE",
    "DEVICES_HEADER",
    "DEVICES_EMPTY",
    "DEVICE_ITEM_TEMPLATE",
    "DEVICES_FOOTER",
]
