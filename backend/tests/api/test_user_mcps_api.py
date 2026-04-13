# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for user-scoped MCP settings."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.users import router
from app.core import security
from app.models.user import User
from shared.utils.crypto import is_data_encrypted


@pytest.fixture
def user_mcps_client(test_db: Session, test_user: User) -> TestClient:
    """Create a focused test client for user MCP endpoints."""

    app = FastAPI()
    app.include_router(router, prefix="/api/users")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user

    return TestClient(app)


@pytest.mark.api
class TestUserMcpsAPI:
    """Tests for user MCP configuration endpoints."""

    def test_update_and_get_provider_service_config(
        self,
        user_mcps_client: TestClient,
        test_db: Session,
        test_user: User,
    ):
        response = user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            json={
                "enabled": True,
                "url": "https://example.com/mcp?token=secret",
            },
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
        self, user_mcps_client: TestClient
    ):
        response = user_mcps_client.get(
            "/api/users/me/mcps/providers/dingtalk/services"
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
        self, user_mcps_client: TestClient
    ):
        response = user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            json={"enabled": True, "url": ""},
        )

        assert response.status_code == 400
        assert "url is required" in response.json()["detail"]
