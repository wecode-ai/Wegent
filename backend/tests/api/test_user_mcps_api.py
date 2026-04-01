# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for user-scoped MCP settings."""

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.security import create_access_token
from app.models.user import User
from shared.utils.crypto import is_data_encrypted


@pytest.fixture
def user_mcps_client(
    test_db: Session, test_user: User, test_client: TestClient
) -> TestClient:
    """Create a test client with authentication for user MCP endpoints.

    Uses the existing test_client fixture which already has proper db override,
    and adds authentication via JWT token.
    """
    return test_client


@pytest.fixture
def auth_headers(test_user: User) -> dict:
    """Create authentication headers for the test user."""
    token = create_access_token(data={"sub": test_user.user_name})
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.api
class TestUserMcpsAPI:
    """Tests for user MCP configuration endpoints."""

    def test_update_and_get_provider_service_config(
        self,
        user_mcps_client: TestClient,
        auth_headers: dict,
        test_db: Session,
        test_user: User,
    ):
        response = user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            json={
                "enabled": True,
                "url": "https://example.com/mcp?token=secret",
            },
            headers=auth_headers,
        )

        assert response.status_code == 200
        assert response.json() == {
            "provider_id": "dingtalk",
            "service_id": "docs",
            "server_name": "dingtalk_docs",
            "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9629",
            "enabled": True,
            "url": "https://example.com/mcp?token=secret",
        }

        test_db.refresh(test_user)
        preferences = json.loads(test_user.preferences)
        stored_url = preferences["mcps"]["dingtalk"]["services"]["docs"]["credentials"][
            "url"
        ]
        assert is_data_encrypted(stored_url) is True

        get_response = user_mcps_client.get(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            headers=auth_headers,
        )

        assert get_response.status_code == 200
        assert get_response.json() == {
            "provider_id": "dingtalk",
            "service_id": "docs",
            "server_name": "dingtalk_docs",
            "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9629",
            "enabled": True,
            "url": "https://example.com/mcp?token=secret",
        }

    def test_list_provider_services_returns_registry_and_config(
        self, user_mcps_client: TestClient, auth_headers: dict
    ):
        response = user_mcps_client.get(
            "/api/users/me/mcps/providers/dingtalk/services",
            headers=auth_headers,
        )

        assert response.status_code == 200
        assert response.json() == [
            {
                "provider_id": "dingtalk",
                "service_id": "docs",
                "server_name": "dingtalk_docs",
                "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9629",
                "enabled": False,
                "url": "",
            },
            {
                "provider_id": "dingtalk",
                "service_id": "table",
                "server_name": "dingtalk_table",
                "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9704",
                "enabled": False,
                "url": "",
            },
            {
                "provider_id": "dingtalk",
                "service_id": "ai_table",
                "server_name": "dingtalk_ai_table",
                "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9555",
                "enabled": False,
                "url": "",
            },
        ]

    def test_enable_provider_service_without_url_fails(
        self, user_mcps_client: TestClient, auth_headers: dict
    ):
        response = user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            json={"enabled": True, "url": ""},
            headers=auth_headers,
        )

        assert response.status_code == 400
        assert "url is required" in response.json()["detail"]
