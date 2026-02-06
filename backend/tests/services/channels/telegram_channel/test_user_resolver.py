# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for TelegramUserResolver."""

from unittest.mock import MagicMock, patch

import pytest

from app.services.channels.telegram.user_resolver import (
    USER_MAPPING_MODE_EMAIL,
    USER_MAPPING_MODE_SELECT_USER,
    USER_MAPPING_MODE_USERNAME,
    TelegramUserResolver,
)


class TestTelegramUserResolver:
    """Tests for TelegramUserResolver."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        return MagicMock()

    @pytest.fixture
    def mock_user(self):
        """Create a mock User object."""
        user = MagicMock()
        user.id = 123
        user.user_name = "testuser"
        user.email = "testuser@telegram.org"
        user.is_active = True
        return user

    @pytest.mark.asyncio
    async def test_resolve_user_select_user_mode_success(self, mock_db, mock_user):
        """Test resolving user in select_user mode."""
        # Setup
        mock_db.query.return_value.filter.return_value.first.return_value = mock_user

        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
            user_mapping_config={"target_user_id": 123},
        )

        # Execute
        result = await resolver.resolve_user(
            telegram_user_id=456789,
            telegram_username="telegram_user",
        )

        # Assert
        assert result == mock_user
        mock_db.query.assert_called_once()

    @pytest.mark.asyncio
    async def test_resolve_user_select_user_mode_no_target_id(self, mock_db):
        """Test resolving user in select_user mode without target_user_id."""
        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
            user_mapping_config={},  # No target_user_id
        )

        result = await resolver.resolve_user(
            telegram_user_id=456789,
            telegram_username="telegram_user",
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_resolve_user_select_user_mode_user_not_found(self, mock_db):
        """Test resolving user in select_user mode when user not found."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
            user_mapping_config={"target_user_id": 999},
        )

        result = await resolver.resolve_user(
            telegram_user_id=456789,
            telegram_username="telegram_user",
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_resolve_user_username_mode_success(self, mock_db, mock_user):
        """Test resolving user by Telegram username."""
        mock_db.query.return_value.filter.return_value.first.return_value = mock_user

        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_mode=USER_MAPPING_MODE_USERNAME,
        )

        result = await resolver.resolve_user(
            telegram_user_id=456789,
            telegram_username="testuser",
        )

        assert result == mock_user

    @pytest.mark.asyncio
    async def test_resolve_user_username_mode_no_username(self, mock_db):
        """Test resolving user by username when no username provided."""
        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_mode=USER_MAPPING_MODE_USERNAME,
        )

        result = await resolver.resolve_user(
            telegram_user_id=456789,
            telegram_username=None,
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_resolve_user_email_mode_success(self, mock_db, mock_user):
        """Test resolving user by email constructed from username."""
        mock_db.query.return_value.filter.return_value.first.return_value = mock_user

        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_mode=USER_MAPPING_MODE_EMAIL,
        )

        result = await resolver.resolve_user(
            telegram_user_id=456789,
            telegram_username="testuser",
        )

        assert result == mock_user

    @pytest.mark.asyncio
    async def test_resolve_user_default_mode(self, mock_db, mock_user):
        """Test that default mode is select_user."""
        mock_db.query.return_value.filter.return_value.first.return_value = mock_user

        resolver = TelegramUserResolver(
            db=mock_db,
            user_mapping_config={"target_user_id": 123},
        )

        # Default mode should be select_user
        assert resolver.user_mapping_mode == USER_MAPPING_MODE_SELECT_USER

        result = await resolver.resolve_user(
            telegram_user_id=456789,
        )

        assert result == mock_user
