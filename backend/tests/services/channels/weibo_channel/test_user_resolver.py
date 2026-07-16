# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from app.services.channels.weibo.user_resolver import (
    USER_MAPPING_MODE_EMAIL,
    USER_MAPPING_MODE_SELECT_USER,
    USER_MAPPING_MODE_WEIBO_USER_ID,
    WeiboUserResolver,
)


@pytest.fixture
def mock_db():
    return MagicMock()


@pytest.fixture
def mock_user():
    user = MagicMock()
    user.id = 123
    user.user_name = "10001"
    user.email = "alice@weibo.example"
    user.is_active = True
    return user


@pytest.mark.asyncio
async def test_resolve_user_select_user_mode_success(mock_db, mock_user):
    mock_db.query.return_value.filter.return_value.first.return_value = mock_user
    resolver = WeiboUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
        user_mapping_config={"target_user_id": 123},
    )

    result = await resolver.resolve_user(weibo_user_id="10001")

    assert result == mock_user


@pytest.mark.asyncio
async def test_resolve_user_weibo_user_id_mode_success(mock_db, mock_user):
    mock_db.query.return_value.filter.return_value.first.return_value = mock_user
    resolver = WeiboUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_WEIBO_USER_ID,
    )

    result = await resolver.resolve_user(weibo_user_id="10001")

    assert result == mock_user


@pytest.mark.asyncio
async def test_resolve_user_email_mode_success(mock_db, mock_user):
    mock_db.query.return_value.filter.return_value.first.return_value = mock_user
    resolver = WeiboUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_EMAIL,
    )

    result = await resolver.resolve_user(
        weibo_user_id="10001",
        weibo_email="alice@weibo.example",
    )

    assert result == mock_user


@pytest.mark.asyncio
async def test_resolve_user_select_user_mode_without_target_user_returns_none(mock_db):
    resolver = WeiboUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_SELECT_USER,
        user_mapping_config={},
    )

    result = await resolver.resolve_user(weibo_user_id="10001")

    assert result is None
    mock_db.query.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_user_email_mode_without_email_returns_none(mock_db):
    resolver = WeiboUserResolver(
        db=mock_db,
        user_mapping_mode=USER_MAPPING_MODE_EMAIL,
    )

    result = await resolver.resolve_user(weibo_user_id="10001", weibo_email=None)

    assert result is None
    mock_db.query.assert_not_called()
