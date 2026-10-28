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
from app.api.endpoints import user_mcp_oauth
from app.api.endpoints.users import router
from app.core import security
from app.models.user import User
from app.services import mcp_provider_registry
from shared.utils.crypto import is_data_encrypted


@pytest.fixture
def test_db(mcp_test_db: Session) -> Session:
    return mcp_test_db


@pytest.fixture
def user_mcps_client(test_db: Session, test_user: User) -> TestClient:
    """Create a focused test client for user MCP endpoints."""

    app = FastAPI()
    app.include_router(router, prefix="/api/users")
    app.include_router(user_mcp_oauth.router, prefix="/api")
    app.include_router(user_mcp_oauth.public_router, prefix="/api")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user

    return TestClient(app)


def _dingtalk_service(service_id: str, server_name: str, mcp_id: int) -> dict:
    """Build the expected DingTalk provider service payload."""
    return {
        "provider_id": "dingtalk",
        "service_id": service_id,
        "server_name": server_name,
        "detail_url": f"https://mcp.dingtalk.com/#/detail?mcpId={mcp_id}",
        "enabled": False,
        "url": "",
        "auth_mode": "url",
        "oauth_supported": True,
        "oauth_connected": False,
        "oauth_expires_at": None,
        "oauth_account": None,
    }


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
            "auth_mode": "url",
            "oauth_supported": True,
            "oauth_connected": False,
            "oauth_expires_at": None,
            "oauth_account": None,
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
            "auth_mode": "url",
            "oauth_supported": True,
            "oauth_connected": False,
            "oauth_expires_at": None,
            "oauth_account": None,
        }

    @pytest.mark.parametrize(
        ("service_id", "server_name"),
        [
            ("docs", "dingtalk_docs"),
            ("ai_table", "dingtalk_ai_table"),
            ("wikispace", "dingtalk_wikispace"),
        ],
    )
    def test_user_configurable_dingtalk_services_accept_url_and_oauth_modes(
        self,
        user_mcps_client: TestClient,
        service_id: str,
        server_name: str,
    ):
        """Docs, AI Table, and Knowledge Base offer API-key and OAuth settings."""
        response = user_mcps_client.put(
            f"/api/users/me/mcps/providers/dingtalk/services/{service_id}",
            json={
                "enabled": True,
                "url": f"https://example.com/{service_id}/oauth",
                "auth_mode": "oauth",
            },
        )

        assert response.status_code == 200
        assert response.json()["auth_mode"] == "oauth"
        assert response.json()["server_name"] == server_name

    def test_enable_provider_service_without_url_fails(
        self, user_mcps_client: TestClient
    ):
        response = user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            json={"enabled": True, "url": ""},
        )

        assert response.status_code == 400
        assert "url is required" in response.json()["detail"]

    def test_create_oauth_session_requires_resource_url(
        self, user_mcps_client: TestClient
    ):
        """OAuth cannot start before the MCP resource URL is saved."""
        response = user_mcps_client.post(
            "/api/users/me/mcps/providers/dingtalk/services/ai_table/oauth/sessions",
        )

        assert response.status_code == 400
        assert "OAuth server URL" in response.json()["detail"]

    def test_rejects_unknown_auth_mode(self, user_mcps_client: TestClient):
        """An unknown authentication mode is rejected as a client error."""
        response = user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/docs",
            json={
                "enabled": True,
                "url": "https://mcp-gw.dingtalk.com/oauth/server/docs",
                "auth_mode": "bogus",
            },
        )

        assert response.status_code == 422

    def test_oauth_session_rejects_service_without_oauth_support(
        self, user_mcps_client: TestClient, monkeypatch
    ):
        """Services that do not declare OAuth support are rejected."""
        monkeypatch.setitem(
            mcp_provider_registry.MCP_PROVIDER_REGISTRY,
            "demo",
            {
                "provider_id": "demo",
                "display_name": "示例 MCP",
                "configuration_mode": "user",
                "message_keywords": ("示例",),
                "services": {
                    "plain": {
                        "service_id": "plain",
                        "server_name": "demo_plain",
                        "detail_url": "https://example.com/plain",
                        "skill_name": None,
                        "display_name": "普通服务",
                        "message_keywords": ("普通",),
                        "oauth_supported": False,
                    }
                },
            },
        )

        response = user_mcps_client.post(
            "/api/users/me/mcps/providers/demo/services/plain/oauth/sessions",
        )

        assert response.status_code == 400
        assert "does not support OAuth" in response.json()["detail"]

    def test_disconnect_oauth_clears_stored_credentials(
        self,
        user_mcps_client: TestClient,
        test_db: Session,
        test_user: User,
    ):
        """Disconnect drops stored tokens without disabling the service."""
        user_mcps_client.put(
            "/api/users/me/mcps/providers/dingtalk/services/ai_table",
            json={
                "enabled": True,
                "url": "https://mcp-gw.dingtalk.com/oauth/server/aitable",
                "auth_mode": "oauth",
            },
        )

        response = user_mcps_client.delete(
            "/api/users/me/mcps/providers/dingtalk/services/ai_table/oauth/connection",
        )

        assert response.status_code == 204
        test_db.refresh(test_user)
        config = user_mcps_client.get(
            "/api/users/me/mcps/providers/dingtalk/services/ai_table",
        ).json()
        assert config["auth_mode"] == "oauth"
        assert config["oauth_connected"] is False

    def test_system_managed_provider_is_not_user_configurable(
        self,
        user_mcps_client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setitem(
            mcp_provider_registry.MCP_PROVIDER_REGISTRY,
            "demo",
            {
                "provider_id": "demo",
                "display_name": "示例知识",
                "configuration_mode": "system",
                "message_keywords": ("示例知识",),
                "services": {
                    "knowledge": {
                        "service_id": "knowledge",
                        "server_name": "demo_knowledge",
                        "detail_url": "https://example.com/knowledge",
                        "skill_name": "demo-knowledge",
                        "display_name": "示例知识库",
                        "message_keywords": ("知识库",),
                    }
                },
            },
        )
        list_response = user_mcps_client.get(
            "/api/users/me/mcps/providers/demo/services",
        )
        update_response = user_mcps_client.put(
            "/api/users/me/mcps/providers/demo/services/knowledge",
            json={"enabled": True, "url": "https://example.com/demo-mcp"},
        )

        assert list_response.status_code == 404
        assert update_response.status_code == 404
