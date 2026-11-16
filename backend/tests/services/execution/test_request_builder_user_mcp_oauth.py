# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OAuth provider skills carry credentials or report explicit configuration errors."""

from types import SimpleNamespace

import pytest

from app.services.execution.request_builder import TaskRequestBuilder
from app.services.user_mcp_oauth import user_mcp_oauth_service
from app.services.user_mcp_service import (
    MCP_AUTH_MODE_OAUTH,
    MCP_AUTH_MODE_URL,
    user_mcp_service,
)


class TestUserMcpOAuthHeaderInjection:
    """Tests for OAuth bearer injection into provider MCP servers."""

    RESOURCE_URL = "https://mcp-gw.dingtalk.com/oauth/server/aitable"

    def _skill(self, server_name: str = "dingtalk_ai_table") -> SimpleNamespace:
        return SimpleNamespace(
            id=201,
            user_id=0,
            json={
                "kind": "Skill",
                "metadata": {"name": "dingtalk-ai-table", "namespace": "default"},
                "spec": {
                    "description": "DingTalk AI table runtime skill",
                    "prompt": "Use DingTalk AI tables.",
                    "bindShells": ["Chat"],
                    "mcpServers": {
                        server_name: {
                            "type": "streamable-http",
                            "url": (
                                "${{task_data.user_mcps.dingtalk.services.ai_table"
                                ".credentials.url}}"
                            ),
                        }
                    },
                },
            },
        )

    def _user(self, auth_mode: str) -> SimpleNamespace:
        preferences = user_mcp_service.dump_preferences(
            user_mcp_service.set_provider_service_config(
                None,
                provider_id="dingtalk",
                service_id="ai_table",
                enabled=True,
                url=self.RESOURCE_URL,
                auth_mode=auth_mode,
            )
        )
        return SimpleNamespace(preferences=preferences, id=1)

    def test_oauth_mode_injects_bearer_header(self, test_db, monkeypatch):
        builder = TaskRequestBuilder(test_db)
        monkeypatch.setattr(
            user_mcp_oauth_service,
            "ensure_access_token_sync",
            lambda *args, **kwargs: "dingtalk-access",
        )

        skill_data = builder._build_skill_data(
            self._skill(), user=self._user(MCP_AUTH_MODE_OAUTH)
        )

        assert skill_data["mcpServers"]["dingtalk_ai_table"]["headers"] == {
            "Authorization": "Bearer dingtalk-access"
        }

    @pytest.mark.parametrize("status_code", [409, 503])
    def test_oauth_conflict_is_not_downgraded_to_an_unauthenticated_skill(
        self, test_db, monkeypatch, status_code
    ):
        from app.services.user_mcp_service import MCPPreferencesError

        builder = TaskRequestBuilder(test_db)

        def conflict(*args, **kwargs):
            raise MCPPreferencesError(
                "MCP configuration changed; please retry", status_code
            )

        monkeypatch.setattr(
            user_mcp_oauth_service, "ensure_access_token_sync", conflict
        )

        with pytest.raises(MCPPreferencesError) as error:
            builder._build_skill_data(
                self._skill(), user=self._user(MCP_AUTH_MODE_OAUTH)
            )

        assert error.value.status_code == status_code
        assert "retry" in error.value.detail

    def test_oauth_mode_supports_legacy_hyphenated_server_name(
        self, test_db, monkeypatch
    ):
        """Deployed Skill assets may still use hyphenated server names."""
        builder = TaskRequestBuilder(test_db)
        monkeypatch.setattr(
            user_mcp_oauth_service,
            "ensure_access_token_sync",
            lambda *args, **kwargs: "dingtalk-access",
        )

        skill_data = builder._build_skill_data(
            self._skill("dingtalk-ai-table"),
            user=self._user(MCP_AUTH_MODE_OAUTH),
        )

        assert skill_data["mcpServers"]["dingtalk-ai-table"]["headers"] == {
            "Authorization": "Bearer dingtalk-access"
        }

    def test_url_mode_keeps_no_authorization_header(self, test_db, monkeypatch):
        builder = TaskRequestBuilder(test_db)

        def fail(*args, **kwargs):
            raise AssertionError("URL mode must not refresh OAuth tokens")

        monkeypatch.setattr(user_mcp_oauth_service, "ensure_access_token_sync", fail)

        skill_data = builder._build_skill_data(
            self._skill(), user=self._user(MCP_AUTH_MODE_URL)
        )

        assert "headers" not in skill_data["mcpServers"]["dingtalk_ai_table"]

    def test_insecure_resource_url_never_receives_a_bearer_header(
        self, test_db, monkeypatch
    ):
        """An OAuth token is not attached to a cleartext MCP endpoint."""
        builder = TaskRequestBuilder(test_db)
        user = self._user(MCP_AUTH_MODE_OAUTH)
        preferences = user_mcp_service.set_provider_service_config(
            user.preferences,
            provider_id="dingtalk",
            service_id="ai_table",
            enabled=True,
            url="http://mcp.example.com/oauth/server/aitable",
            auth_mode=MCP_AUTH_MODE_OAUTH,
        )
        user = SimpleNamespace(
            preferences=user_mcp_service.dump_preferences(preferences), id=1
        )

        def fail(*args, **kwargs):
            raise AssertionError("insecure transports must not request a token")

        monkeypatch.setattr(user_mcp_oauth_service, "ensure_access_token_sync", fail)

        skill_data = builder._build_skill_data(self._skill(), user=user)

        assert "headers" not in skill_data["mcpServers"]["dingtalk_ai_table"]
