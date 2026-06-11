# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.models.user import User


def test_get_subtask_file_changes_diff_requires_authentication(
    test_client: TestClient,
):
    response = test_client.get("/api/subtasks/123/file-changes/diff")

    assert response.status_code == 401


def test_get_subtask_file_changes_diff_delegates_to_service(
    test_client: TestClient,
    test_token: str,
    test_user: User,
):
    with patch(
        "app.api.endpoints.subtasks.turn_file_changes_service.get_diff",
        AsyncMock(
            return_value={
                "subtask_id": 123,
                "diff": "diff --git a/a.txt b/a.txt\n",
            }
        ),
    ) as get_diff:
        response = test_client.get(
            "/api/subtasks/123/file-changes/diff",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 200
    assert response.json()["subtask_id"] == 123
    get_diff.assert_awaited_once()
    assert get_diff.await_args.kwargs["user_id"] == test_user.id


def test_revert_subtask_file_changes_delegates_without_request_body(
    test_client: TestClient,
    test_token: str,
    test_user: User,
):
    summary = {
        "version": 1,
        "status": "reverted",
        "artifact_id": "turn-file-changes/10/20",
        "device_id": "device-1",
        "workspace_path": "/workspace/project",
        "file_count": 1,
        "additions": 1,
        "deletions": 0,
        "files": [
            {
                "old_path": None,
                "path": "a.txt",
                "change_type": "created",
                "additions": 1,
                "deletions": 0,
                "binary": False,
            }
        ],
        "reverted_at": "2026-06-11T00:00:00Z",
    }
    with patch(
        "app.api.endpoints.subtasks.turn_file_changes_service.revert",
        AsyncMock(
            return_value={
                "subtask_id": 123,
                "file_changes": summary,
            }
        ),
    ) as revert:
        response = test_client.post(
            "/api/subtasks/123/file-changes/revert",
            headers={"Authorization": f"Bearer {test_token}"},
        )

    assert response.status_code == 200
    assert response.json()["file_changes"]["status"] == "reverted"
    revert.assert_awaited_once()
    assert revert.await_args.kwargs["user_id"] == test_user.id
