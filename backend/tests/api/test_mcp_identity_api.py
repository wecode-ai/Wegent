# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the public task-token userinfo endpoint."""

from fastapi.testclient import TestClient

from app.models.user import User
from app.services.auth import create_task_token


def test_get_mcp_identity_user_returns_task_user_info(
    test_client: TestClient,
    test_user: User,
) -> None:
    token = create_task_token(
        task_id=1,
        subtask_id=2,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == test_user.id
    assert body["user_name"] == test_user.user_name
    assert body["email"] == test_user.email
    assert "git_info" not in body
    assert "git_token" not in body


def test_get_mcp_identity_user_rejects_invalid_token(
    test_client: TestClient,
) -> None:
    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": "Bearer not-a-valid-token"},
    )

    assert response.status_code == 401


def test_get_mcp_identity_user_rejects_expired_token(
    test_client: TestClient,
    test_user: User,
) -> None:
    token = create_task_token(
        task_id=1,
        subtask_id=2,
        user_id=test_user.id,
        user_name=test_user.user_name,
        expires_delta_minutes=-1,
    )

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 401


def test_get_mcp_identity_user_rejects_missing_token(
    test_client: TestClient,
) -> None:
    response = test_client.get("/api/external/mcp-identity/userinfo")

    assert response.status_code == 401


def test_get_mcp_identity_user_returns_404_for_inactive_user(
    test_client: TestClient,
    test_user: User,
    test_db,
) -> None:
    test_user.is_active = False
    test_db.add(test_user)
    test_db.commit()

    token = create_task_token(
        task_id=1,
        subtask_id=2,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 404
