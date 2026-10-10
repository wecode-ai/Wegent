# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the simplified-OAuth MCP token endpoints."""

from fastapi.testclient import TestClient

from app.core.config import settings
from app.models.user import User
from app.services.auth import (
    MCP_SCOPE_USERINFO,
    MCP_TOKEN_AUDIENCE,
    create_mcp_token,
    create_task_token,
)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _issue_token(test_client: TestClient, credential: str) -> str:
    response = test_client.post(
        "/api/external/mcp/token",
        headers=_auth(credential),
        json={"scope": MCP_SCOPE_USERINFO},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


class TestIssueMcpToken:
    """Tests for POST /api/external/mcp/token."""

    def test_user_session_credential_is_exchanged_for_a_token(
        self, test_client: TestClient, test_token: str
    ) -> None:
        response = test_client.post(
            "/api/external/mcp/token",
            headers=_auth(test_token),
            json={"scope": MCP_SCOPE_USERINFO},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["token_type"] == "Bearer"
        assert body["scope"] == MCP_SCOPE_USERINFO
        assert body["expires_in"] == settings.MCP_TOKEN_EXPIRE_MINUTES * 60
        assert body["access_token"]

    def test_task_token_credential_is_exchanged_for_a_token(
        self, test_client: TestClient, test_user: User
    ) -> None:
        task_token = create_task_token(
            task_id=1,
            subtask_id=2,
            user_id=test_user.id,
            user_name=test_user.user_name,
        )

        access_token = _issue_token(test_client, task_token)

        assert access_token

    def test_authentication_is_required(self, test_client: TestClient) -> None:
        response = test_client.post(
            "/api/external/mcp/token",
            json={"scope": MCP_SCOPE_USERINFO},
        )

        assert response.status_code == 401

    def test_unknown_scope_is_rejected(
        self, test_client: TestClient, test_token: str
    ) -> None:
        response = test_client.post(
            "/api/external/mcp/token",
            headers=_auth(test_token),
            json={"scope": "mcp:admin.everything"},
        )

        assert response.status_code == 400


class TestIntrospectMcpToken:
    """Tests for POST /api/external/mcp/introspect."""

    def test_active_token_reports_its_claims(self, test_client: TestClient) -> None:
        token = create_mcp_token(user_id=9, user_name="alice", task_id=11)

        response = test_client.post(
            "/api/external/mcp/introspect",
            data={"token": token},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["active"] is True
        assert body["scope"] == MCP_SCOPE_USERINFO
        assert body["sub"] == "alice"
        assert body["user_id"] == 9
        assert body["aud"] == MCP_TOKEN_AUDIENCE
        assert body["task_id"] == 11
        assert body["exp"] > body["iat"]

    def test_invalid_token_is_inactive(self, test_client: TestClient) -> None:
        response = test_client.post(
            "/api/external/mcp/introspect",
            data={"token": "not-a-token"},
        )

        assert response.status_code == 200, response.text
        assert response.json() == {"active": False}

    def test_expired_token_is_inactive(self, test_client: TestClient) -> None:
        token = create_mcp_token(user_id=9, user_name="alice", expires_delta_minutes=-1)

        response = test_client.post(
            "/api/external/mcp/introspect",
            data={"token": token},
        )

        assert response.status_code == 200, response.text
        assert response.json()["active"] is False


class TestMcpTokenUserinfo:
    """Tests for GET /api/external/mcp/userinfo."""

    def test_returns_the_user_behind_an_issued_token(
        self, test_client: TestClient, test_token: str, test_user: User
    ) -> None:
        access_token = _issue_token(test_client, test_token)

        response = test_client.get(
            "/api/external/mcp/userinfo",
            headers=_auth(access_token),
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["id"] == test_user.id
        assert body["user_name"] == test_user.user_name
        assert body["email"] == test_user.email
        assert body["scope"] == MCP_SCOPE_USERINFO
        assert "git_info" not in body
        assert "git_token" not in body

    def test_task_token_is_not_an_mcp_token(
        self, test_client: TestClient, test_user: User
    ) -> None:
        task_token = create_task_token(
            task_id=1,
            subtask_id=2,
            user_id=test_user.id,
            user_name=test_user.user_name,
        )

        response = test_client.get(
            "/api/external/mcp/userinfo",
            headers=_auth(task_token),
        )

        assert response.status_code == 401

    def test_invalid_token_is_rejected(self, test_client: TestClient) -> None:
        response = test_client.get(
            "/api/external/mcp/userinfo",
            headers=_auth("not-a-token"),
        )

        assert response.status_code == 401
