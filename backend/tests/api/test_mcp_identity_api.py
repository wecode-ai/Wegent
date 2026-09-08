# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.auth import (
    create_mcp_identity_token,
    create_skill_identity_token,
)


def _mcp_identity_token(
    user_id: int,
    user_name: str,
) -> str:
    """Create an MCP identity token for tests."""
    return create_mcp_identity_token(
        user_id=user_id,
        user_name=user_name,
        server_name="business-server",
    )


def _skill_identity_token(user_id: int, user_name: str) -> str:
    """Create a Skill identity token (wrong token type) for tests."""
    return create_skill_identity_token(
        user_id=user_id,
        user_name=user_name,
        runtime_type="executor",
        runtime_name="business-server",
    )


def test_get_mcp_identity_user_returns_basic_info(
    test_client,
    test_user,
) -> None:
    token = _mcp_identity_token(test_user.id, test_user.user_name)

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": test_user.id,
        "user_name": test_user.user_name,
        "email": test_user.email,
    }


def test_get_mcp_identity_user_accepts_x_wegent_token_header(
    test_client,
    test_user,
) -> None:
    token = _mcp_identity_token(test_user.id, test_user.user_name)

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"X-Wegent-Token": token},
    )

    assert response.status_code == 200
    assert response.json()["user_name"] == test_user.user_name


def test_get_mcp_identity_user_never_exposes_git_credentials(
    test_client,
    test_user,
) -> None:
    token = _mcp_identity_token(test_user.id, test_user.user_name)

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )

    payload = response.json()
    assert "git_info" not in payload
    assert "git_token" not in payload


def test_get_mcp_identity_user_rejects_missing_token(test_client) -> None:
    response = test_client.get("/api/external/mcp-identity/userinfo")

    assert response.status_code == 401


def test_get_mcp_identity_user_rejects_invalid_token(test_client) -> None:
    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": "Bearer not-a-valid-jwt"},
    )

    assert response.status_code == 401


def test_get_mcp_identity_user_rejects_non_mcp_token_type(
    test_client,
    test_user,
) -> None:
    token = _skill_identity_token(test_user.id, test_user.user_name)

    response = test_client.get(
        "/api/external/mcp-identity/userinfo",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 401
