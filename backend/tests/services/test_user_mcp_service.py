# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for user-level MCP preference helpers."""

import json

import pytest

from app.services import mcp_provider_registry
from app.services.user_mcp_service import user_mcp_service
from shared.utils.crypto import is_data_encrypted


class TestUserMCPService:
    """Tests for user-scoped MCP preference storage."""

    @pytest.mark.parametrize(
        ("service_id", "server_name"),
        [
            ("docs", "dingtalk_docs"),
            ("table", "dingtalk_table"),
            ("ai_table", "dingtalk_ai_table"),
            ("wikispace", "dingtalk_wikispace"),
        ],
    )
    def test_all_dingtalk_services_support_url_and_oauth_modes(
        self,
        service_id: str,
        server_name: str,
    ):
        """Each DingTalk integration stores either credential form."""
        url_preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id=service_id,
            enabled=True,
            url=f"https://example.com/{service_id}?token=secret",
            auth_mode="url",
        )
        oauth_preferences = user_mcp_service.set_provider_service_config(
            url_preferences,
            provider_id="dingtalk",
            service_id=service_id,
            enabled=True,
            url=f"https://example.com/{service_id}/oauth",
            auth_mode="oauth",
        )

        url_config = user_mcp_service.get_provider_service_config(
            url_preferences, "dingtalk", service_id
        )
        oauth_config = user_mcp_service.get_provider_service_config(
            oauth_preferences, "dingtalk", service_id
        )
        server = user_mcp_service.get_enabled_mcp_server(
            oauth_preferences,
            "dingtalk",
            service_id,
        )

        assert url_config["auth_mode"] == "url"
        assert oauth_config["auth_mode"] == "oauth"
        assert server == {
            "name": server_name,
            "url": f"https://example.com/{service_id}/oauth",
            "type": "streamable-http",
        }

    def test_set_provider_service_config_encrypts_url(self):
        preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://example.com/mcp?token=secret",
        )

        stored_url = preferences["mcps"]["dingtalk"]["services"]["docs"]["credentials"][
            "url"
        ]
        assert stored_url != "https://example.com/mcp?token=secret"
        assert is_data_encrypted(stored_url) is True
        assert preferences["mcps"]["dingtalk"]["services"]["docs"]["enabled"] is True

    def test_get_provider_service_config_decrypts_url(self):
        preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://example.com/mcp?token=secret",
        )

        config = user_mcp_service.get_provider_service_config(
            json.dumps(preferences), "dingtalk", "docs"
        )

        assert config == {
            "enabled": True,
            "url": "https://example.com/mcp?token=secret",
            "auth_mode": "url",
            "oauth_connected": False,
            "oauth_expires_at": None,
            "oauth_account": None,
        }

    def test_get_decrypted_mcp_preferences_keeps_structure_and_decrypts_url(self):
        preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://example.com/mcp?token=secret",
        )

        decrypted = user_mcp_service.get_decrypted_mcp_preferences(
            json.dumps(preferences)
        )

        assert decrypted == {
            "dingtalk": {
                "services": {
                    "docs": {
                        "enabled": True,
                        "credentials": {"url": "https://example.com/mcp?token=secret"},
                    }
                }
            }
        }

    def test_get_enabled_decrypted_mcp_preferences_filters_disabled_services(self):
        preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://example.com/mcp?token=secret",
        )
        preferences = user_mcp_service.set_provider_service_config(
            preferences,
            provider_id="dingtalk",
            service_id="ai_table",
            enabled=False,
            url="https://example.com/table?token=secret",
        )

        decrypted = user_mcp_service.get_enabled_decrypted_mcp_preferences(
            json.dumps(preferences)
        )

        assert decrypted == {
            "dingtalk": {
                "services": {
                    "docs": {
                        "enabled": True,
                        "credentials": {"url": "https://example.com/mcp?token=secret"},
                    }
                }
            }
        }

    def test_get_enabled_decrypted_mcp_preferences_ignores_system_providers(
        self, monkeypatch
    ):
        monkeypatch.setitem(
            mcp_provider_registry.MCP_PROVIDER_REGISTRY,
            "demo",
            {
                "provider_id": "demo",
                "display_name": "示例知识",
                "configuration_mode": "system",
                "message_keywords": ("示例知识",),
                "services": {},
            },
        )
        preferences = {
            "mcps": {
                "demo": {
                    "services": {
                        "knowledge": {
                            "enabled": True,
                            "credentials": {"url": "https://example.com/demo-mcp"},
                        }
                    }
                }
            }
        }

        decrypted = user_mcp_service.get_enabled_decrypted_mcp_preferences(preferences)

        assert decrypted == {}

    def test_list_mcp_servers_returns_enabled_services_only(self):
        preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://example.com/mcp?token=secret",
        )

        servers = user_mcp_service.list_mcp_servers(preferences)

        assert servers == [
            {
                "name": "dingtalk_docs",
                "url": "https://example.com/mcp?token=secret",
                "type": "streamable-http",
            }
        ]

    def test_get_enabled_mcp_server_returns_none_when_service_not_ready(self):
        assert (
            user_mcp_service.get_enabled_mcp_server(
                None,
                "dingtalk",
                "docs",
            )
            is None
        )

    def test_get_enabled_mcp_server_returns_runtime_server_when_enabled(self):
        preferences = user_mcp_service.set_provider_service_config(
            None,
            provider_id="dingtalk",
            service_id="docs",
            enabled=True,
            url="https://example.com/mcp?token=secret",
        )

        server = user_mcp_service.get_enabled_mcp_server(
            preferences,
            "dingtalk",
            "docs",
        )

        assert server == {
            "name": "dingtalk_docs",
            "url": "https://example.com/mcp?token=secret",
            "type": "streamable-http",
        }

    def test_system_managed_provider_rejects_user_scoped_configuration(
        self, monkeypatch
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
        with pytest.raises(ValueError, match="Unsupported MCP provider service"):
            user_mcp_service.set_provider_service_config(
                None,
                provider_id="demo",
                service_id="knowledge",
                enabled=True,
                url="https://example.com/demo-mcp?token=user-scoped",
            )

        assert (
            user_mcp_service.get_enabled_mcp_server(
                None,
                "demo",
                "knowledge",
            )
            is None
        )
