# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract base class for IM providers.

Each IM platform (Telegram, Slack, Discord, etc.) must implement this interface
to be integrated with Wegent.
"""

from abc import ABC, abstractmethod
from typing import Callable, Optional

from app.services.im.base.message import IMMessage, IMOutboundMessage, IMPlatform


class IMProvider(ABC):
    """
    Abstract base class for IM providers.

    Each IM platform implementation must inherit from this class and implement
    all abstract methods to provide platform-specific functionality.
    """

    def __init__(self):
        self._message_handler: Optional[Callable[[IMMessage], None]] = None

    @property
    @abstractmethod
    def platform(self) -> IMPlatform:
        """Return the platform identifier."""
        pass

    @abstractmethod
    async def initialize(self, config: dict) -> bool:
        """
        Initialize the provider with platform-specific configuration.

        Args:
            config: Platform-specific configuration (e.g., token, webhook_url)

        Returns:
            True if initialization was successful, False otherwise
        """
        pass

    @abstractmethod
    async def start(self) -> None:
        """Start the provider (begin receiving messages)."""
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stop the provider."""
        pass

    @abstractmethod
    async def send_message(self, chat_id: str, message: IMOutboundMessage) -> bool:
        """
        Send a message to a chat.

        Args:
            chat_id: Platform-specific chat/conversation ID
            message: Unified outbound message

        Returns:
            True if message was sent successfully, False otherwise
        """
        pass

    @abstractmethod
    async def send_typing_indicator(self, chat_id: str) -> None:
        """Send a typing indicator to show the bot is processing."""
        pass

    def set_message_handler(
        self, handler: Callable[[IMMessage], None]
    ) -> None:
        """
        Set the callback function for handling incoming messages.

        Args:
            handler: Async function that takes an IMMessage and processes it
        """
        self._message_handler = handler

    @abstractmethod
    async def validate_config(self, config: dict) -> tuple[bool, Optional[str]]:
        """
        Validate the configuration without fully initializing.

        Args:
            config: Platform-specific configuration

        Returns:
            Tuple of (is_valid, error_message_or_none)
        """
        pass

    @abstractmethod
    async def get_bot_info(self, config: dict) -> Optional[dict]:
        """
        Get bot information (e.g., username, avatar).

        Args:
            config: Platform-specific configuration

        Returns:
            Bot information dictionary or None if unavailable
        """
        pass
