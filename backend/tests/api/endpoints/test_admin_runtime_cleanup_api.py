# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from unittest.mock import ANY, AsyncMock, patch

from fastapi.testclient import TestClient


def test_admin_runtime_cleanup_requires_task_id(
    test_client: TestClient, test_admin_token: str
):
    with (
        patch(
            "app.api.endpoints.admin.runtime_cleanup.job_service",
            create=True,
        ) as job_service,
        patch(
            "app.api.endpoints.admin.runtime_cleanup.get_executor_runtime_client",
            create=True,
        ) as get_runtime_client,
    ):
        runtime_client = AsyncMock()
        get_runtime_client.return_value = runtime_client

        response = test_client.post(
            "/api/admin/runtime-cleanup/stale",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            json={"inactive_hours": 24, "dry_run": False},
        )

    assert response.status_code == 422
    job_service.cleanup_stale_task_executors.assert_not_called()
    runtime_client.cleanup_stale_sandboxes.assert_not_called()


def test_admin_runtime_cleanup_returns_422_for_form_encoded_json(
    test_client: TestClient, test_admin_token: str
):
    response = test_client.post(
        "/api/admin/runtime-cleanup/stale",
        headers={
            "Authorization": f"Bearer {test_admin_token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data='{"task_id": 123, "inactive_hours": 24, "dry_run": false}',
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["error_code"] == 422
    assert payload["detail"] == "Request parameter validation failed"


def test_admin_runtime_cleanup_with_task_id_cleans_only_task_executor(
    test_client: TestClient, test_admin_token: str
):
    with (
        patch(
            "app.api.endpoints.admin.runtime_cleanup.job_service",
            create=True,
        ) as job_service,
        patch(
            "app.api.endpoints.admin.runtime_cleanup.get_executor_runtime_client",
            create=True,
        ) as get_runtime_client,
    ):
        job_service.cleanup_stale_task_executor = AsyncMock(
            return_value={
                "task_id": 123,
                "deleted": True,
                "skipped": False,
                "reason": "executor_deleted",
                "executors": [
                    {
                        "executor_name": "executor-123",
                        "executor_namespace": "default",
                    }
                ],
            }
        )
        job_service.cleanup_stale_task_executors = AsyncMock()
        runtime_client = AsyncMock()
        runtime_client.get_sandbox.return_value = (None, None)
        runtime_client.cleanup_stale_sandboxes = AsyncMock()
        get_runtime_client.return_value = runtime_client

        response = test_client.post(
            "/api/admin/runtime-cleanup/stale",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            json={"task_id": 123, "dry_run": False},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["task_id"] == 123
    assert payload["results"]["task_executor"]["reason"] == "executor_deleted"
    job_service.cleanup_stale_task_executor.assert_called_once_with(
        db=ANY,
        task_id=123,
        inactive_hours=24,
        dry_run=False,
    )
    job_service.cleanup_stale_task_executors.assert_not_called()
    runtime_client.cleanup_stale_sandboxes.assert_not_called()


def test_admin_runtime_cleanup_sandbox_by_task_id(
    test_client: TestClient, test_admin_token: str
):
    with patch(
        "app.api.endpoints.admin.runtime_cleanup.get_executor_runtime_client",
        create=True,
    ) as get_runtime_client:
        runtime_client = AsyncMock()
        runtime_client.cleanup_sandbox_by_task_id.return_value = {
            "target": "sandbox",
            "task_id": 1967,
            "sandbox_id": "1967",
            "deleted": True,
            "redis_cleared": True,
        }
        get_runtime_client.return_value = runtime_client

        response = test_client.post(
            "/api/admin/runtime-cleanup/sandbox",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            json={
                "task_id": 1967,
                "dry_run": False,
                "archive_before_delete": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["task_id"] == 1967
    assert payload["results"]["sandbox"]["deleted"] is True
    runtime_client.cleanup_sandbox_by_task_id.assert_awaited_once_with(
        task_id=1967,
        dry_run=False,
        archive_before_delete=False,
    )


def test_admin_runtime_cleanup_with_task_id_skips_recent_sandbox(
    test_client: TestClient, test_admin_token: str
):
    with (
        patch(
            "app.api.endpoints.admin.runtime_cleanup.job_service",
            create=True,
        ) as job_service,
        patch(
            "app.api.endpoints.admin.runtime_cleanup.get_executor_runtime_client",
            create=True,
        ) as get_runtime_client,
    ):
        job_service.cleanup_stale_task_executor = AsyncMock()
        runtime_client = AsyncMock()
        runtime_client.get_sandbox.return_value = (
            {
                "sandbox_id": "123",
                "container_name": "sandbox-123",
                "last_activity_at": time.time() - 3600,
            },
            None,
        )
        get_runtime_client.return_value = runtime_client

        response = test_client.post(
            "/api/admin/runtime-cleanup/stale",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            json={"task_id": 123, "inactive_hours": 24},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["results"]["sandbox"]["skipped"] is True
    assert payload["results"]["sandbox"]["reason"] == "not_stale"
    runtime_client.delete_sandbox.assert_not_called()
    job_service.cleanup_stale_task_executor.assert_not_called()


def test_admin_runtime_cleanup_with_task_id_archives_stale_sandbox(
    test_client: TestClient, test_admin_token: str
):
    with (
        patch(
            "app.api.endpoints.admin.runtime_cleanup.job_service",
            create=True,
        ) as job_service,
        patch(
            "app.api.endpoints.admin.runtime_cleanup.get_executor_runtime_client",
            create=True,
        ) as get_runtime_client,
    ):
        job_service.cleanup_stale_task_executor = AsyncMock()
        runtime_client = AsyncMock()
        runtime_client.get_sandbox.return_value = (
            {
                "sandbox_id": "123",
                "container_name": "sandbox-123",
                "last_activity_at": time.time() - 25 * 3600,
            },
            None,
        )
        runtime_client.cleanup_sandbox_by_task_id.return_value = {
            "target": "sandbox",
            "task_id": 123,
            "sandbox_id": "123",
            "deleted": True,
            "skipped": False,
            "archived": True,
            "archive_before_delete": True,
            "reason": "sandbox_deleted",
        }
        get_runtime_client.return_value = runtime_client

        response = test_client.post(
            "/api/admin/runtime-cleanup/stale",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            json={"task_id": 123, "inactive_hours": 24},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["archive_before_delete"] is True
    assert payload["results"]["sandbox"]["deleted"] is True
    assert payload["results"]["sandbox"]["archived"] is True
    assert payload["results"]["sandbox"]["archive_before_delete"] is True
    assert payload["results"]["sandbox"]["reason"] == "sandbox_deleted"
    runtime_client.cleanup_sandbox_by_task_id.assert_awaited_once_with(
        task_id=123,
        dry_run=False,
        archive_before_delete=True,
    )
    runtime_client.delete_sandbox.assert_not_called()
    job_service.cleanup_stale_task_executor.assert_not_called()


def test_admin_runtime_cleanup_rejects_non_admin_user(
    test_client: TestClient, test_token: str
):
    response = test_client.post(
        "/api/admin/runtime-cleanup/stale",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"inactive_hours": 24},
    )

    assert response.status_code == 403
