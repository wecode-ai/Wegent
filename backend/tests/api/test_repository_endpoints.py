# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.endpoints import repository as repository_endpoint
from app.models.user import User


@pytest.mark.asyncio
async def test_get_repositories_closes_user_session_before_external_fetch(
    monkeypatch,
):
    session = MagicMock()
    session.closed = False

    def close_session():
        session.closed = True

    session.close.side_effect = close_session
    current_user = User(
        id=1,
        user_name="admin",
        git_info=[
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "token",
            }
        ],
    )

    monkeypatch.setattr(
        repository_endpoint,
        "object_session",
        lambda _: session,
    )

    async def fake_get_repositories(user_context, page: int, limit: int):
        assert session.closed is True
        assert user_context is not current_user
        assert user_context.id == current_user.id
        assert user_context.user_name == current_user.user_name
        assert user_context.git_info == current_user.git_info
        assert page == 1
        assert limit == 5000
        return []

    monkeypatch.setattr(
        repository_endpoint.repository_service,
        "get_repositories",
        AsyncMock(side_effect=fake_get_repositories),
    )

    result = await repository_endpoint.get_repositories(
        page=1,
        limit=5000,
        current_user=current_user,
    )

    assert result == []
    session.close.assert_called_once()
    repository_endpoint.repository_service.get_repositories.assert_awaited_once()
