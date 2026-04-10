# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.models.user import User


def test_cleanup_executor_success(
    test_client: TestClient, test_token: str, test_user: User
):
    with patch(
        "app.api.endpoints.adapter.tasks.job_service", create=True
    ) as job_service:
        job_service.cleanup_task_executor.return_value = {
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

        response = test_client.post(
            "/api/tasks/123/cleanup-executor",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 200
    assert response.json()["reason"] == "executor_deleted"
    job_service.cleanup_task_executor.assert_called_once_with(
        db=ANY,
        task_id=123,
        user_id=test_user.id,
    )


def test_cleanup_executor_skipped_result(
    test_client: TestClient, test_token: str, test_user: User
):
    with patch(
        "app.api.endpoints.adapter.tasks.job_service", create=True
    ) as job_service:
        job_service.cleanup_task_executor.return_value = {
            "task_id": 123,
            "deleted": False,
            "skipped": True,
            "reason": "preserve_executor",
            "executors": [],
        }

        response = test_client.post(
            "/api/tasks/123/cleanup-executor",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 200
    assert response.json()["skipped"] is True
    assert response.json()["reason"] == "preserve_executor"
    job_service.cleanup_task_executor.assert_called_once_with(
        db=ANY,
        task_id=123,
        user_id=test_user.id,
    )


def test_cleanup_executor_returns_404_from_service(
    test_client: TestClient, test_token: str, test_user: User
):
    with patch(
        "app.api.endpoints.adapter.tasks.job_service", create=True
    ) as job_service:
        job_service.cleanup_task_executor.side_effect = HTTPException(
            status_code=404, detail="Task not found or no permission"
        )

        response = test_client.post(
            "/api/tasks/999/cleanup-executor",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 404
    job_service.cleanup_task_executor.assert_called_once_with(
        db=ANY,
        task_id=999,
        user_id=test_user.id,
    )
