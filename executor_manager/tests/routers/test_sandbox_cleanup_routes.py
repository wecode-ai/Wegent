# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.routers import sandbox as sandbox_routes


@pytest.mark.asyncio
async def test_cleanup_stale_sandboxes_returns_not_stale_reasons(mocker):
    manager = mocker.Mock()
    manager.cleanup_stale_sandboxes = mocker.AsyncMock(
        return_value={
            "target": "sandboxes",
            "inactive_hours": 24,
            "dry_run": False,
            "deleted": [],
            "skipped": [
                {
                    "sandbox_id": "123",
                    "reason": "not_stale",
                    "last_activity_at": "2026-05-18T10:30:00",
                    "eligible_after": "2026-05-19T10:30:00",
                }
            ],
            "failed": [],
        }
    )
    mocker.patch.object(sandbox_routes, "get_sandbox_manager", return_value=manager)

    result = await sandbox_routes.cleanup_stale_sandboxes(
        request=sandbox_routes.CleanupStaleSandboxesRequest(
            inactive_hours=24,
            dry_run=False,
        ),
        http_request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
    )

    assert result["skipped"][0]["reason"] == "not_stale"
    manager.cleanup_stale_sandboxes.assert_awaited_once_with(
        inactive_hours=24,
        dry_run=False,
    )


@pytest.mark.asyncio
async def test_cleanup_sandbox_by_task_id_calls_manager(mocker):
    manager = mocker.Mock()
    manager.cleanup_sandbox_by_task_id = mocker.AsyncMock(
        return_value={
            "target": "sandbox",
            "task_id": 1967,
            "sandbox_id": "1967",
            "dry_run": False,
            "archive_before_delete": False,
            "deleted": True,
            "redis_cleared": True,
        }
    )
    mocker.patch.object(sandbox_routes, "get_sandbox_manager", return_value=manager)

    result = await sandbox_routes.cleanup_sandbox_by_task_id(
        request=sandbox_routes.CleanupSandboxByTaskRequest(
            task_id=1967,
            dry_run=False,
            archive_before_delete=False,
        ),
        http_request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
    )

    assert result["deleted"] is True
    manager.cleanup_sandbox_by_task_id.assert_awaited_once_with(
        task_id=1967,
        dry_run=False,
        archive_before_delete=False,
    )
