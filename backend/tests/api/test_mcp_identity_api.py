# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the public task-token userinfo endpoint."""

from unittest.mock import Mock

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.api.endpoints import mcp_identity
from app.core.rate_limit import ExternalMcpRateLimitStatus
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


def test_get_mcp_identity_user_rejects_when_rate_limited(
    test_client: TestClient,
    test_user: User,
    monkeypatch: MonkeyPatch,
) -> None:
    """Return a retryable response when the identity rate limit is exceeded."""
    monkeypatch.setattr(
        mcp_identity,
        "check_external_mcp_rate_limit",
        lambda *args, **kwargs: ExternalMcpRateLimitStatus.LIMITED,
    )
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

    assert response.status_code == 429


def test_get_mcp_identity_user_fails_open_when_limiter_unavailable(
    test_client: TestClient,
    test_user: User,
    monkeypatch: MonkeyPatch,
) -> None:
    """An unreachable limiter must not turn a valid token into a failure."""
    monkeypatch.setattr(
        mcp_identity,
        "check_external_mcp_rate_limit",
        lambda *args, **kwargs: ExternalMcpRateLimitStatus.UNAVAILABLE,
    )
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
    assert response.json()["id"] == test_user.id


def test_get_mcp_identity_user_respects_global_rate_limit_switch(
    test_client: TestClient,
    test_user: User,
    monkeypatch: MonkeyPatch,
) -> None:
    """Skip the custom Redis check when global rate limiting is disabled."""
    check_rate_limit = Mock(
        return_value=ExternalMcpRateLimitStatus.LIMITED,
    )
    monkeypatch.setattr(
        mcp_identity,
        "check_external_mcp_rate_limit",
        check_rate_limit,
    )
    monkeypatch.setattr(mcp_identity.settings, "RATE_LIMIT_ENABLED", False)
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
    check_rate_limit.assert_not_called()
