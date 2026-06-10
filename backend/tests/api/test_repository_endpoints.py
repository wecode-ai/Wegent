# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from app.api.endpoints.repository import get_repository_user_context
from app.models.user import User


def _make_user() -> tuple[User, MagicMock]:
    session = MagicMock()
    session.closed = False

    def close_session():
        session.closed = True

    session.close.side_effect = close_session
    user = User(
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
    return user, session


def test_get_repository_user_context_snapshots_and_closes_session():
    user, session = _make_user()

    gen = get_repository_user_context(current_user=user, db=session)
    user_context = next(gen)

    assert session.close.call_count == 1
    assert user_context is not user
    assert user_context.id == user.id
    assert user_context.user_name == user.user_name
    assert user_context.git_info == user.git_info


def test_get_repository_user_context_session_closed_before_yield():
    """Session must be closed before the endpoint body runs (before yield)."""
    user, session = _make_user()

    gen = get_repository_user_context(current_user=user, db=session)

    # At the point the context is yielded, the session must already be closed.
    user_context = next(gen)
    assert session.closed is True


@pytest.mark.parametrize(
    "git_info",
    [
        None,
        [],
        [{"type": "github", "git_domain": "github.com", "git_token": "t"}],
    ],
)
def test_get_repository_user_context_handles_various_git_info(git_info):
    session = MagicMock()
    user = User(id=2, user_name="bob", git_info=git_info)

    gen = get_repository_user_context(current_user=user, db=session)
    user_context = next(gen)

    assert user_context.git_info == (git_info or [])
    session.close.assert_called_once()
