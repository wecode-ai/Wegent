# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram Channel Integration.

This module provides Telegram Bot integration for Wegent, allowing users to
interact with the system via Telegram instant messaging.

Features:
- Long Polling connection mode
- Text message processing
- Inline keyboard support for interactive commands
- Streaming responses via message editing
- User mapping (select_user mode)

Components:
- TelegramChannelProvider: Manages Bot lifecycle
- TelegramChannelHandler: Processes incoming messages
- TelegramCallbackService: Handles task completion callbacks
- StreamingResponseEmitter: Provides real-time response updates
- TelegramKeyboardBuilder: Builds inline keyboards for commands
- TelegramUserResolver: Maps Telegram users to Wegent users
"""

from app.services.channels.telegram.callback import (
    TelegramCallbackInfo,
    telegram_callback_service,
)
from app.services.channels.telegram.emitter import StreamingResponseEmitter
from app.services.channels.telegram.handler import TelegramChannelHandler
from app.services.channels.telegram.keyboard import TelegramKeyboardBuilder
from app.services.channels.telegram.service import TelegramChannelProvider
from app.services.channels.telegram.user_resolver import TelegramUserResolver

__all__ = [
    "TelegramChannelProvider",
    "TelegramChannelHandler",
    "TelegramCallbackInfo",
    "telegram_callback_service",
    "StreamingResponseEmitter",
    "TelegramKeyboardBuilder",
    "TelegramUserResolver",
]
