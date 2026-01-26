# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified message models for IM integration.

These models provide a platform-agnostic representation of messages,
allowing the core system to work with any IM platform through a consistent interface.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional

from pydantic import BaseModel

# Import IMPlatform from schemas to avoid circular import
# Re-export for convenience so other modules can import from here
from app.schemas.im import IMPlatform


class IMMessageType(str, Enum):
    """Message types."""

    TEXT = "text"
    COMMAND = "command"
    IMAGE = "image"  # Future extension
    FILE = "file"  # Future extension


class IMUser(BaseModel):
    """
    Unified IM user model.

    Represents a user from any IM platform in a normalized format.
    """

    platform: IMPlatform
    platform_user_id: str  # Platform-specific user ID (e.g., Telegram user_id)
    username: Optional[str] = None  # Username (e.g., @username)
    display_name: Optional[str] = None  # Display name / full name


class IMMessage(BaseModel):
    """
    Unified inbound message model.

    Represents a message received from any IM platform in a normalized format.
    """

    platform: IMPlatform
    message_id: str  # Platform-specific message ID
    chat_id: str  # Platform-specific chat/conversation ID
    user: IMUser
    message_type: IMMessageType
    content: str  # Text content
    command: Optional[str] = None  # Command name (e.g., "new", "help")
    command_args: Optional[str] = None  # Command arguments
    timestamp: datetime
    raw_data: Optional[Dict[str, Any]] = None  # Original platform data


class IMOutboundMessage(BaseModel):
    """
    Unified outbound message model.

    Represents a message to be sent to any IM platform.
    """

    content: str  # Markdown-formatted content
    reply_to_message_id: Optional[str] = None
    parse_mode: str = "markdown"  # markdown / plain
