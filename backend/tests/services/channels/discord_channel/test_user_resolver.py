# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from app.services.channels.discord.user_resolver import (
    USER_MAPPING_MODE_DISCORD_USER_ID,
    USER_MAPPING_MODE_EMAIL,
    USER_MAPPING_MODE_SELECT_USER,
    DiscordUserResolver,
)


@pytest.fixture
def mock_db():
    return MagicMock()


@pytest.fixture
def mock_user():
    user = MagicMock()
    user.id = 123
    user.user_name = "discord-user"
    user.email = "discord@example.com"
    user.is_active = True
    return user


@pytest.mark.asyncio
async def test_resolve_user_select_user_mode_success(mock_db, mock_user):
    mock_db.query.return_value.filter.return_value.first.return_value = mock_user
    resolver = DiscordUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
        user_mapping_config={"target_user_id": 123},
    )

    result = await resolver.resolve_user(
        discord_user_id=456789,
        discord_username="alice",
    )

    assert result == mock_user


@pytest.mark.asyncio
async def test_resolve_user_discord_user_id_mode_success(mock_db, mock_user):
    mock_db.query.return_value.filter.return_value.first.return_value = mock_user
    resolver = DiscordUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_DISCORD_USER_ID,
    )

    result = await resolver.resolve_user(
        discord_user_id=456789,
        discord_username="alice",
    )

    assert result == mock_user


@pytest.mark.asyncio
async def test_resolve_user_email_mode_success(mock_db, mock_user):
    mock_db.query.return_value.filter.return_value.first.return_value = mock_user
    resolver = DiscordUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_EMAIL,
        user_mapping_config={"email_domain": "discord.example"},
    )

    result = await resolver.resolve_user(
        discord_user_id=456789,
        discord_username="alice",
    )

    assert result == mock_user


@pytest.mark.asyncio
async def test_resolve_user_select_user_mode_without_target_user_returns_none(mock_db):
    resolver = DiscordUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
        user_mapping_config={},
    )

    result = await resolver.resolve_user(
        discord_user_id=456789,
        discord_username="alice",
    )

    assert result is None
    mock_db.query.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_user_email_mode_without_username_returns_none(mock_db):
    resolver = DiscordUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_EMAIL,
        user_mapping_config={"email_domain": "discord.example"},
    )

    result = await resolver.resolve_user(
        discord_user_id=456789,
        discord_username=None,
    )

    assert result is None
    mock_db.query.assert_not_called()
