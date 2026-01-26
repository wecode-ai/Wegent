# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Telegram provider.
"""

import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.im.base.message import IMMessageType, IMOutboundMessage, IMPlatform
from app.services.im.providers.telegram.provider import TelegramProvider


@pytest.fixture
def provider():
    """Create a provider instance."""
    return TelegramProvider()


class TestTelegramProvider:
    """Tests for TelegramProvider."""

    def test_platform_property(self, provider):
        """Test platform property returns correct value."""
        assert provider.platform == IMPlatform.TELEGRAM

    @pytest.mark.asyncio
    async def test_validate_config_missing_token(self, provider):
        """Test validation fails without token."""
        valid, error = await provider.validate_config({})
        assert not valid
        # Either library not installed or token is required
        assert "Token is required" in error or "not installed" in error

    @pytest.mark.asyncio
    async def test_validate_config_with_token(self, provider):
        """Test validation with token (mocked)."""
        # Skip if telegram library not available
        try:
            from telegram import Bot
        except ImportError:
            pytest.skip("python-telegram-bot not installed")

        with patch("app.services.im.providers.telegram.provider.Bot") as mock_bot_class:
            mock_bot = MagicMock()
            mock_bot.get_me = AsyncMock(return_value=MagicMock(
                id=123,
                username="test_bot",
            ))
            mock_bot_class.return_value = mock_bot

            valid, error = await provider.validate_config({"token": "test_token"})
            assert valid
            assert error is None

    @pytest.mark.asyncio
    async def test_get_bot_info_missing_token(self, provider):
        """Test get_bot_info returns None without token."""
        result = await provider.get_bot_info({})
        assert result is None

    @pytest.mark.asyncio
    async def test_get_bot_info_with_token(self, provider):
        """Test get_bot_info with valid token."""
        # Skip if telegram library not available
        try:
            from telegram import Bot
        except ImportError:
            pytest.skip("python-telegram-bot not installed")

        with patch("app.services.im.providers.telegram.provider.Bot") as mock_bot_class:
            mock_me = MagicMock()
            mock_me.id = 123
            mock_me.username = "test_bot"
            mock_me.first_name = "Test Bot"
            mock_me.can_join_groups = True
            mock_me.can_read_all_group_messages = False

            mock_bot = MagicMock()
            mock_bot.get_me = AsyncMock(return_value=mock_me)
            mock_bot_class.return_value = mock_bot

            result = await provider.get_bot_info({"token": "test_token"})
            assert result is not None
            assert result["id"] == 123
            assert result["username"] == "test_bot"

    @pytest.mark.asyncio
    async def test_initialize_without_token(self, provider):
        """Test initialize fails without token."""
        result = await provider.initialize({})
        assert not result

    @pytest.mark.asyncio
    async def test_send_message_not_initialized(self, provider):
        """Test send_message returns False when not initialized."""
        message = IMOutboundMessage(content="Test message")
        result = await provider.send_message("12345", message)
        assert not result

    def test_set_message_handler(self, provider):
        """Test setting message handler."""
        handler = MagicMock()
        provider.set_message_handler(handler)
        assert provider._message_handler == handler

    @pytest.mark.asyncio
    async def test_send_typing_not_initialized(self, provider):
        """Test send_typing_indicator when not initialized."""
        # Should not raise, just return silently
        await provider.send_typing_indicator("12345")
