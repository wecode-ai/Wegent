# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.user import User
from app.services import repository_job as repository_job_module
from app.services.repository_job import RepositoryJobService, RepositoryUserSnapshot


@contextmanager
def fake_db_session(session: MagicMock):
    try:
        yield session
    finally:
        session.close()


@pytest.mark.asyncio
async def test_repo_job_processes_snapshots_after_loader_session_is_closed(
    monkeypatch,
):
    service = RepositoryJobService()
    session = MagicMock()
    session.closed = False

    def close_session():
        session.closed = True

    session.close.side_effect = close_session
    source_user = User(
        id=1,
        user_name="alice",
        git_info=[
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "token",
            }
        ],
    )

    monkeypatch.setattr(
        repository_job_module,
        "get_db_session",
        lambda: fake_db_session(session),
    )
    monkeypatch.setattr(
        repository_job_module.user_service,
        "get_all_users",
        lambda _: [source_user],
    )

    async def assert_session_closed(user: RepositoryUserSnapshot):
        assert session.closed is True
        assert user.user_id == source_user.id
        assert user.id == source_user.id
        assert user.user_name == source_user.user_name
        assert user.git_info == source_user.git_info
        return "success"

    service._process_user_snapshot = AsyncMock(side_effect=assert_session_closed)

    await service.update_repositories_for_all_users()

    session.close.assert_called_once()
    service._process_user_snapshot.assert_awaited_once()


@pytest.mark.asyncio
async def test_repo_job_closes_snapshot_session_when_snapshot_fails(monkeypatch):
    service = RepositoryJobService()
    session = MagicMock()
    service._process_user_snapshot = AsyncMock()

    monkeypatch.setattr(
        repository_job_module,
        "get_db_session",
        lambda: fake_db_session(session),
    )
    monkeypatch.setattr(
        service,
        "load_repository_user_snapshots",
        MagicMock(side_effect=RuntimeError("snapshot failed")),
    )

    await service.update_repositories_for_all_users()

    session.close.assert_called_once()
    service._process_user_snapshot.assert_not_called()
