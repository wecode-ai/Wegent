# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for IM provider registry.
"""

import pytest
from unittest.mock import MagicMock

from app.services.im.base.message import IMPlatform
from app.services.im.base.provider import IMProvider
from app.services.im.registry import IMProviderRegistry


class MockProvider(IMProvider):
    """Mock provider for testing."""

    @property
    def platform(self) -> IMPlatform:
        return IMPlatform.TELEGRAM

    async def initialize(self, config: dict) -> bool:
        return True

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def send_message(self, chat_id: str, message) -> bool:
        return True

    async def send_typing_indicator(self, chat_id: str) -> None:
        pass

    async def validate_config(self, config: dict) -> tuple[bool, str | None]:
        return True, None

    async def get_bot_info(self, config: dict) -> dict | None:
        return {"id": 123, "username": "test_bot"}


class TestIMProviderRegistry:
    """Tests for IMProviderRegistry."""

    def setup_method(self):
        """Clear registry before each test."""
        # Save original providers
        self._original_providers = IMProviderRegistry._providers.copy()
        IMProviderRegistry._providers.clear()

    def teardown_method(self):
        """Restore registry after each test."""
        IMProviderRegistry._providers = self._original_providers

    def test_register_decorator(self):
        """Test provider registration via decorator."""

        @IMProviderRegistry.register(IMPlatform.TELEGRAM)
        class TestProvider(MockProvider):
            pass

        assert IMProviderRegistry.is_registered(IMPlatform.TELEGRAM)
        assert IMProviderRegistry.get_provider_class(IMPlatform.TELEGRAM) == TestProvider

    def test_get_provider_class_not_registered(self):
        """Test getting a provider class that isn't registered."""
        result = IMProviderRegistry.get_provider_class(IMPlatform.SLACK)
        assert result is None

    def test_get_available_platforms(self):
        """Test getting list of available platforms."""

        @IMProviderRegistry.register(IMPlatform.TELEGRAM)
        class TestProvider1(MockProvider):
            pass

        @IMProviderRegistry.register(IMPlatform.DISCORD)
        class TestProvider2(MockProvider):
            @property
            def platform(self):
                return IMPlatform.DISCORD

        platforms = IMProviderRegistry.get_available_platforms()
        assert IMPlatform.TELEGRAM in platforms
        assert IMPlatform.DISCORD in platforms
        assert len(platforms) == 2

    def test_create_provider(self):
        """Test creating a provider instance."""

        @IMProviderRegistry.register(IMPlatform.TELEGRAM)
        class TestProvider(MockProvider):
            pass

        provider = IMProviderRegistry.create_provider(IMPlatform.TELEGRAM)
        assert provider is not None
        assert isinstance(provider, TestProvider)

    def test_create_provider_not_registered(self):
        """Test creating a provider for unregistered platform."""
        provider = IMProviderRegistry.create_provider(IMPlatform.SLACK)
        assert provider is None

    def test_is_registered(self):
        """Test checking if platform is registered."""
        assert not IMProviderRegistry.is_registered(IMPlatform.TELEGRAM)

        @IMProviderRegistry.register(IMPlatform.TELEGRAM)
        class TestProvider(MockProvider):
            pass

        assert IMProviderRegistry.is_registered(IMPlatform.TELEGRAM)
        assert not IMProviderRegistry.is_registered(IMPlatform.SLACK)
