# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Provider Registry.

Manages registration and lookup of IM provider implementations.
Uses the registry pattern to allow dynamic registration of new providers.
"""

import logging
from typing import Dict, List, Optional, Type

from app.services.im.base.message import IMPlatform
from app.services.im.base.provider import IMProvider

logger = logging.getLogger(__name__)


class IMProviderRegistry:
    """
    IM Provider Registry.

    Manages all available IM provider implementations. Providers register
    themselves using the @register decorator, and can be retrieved by platform.
    """

    _providers: Dict[IMPlatform, Type[IMProvider]] = {}

    @classmethod
    def register(cls, platform: IMPlatform):
        """
        Decorator to register a provider implementation.

        Usage:
            @IMProviderRegistry.register(IMPlatform.TELEGRAM)
            class TelegramProvider(IMProvider):
                ...

        Args:
            platform: The platform this provider implements

        Returns:
            Decorator function
        """

        def decorator(provider_class: Type[IMProvider]):
            cls._providers[platform] = provider_class
            logger.info(f"Registered IM provider: {platform.value}")
            return provider_class

        return decorator

    @classmethod
    def get_provider_class(cls, platform: IMPlatform) -> Optional[Type[IMProvider]]:
        """
        Get the provider class for a platform.

        Args:
            platform: The platform to get the provider for

        Returns:
            The provider class, or None if not registered
        """
        return cls._providers.get(platform)

    @classmethod
    def get_available_platforms(cls) -> List[IMPlatform]:
        """
        Get all registered platforms.

        Returns:
            List of available platforms
        """
        return list(cls._providers.keys())

    @classmethod
    def create_provider(cls, platform: IMPlatform) -> Optional[IMProvider]:
        """
        Create a new provider instance for a platform.

        Args:
            platform: The platform to create a provider for

        Returns:
            A new provider instance, or None if the platform is not registered
        """
        provider_class = cls.get_provider_class(platform)
        if provider_class:
            return provider_class()
        logger.warning(f"No provider registered for platform: {platform}")
        return None

    @classmethod
    def is_registered(cls, platform: IMPlatform) -> bool:
        """
        Check if a platform has a registered provider.

        Args:
            platform: The platform to check

        Returns:
            True if a provider is registered, False otherwise
        """
        return platform in cls._providers
