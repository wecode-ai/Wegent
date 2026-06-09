# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.repository_job import RepositoryJobService, RepositoryUserSnapshot


@pytest.mark.asyncio
async def test_repo_job_processes_snapshots_after_loader_session_is_closed():
    service = RepositoryJobService()
    session = MagicMock()
    session.closed = False

    def close_session():
        session.closed = True

    session.close.side_effect = close_session

    snapshots = [
        RepositoryUserSnapshot(
            user_id=1,
            user_name="alice",
            git_info=[
                {
                    "type": "github",
                    "git_domain": "github.com",
                    "git_token": "token",
                }
            ],
        )
    ]

    service.load_repository_user_snapshots = MagicMock(return_value=snapshots)

    async def assert_session_closed(user):
        assert session.closed is True
        assert user.user_name == "alice"
        return "success"

    service._process_user_snapshot = AsyncMock(side_effect=assert_session_closed)

    await service.update_repositories_for_all_users(lambda: session)

    session.close.assert_called_once()
    service._process_user_snapshot.assert_awaited_once()
