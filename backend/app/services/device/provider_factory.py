# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device provider factory.

Creates the appropriate device provider based on device type.
Uses the Factory pattern to encapsulate provider creation logic.
"""

import logging
from typing import Dict, Optional

from app.schemas.device import DeviceType
from app.services.device.base_provider import BaseDeviceProvider
from app.services.device.local_provider import LocalDeviceProvider

logger = logging.getLogger(__name__)


class DeviceProviderFactory:
    """Factory for creating device providers.

    Manages provider registration and instantiation based on device type.
    New device types can be added by registering their providers.

    Usage:
        # Get provider for a specific device type
        provider = DeviceProviderFactory.get_provider(DeviceType.LOCAL)

        # Register a custom provider (for extensibility)
        DeviceProviderFactory.register_provider(DeviceType.CLOUD, CloudDeviceProvider)
    """

    # Registry of device type -> provider class mappings
    _providers: Dict[DeviceType, BaseDeviceProvider] = {}

    @classmethod
    def _initialize_providers(cls) -> None:
        """Initialize default providers if not already done."""
        if not cls._providers:
            # Register built-in providers
            cls._providers[DeviceType.LOCAL] = LocalDeviceProvider()

    @classmethod
    def get_provider(cls, device_type: DeviceType) -> Optional[BaseDeviceProvider]:
        """Get a provider instance for the given device type.

        Args:
            device_type: The device type to get a provider for

        Returns:
            Provider instance or None if not found
        """
        cls._initialize_providers()

        provider = cls._providers.get(device_type)
        if provider is None:
            logger.warning(
                f"[DeviceProviderFactory] No provider registered for device type: {device_type}"
            )
        return provider

    @classmethod
    def register_provider(
        cls,
        device_type: DeviceType,
        provider: BaseDeviceProvider,
    ) -> None:
        """Register a provider for a device type.

        This allows external modules to register custom providers for new
        device types without modifying the factory code.

        Args:
            device_type: The device type this provider handles
            provider: The provider instance to register
        """
        cls._providers[device_type] = provider
        logger.info(
            f"[DeviceProviderFactory] Registered provider for device type: {device_type}"
        )

    @classmethod
    def get_all_providers(cls) -> Dict[DeviceType, BaseDeviceProvider]:
        """Get all registered providers.

        Returns:
            Dictionary mapping device types to their providers
        """
        cls._initialize_providers()
        return cls._providers.copy()

    @classmethod
    def get_supported_types(cls) -> list[DeviceType]:
        """Get list of supported device types.

        Returns:
            List of DeviceType values that have registered providers
        """
        cls._initialize_providers()
        return list(cls._providers.keys())
