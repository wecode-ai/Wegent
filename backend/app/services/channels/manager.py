# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Channel Manager for managing all IM channel instances.

The ChannelManager is a singleton that handles:
- Starting/stopping channel providers
- Managing provider lifecycle
- Providing status information

IM channels are stored as Messager CRD in the kinds table.
"""

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Protocol

from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from app.services.channels.base import BaseChannelProvider

logger = logging.getLogger(__name__)

# CRD kind for IM channels
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0


class ChannelLike(Protocol):
    """Protocol for channel-like objects (IMChannel or IMChannelAdapter)."""

    id: int
    name: str
    channel_type: str
    is_enabled: bool
    config: Dict[str, Any]
    default_team_id: int
    default_model_name: str


class ChannelManager:
    """
    Singleton manager for all IM channel instances.

    Handles the lifecycle of channel providers, including starting,
    stopping, and restarting based on database configuration.
    """

    _instance: Optional["ChannelManager"] = None
    _channels: Dict[int, "BaseChannelProvider"]  # channel_id -> provider instance

    def __new__(cls) -> "ChannelManager":
        """Ensure singleton pattern."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._channels = {}
        return cls._instance

    @classmethod
    def get_instance(cls) -> "ChannelManager":
        """Get the singleton instance."""
        if cls._instance is None:
            cls._instance = ChannelManager()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton instance (for testing)."""
        if cls._instance is not None:
            cls._instance._channels = {}
        cls._instance = None

    async def start_all_enabled(self, db: Session) -> int:
        """
        Start all enabled channels from the database.

        This should be called during application startup.
        IM channels are stored as Messager CRD in the kinds table.

        Args:
            db: Database session

        Returns:
            Number of channels started successfully
        """
        from app.api.endpoints.admin.im_channels import IMChannelAdapter
        from app.models.kind import Kind

        # Query all active Messager CRDs
        channels = (
            db.query(Kind)
            .filter(
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .all()
        )

        # Filter enabled channels
        enabled_channels = [
            ch for ch in channels if ch.json.get("spec", {}).get("isEnabled", True)
        ]

        logger.info("[ChannelManager] Found %d enabled channels", len(enabled_channels))

        started_count = 0
        for channel in enabled_channels:
            try:
                adapter = IMChannelAdapter(channel)
                if await self.start_channel(adapter):
                    started_count += 1
            except Exception as e:
                logger.exception(
                    "[ChannelManager] Failed to start channel %s (id=%d): %s",
                    channel.name,
                    channel.id,
                    e,
                )

        logger.info(
            "[ChannelManager] Started %d/%d channels",
            started_count,
            len(enabled_channels),
        )
        return started_count

    async def start_channel(self, channel: ChannelLike) -> bool:
        """
        Start a single channel.

        Args:
            channel: Channel-like object (IMChannel or IMChannelAdapter)

        Returns:
            True if started successfully, False otherwise
        """
        if channel.id in self._channels:
            logger.warning(
                "[ChannelManager] Channel %s (id=%d) is already running",
                channel.name,
                channel.id,
            )
            return True

        provider = self._create_provider(channel)
        if provider is None:
            logger.warning(
                "[ChannelManager] Unknown channel type: %s", channel.channel_type
            )
            return False

        try:
            success = await provider.start()
            if success:
                self._channels[channel.id] = provider
                logger.info(
                    "[ChannelManager] Started channel %s (id=%d, type=%s)",
                    channel.name,
                    channel.id,
                    channel.channel_type,
                )
            return success
        except Exception as e:
            logger.exception(
                "[ChannelManager] Error starting channel %s (id=%d): %s",
                channel.name,
                channel.id,
                e,
            )
            return False

    async def stop_channel(self, channel_id: int) -> None:
        """
        Stop a single channel.

        Args:
            channel_id: ID of the channel to stop
        """
        if channel_id not in self._channels:
            logger.debug(
                "[ChannelManager] Channel id=%d is not running, skipping stop",
                channel_id,
            )
            return

        provider = self._channels[channel_id]
        try:
            await provider.stop()
            logger.info(
                "[ChannelManager] Stopped channel %s (id=%d)",
                provider.channel_name,
                channel_id,
            )
        except Exception as e:
            logger.exception(
                "[ChannelManager] Error stopping channel id=%d: %s", channel_id, e
            )
        finally:
            del self._channels[channel_id]

    async def restart_channel(self, channel: ChannelLike) -> bool:
        """
        Restart a channel (used after configuration update).

        Args:
            channel: Updated channel-like object

        Returns:
            True if restarted successfully, False otherwise
        """
        logger.info(
            "[ChannelManager] Restarting channel %s (id=%d)...",
            channel.name,
            channel.id,
        )
        await self.stop_channel(channel.id)
        return await self.start_channel(channel)

    def _create_provider(self, channel: ChannelLike) -> Optional["BaseChannelProvider"]:
        """
        Create a provider instance based on channel type.

        Args:
            channel: Channel-like object

        Returns:
            Provider instance or None if type is unknown
        """
        if channel.channel_type == "dingtalk":
            from app.services.channels.dingtalk.service import DingTalkChannelProvider

            return DingTalkChannelProvider(channel)
        # Future implementations:
        # elif channel.channel_type == "feishu":
        #     from app.services.channels.feishu.service import FeishuChannelProvider
        #     return FeishuChannelProvider(channel)
        # elif channel.channel_type == "wechat":
        #     from app.services.channels.wechat.service import WeChatChannelProvider
        #     return WeChatChannelProvider(channel)
        return None

    def get_status(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """
        Get the status of a specific channel.

        Args:
            channel_id: ID of the channel

        Returns:
            Status dictionary or None if channel is not running
        """
        if channel_id in self._channels:
            return self._channels[channel_id].get_status()
        return None

    def get_all_statuses(self) -> List[Dict[str, Any]]:
        """
        Get status of all running channels.

        Returns:
            List of status dictionaries
        """
        return [provider.get_status() for provider in self._channels.values()]

    def is_channel_running(self, channel_id: int) -> bool:
        """
        Check if a channel is currently running.

        Args:
            channel_id: ID of the channel

        Returns:
            True if channel is running, False otherwise
        """
        return channel_id in self._channels

    async def stop_all(self) -> int:
        """
        Stop all running channels.

        This should be called during application shutdown.

        Returns:
            Number of channels stopped
        """
        channel_ids = list(self._channels.keys())
        logger.info("[ChannelManager] Stopping %d channels...", len(channel_ids))

        for channel_id in channel_ids:
            await self.stop_channel(channel_id)

        logger.info("[ChannelManager] All channels stopped")
        return len(channel_ids)


# Convenience function to get the manager instance
def get_channel_manager() -> ChannelManager:
    """Get the ChannelManager singleton instance."""
    return ChannelManager.get_instance()
