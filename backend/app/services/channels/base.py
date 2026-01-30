# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base class for IM channel providers.

All channel implementations (DingTalk, Feishu, WeChat) must inherit from
BaseChannelProvider and implement the required methods.

IM channels are stored as Messager CRD in the kinds table.
"""

import logging
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Protocol

logger = logging.getLogger(__name__)


class ChannelLike(Protocol):
    """Protocol for channel-like objects (IMChannelAdapter)."""

    id: int
    name: str
    channel_type: str
    is_enabled: bool
    config: Dict[str, Any]
    default_team_id: int
    default_model_name: str


class BaseChannelProvider(ABC):
    """
    Abstract base class for IM channel providers.

    Each provider handles the connection lifecycle and message processing
    for a specific IM platform (DingTalk, Feishu, WeChat).
    """

    def __init__(self, channel: ChannelLike):
        """
        Initialize the provider with channel configuration.

        Args:
            channel: Channel-like object (IMChannelAdapter) with configuration
        """
        self._channel = channel
        self._is_running = False
        self._start_time: Optional[float] = None
        self._last_error: Optional[str] = None

    @property
    def channel_id(self) -> int:
        """Get the channel ID."""
        return self._channel.id

    @property
    def channel_name(self) -> str:
        """Get the channel name."""
        return self._channel.name

    @property
    def channel_type(self) -> str:
        """Get the channel type."""
        return self._channel.channel_type

    @property
    def config(self) -> Dict[str, Any]:
        """Get the channel configuration."""
        return self._channel.config

    @property
    def default_team_id(self) -> int:
        """Get the default team ID for this channel."""
        return self._channel.default_team_id

    @property
    def is_running(self) -> bool:
        """Check if the provider is running."""
        return self._is_running

    @property
    def uptime_seconds(self) -> Optional[float]:
        """Get uptime in seconds since start."""
        if self._start_time is not None:
            return time.time() - self._start_time
        return None

    @property
    def last_error(self) -> Optional[str]:
        """Get the last error message."""
        return self._last_error

    @abstractmethod
    async def start(self) -> bool:
        """
        Start the channel connection.

        Returns:
            True if started successfully, False otherwise
        """
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stop the channel connection."""
        pass

    async def restart(self) -> bool:
        """
        Restart the channel connection.

        Returns:
            True if restarted successfully, False otherwise
        """
        logger.info(
            "[%s] Restarting channel %s (id=%d)...",
            self.channel_type,
            self.channel_name,
            self.channel_id,
        )
        await self.stop()
        return await self.start()

    def update_config(self, channel: ChannelLike) -> None:
        """
        Update the channel configuration.

        Args:
            channel: Updated channel-like object
        """
        self._channel = channel

    def get_status(self) -> Dict[str, Any]:
        """
        Get the current status of the provider.

        Returns:
            Dictionary containing status information
        """
        return {
            "id": self.channel_id,
            "name": self.channel_name,
            "channel_type": self.channel_type,
            "is_enabled": self._channel.is_enabled,
            "is_connected": self._is_running,
            "last_error": self._last_error,
            "uptime_seconds": self.uptime_seconds,
        }

    def _set_running(self, running: bool) -> None:
        """Set the running state and update start time."""
        self._is_running = running
        if running:
            self._start_time = time.time()
            self._last_error = None
        else:
            self._start_time = None

    def _set_error(self, error: str) -> None:
        """Set the last error message."""
        self._last_error = error
        logger.error(
            "[%s] Channel %s (id=%d) error: %s",
            self.channel_type,
            self.channel_name,
            self.channel_id,
            error,
        )
