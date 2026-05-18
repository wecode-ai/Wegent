# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock, patch

from fastapi.testclient import TestClient


def test_admin_runtime_cleanup_returns_not_stale_reasons(
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
        job_service.cleanup_stale_task_executors = AsyncMock(
            return_value={
                "target": "task_executors",
                "inactive_hours": 24,
                "dry_run": False,
                "deleted": [],
                "skipped": [
                    {
                        "task_id": 123,
                        "executor_name": "executor-recent",
                        "executor_namespace": "default",
                        "reason": "not_stale",
                        "last_updated_at": "2026-05-18T10:30:00",
                        "eligible_after": "2026-05-19T10:30:00",
                    }
                ],
                "failed": [],
            }
        )
        runtime_client = AsyncMock()
        runtime_client.cleanup_stale_sandboxes.return_value = {
            "target": "sandboxes",
            "inactive_hours": 24,
            "dry_run": False,
            "deleted": [],
            "skipped": [
                {
                    "sandbox_id": "456",
                    "reason": "not_stale",
                    "last_activity_at": "2026-05-18T10:30:00",
                    "eligible_after": "2026-05-19T10:30:00",
                }
            ],
            "failed": [],
        }
        get_runtime_client.return_value = runtime_client

        response = test_client.post(
            "/api/admin/runtime-cleanup/stale",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            json={
                "inactive_hours": 24,
                "targets": ["task_executors", "sandboxes"],
                "dry_run": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["inactive_hours"] == 24
    assert payload["results"]["task_executors"]["skipped"][0]["reason"] == "not_stale"
    assert payload["results"]["sandboxes"]["skipped"][0]["reason"] == "not_stale"
    job_service.cleanup_stale_task_executors.assert_called_once_with(
        db=ANY,
        inactive_hours=24,
        dry_run=False,
    )
    runtime_client.cleanup_stale_sandboxes.assert_awaited_once_with(
        inactive_hours=24,
        dry_run=False,
    )


def test_admin_runtime_cleanup_rejects_non_admin_user(
    test_client: TestClient, test_token: str
):
    response = test_client.post(
        "/api/admin/runtime-cleanup/stale",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"inactive_hours": 24},
    )

    assert response.status_code == 403
