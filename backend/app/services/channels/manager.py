# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Channel Manager for managing all IM channel instances.

The ChannelManager is a singleton that handles:
- Starting/stopping channel providers
- Managing provider lifecycle
- Providing status information
- Provider registration for extensibility

IM channels are stored as Messager CRD in the kinds table.
"""

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Protocol

from sqlalchemy.orm import Session

from app.services.channels.callback import ChannelType

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


# Type alias for provider factory function
ProviderFactory = Callable[[ChannelLike], "BaseChannelProvider"]


class ChannelManager:
    """
    Singleton manager for all IM channel instances.

    Handles the lifecycle of channel providers, including starting,
    stopping, and restarting based on database configuration.

    Supports extensible provider registration for new channel types.
    """

    _instance: Optional["ChannelManager"] = None
    _channels: Dict[int, "BaseChannelProvider"]  # channel_id -> provider instance
    _provider_factories: Dict[str, ProviderFactory]  # channel_type -> factory function
    _channel_locks: Dict[int, asyncio.Lock]  # channel_id -> lifecycle lock

    def __new__(cls) -> "ChannelManager":
        """Ensure singleton pattern."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._channels = {}
            cls._instance._provider_factories = {}
            cls._instance._channel_locks = {}
            cls._instance._register_default_providers()
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
            cls._instance._provider_factories = {}
            cls._instance._channel_locks = {}
        cls._instance = None

    def _register_default_providers(self) -> None:
        """Register default provider factories."""
        # Register DingTalk provider
        self.register_provider_factory(
            ChannelType.DINGTALK.value,
            self._create_dingtalk_provider,
        )
        # Register Telegram provider
        self.register_provider_factory(
            ChannelType.TELEGRAM.value,
            self._create_telegram_provider,
        )
        # Register Discord provider
        self.register_provider_factory(
            ChannelType.DISCORD.value,
            self._create_discord_provider,
        )
        # Future providers can be registered here or via register_provider_factory()

    def register_provider_factory(
        self, channel_type: str, factory: ProviderFactory
    ) -> None:
        """
        Register a provider factory for a channel type.

        This allows extending the manager with new channel types without
        modifying the core code.

        Args:
            channel_type: The channel type string (e.g., "dingtalk", "feishu")
            factory: Factory function that creates a provider instance
        """
        self._provider_factories[channel_type] = factory
        logger.info(
            "[ChannelManager] Registered provider factory for channel type: %s",
            channel_type,
        )

    def unregister_provider_factory(self, channel_type: str) -> None:
        """
        Unregister a provider factory for a channel type.

        Args:
            channel_type: The channel type string
        """
        if channel_type in self._provider_factories:
            del self._provider_factories[channel_type]
            logger.info(
                "[ChannelManager] Unregistered provider factory for channel type: %s",
                channel_type,
            )

    def get_supported_channel_types(self) -> List[str]:
        """
        Get list of supported channel types.

        Returns:
            List of channel type strings
        """
        return list(self._provider_factories.keys())

    def _get_channel_lock(self, channel_id: int) -> asyncio.Lock:
        """Get or create the lifecycle lock for a channel."""
        lock = self._channel_locks.get(channel_id)
        if lock is None:
            lock = asyncio.Lock()
            self._channel_locks[channel_id] = lock
        return lock

    @staticmethod
    def _create_dingtalk_provider(channel: ChannelLike) -> "BaseChannelProvider":
        """Create a DingTalk provider instance."""
        from app.services.channels.dingtalk.service import DingTalkChannelProvider

        return DingTalkChannelProvider(channel)

    @staticmethod
    def _create_telegram_provider(channel: ChannelLike) -> "BaseChannelProvider":
        """Create a Telegram provider instance."""
        from app.services.channels.telegram.service import TelegramChannelProvider

        return TelegramChannelProvider(channel)

    @staticmethod
    def _create_discord_provider(channel: ChannelLike) -> "BaseChannelProvider":
        """Create a Discord provider instance."""
        from app.services.channels.discord.service import DiscordChannelProvider

        return DiscordChannelProvider(channel)

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
        async with self._get_channel_lock(channel.id):
            return await self._start_channel_locked(channel)

    async def _start_channel_locked(self, channel: ChannelLike) -> bool:
        """Start a single channel while holding its lifecycle lock."""
        existing_provider = self._channels.get(channel.id)
        if existing_provider is not None and existing_provider.is_running:
            logger.warning(
                "[ChannelManager] Channel %s (id=%d) is already running",
                channel.name,
                channel.id,
            )
            return True

        if existing_provider is not None:
            logger.warning(
                "[ChannelManager] Channel %s (id=%d) has a stale stopped provider; "
                "cleaning it before restart",
                channel.name,
                channel.id,
            )
            await self._stop_channel_locked(channel.id)

        provider = self._create_provider(channel)
        if provider is None:
            logger.warning(
                "[ChannelManager] Unknown channel type: %s. Supported types: %s",
                channel.channel_type,
                ", ".join(self.get_supported_channel_types()),
            )
            return False

        try:
            success = await provider.start()
            if success and provider.is_running:
                self._channels[channel.id] = provider
                logger.info(
                    "[ChannelManager] Started channel %s (id=%d, type=%s)",
                    channel.name,
                    channel.id,
                    channel.channel_type,
                )
                return True

            if success:
                logger.warning(
                    "[ChannelManager] Channel %s (id=%d, type=%s) reported start "
                    "success but is not running",
                    channel.name,
                    channel.id,
                    channel.channel_type,
                )
                await provider.stop()
            return False
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
        async with self._get_channel_lock(channel_id):
            await self._stop_channel_locked(channel_id)

    async def _stop_channel_locked(self, channel_id: int) -> None:
        """Stop a single channel while holding its lifecycle lock."""
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
            self._channels.pop(channel_id, None)

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
        async with self._get_channel_lock(channel.id):
            await self._stop_channel_locked(channel.id)
            return await self._start_channel_locked(channel)

    def _create_provider(self, channel: ChannelLike) -> Optional["BaseChannelProvider"]:
        """
        Create a provider instance based on channel type.

        Uses registered provider factories for extensibility.

        Args:
            channel: Channel-like object

        Returns:
            Provider instance or None if type is unknown
        """
        factory = self._provider_factories.get(channel.channel_type)
        if factory:
            return factory(channel)
        return None

    def _get_running_provider(
        self, channel_id: int
    ) -> Optional["BaseChannelProvider"]:
        """Get a running provider and clean stale stopped entries."""
        provider = self._channels.get(channel_id)
        if provider is None:
            return None

        if provider.is_running:
            return provider

        logger.warning(
            "[ChannelManager] Channel %s (id=%d) has stopped; removing stale provider",
            provider.channel_name,
            channel_id,
        )
        self._channels.pop(channel_id, None)
        return None

    def _get_running_providers(self) -> List["BaseChannelProvider"]:
        """Get all running providers and clean stale stopped entries."""
        running_providers = []
        for channel_id in list(self._channels.keys()):
            provider = self._get_running_provider(channel_id)
            if provider is not None:
                running_providers.append(provider)
        return running_providers

    def get_channel(self, channel_id: int) -> Optional["BaseChannelProvider"]:
        """
        Get a running channel provider by ID.

        Args:
            channel_id: ID of the channel

        Returns:
            Channel provider instance or None if not running
        """
        return self._get_running_provider(channel_id)

    def get_channel_by_type(self, channel_type: str) -> List["BaseChannelProvider"]:
        """
        Get all running channel providers of a specific type.

        Args:
            channel_type: The channel type string

        Returns:
            List of channel provider instances
        """
        return [
            provider
            for provider in self._get_running_providers()
            if provider.channel_type == channel_type
        ]

    def get_status(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """
        Get the status of a specific channel.

        Args:
            channel_id: ID of the channel

        Returns:
            Status dictionary or None if channel is not running
        """
        provider = self._get_running_provider(channel_id)
        if provider is None:
            return None
        return provider.get_status()

    def get_all_statuses(self) -> List[Dict[str, Any]]:
        """
        Get status of all running channels.

        Returns:
            List of status dictionaries
        """
        return [provider.get_status() for provider in self._get_running_providers()]

    def is_channel_running(self, channel_id: int) -> bool:
        """
        Check if a channel is currently running.

        Args:
            channel_id: ID of the channel

        Returns:
            True if channel is running, False otherwise
        """
        return self._get_running_provider(channel_id) is not None

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


def register_channel_provider(channel_type: str, factory: ProviderFactory) -> None:
    """
    Register a channel provider factory.

    This is a convenience function for registering new channel types
    from external modules.

    Args:
        channel_type: The channel type string (e.g., "feishu", "telegram")
        factory: Factory function that creates a provider instance

    Example:
        from app.services.channels.manager import register_channel_provider
        from app.services.channels.feishu.service import FeishuChannelProvider

        register_channel_provider("feishu", lambda ch: FeishuChannelProvider(ch))
    """
    get_channel_manager().register_provider_factory(channel_type, factory)
