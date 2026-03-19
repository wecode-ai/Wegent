# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for user-scoped MCP injection in TaskRequestBuilder."""

from types import SimpleNamespace

from app.services.execution.request_builder import TaskRequestBuilder
from app.services.user_mcp_service import user_mcp_service


class TestUserScopedMcpInjection:
    """Tests for DingTalk Docs MCP injection."""

    def test_load_user_mcp_servers_returns_provider_server_when_enabled(self):
        preferences = user_mcp_service.dump_preferences(
            user_mcp_service.set_provider_service_config(
                None,
                provider_id="dingtalk",
                service_id="docs",
                enabled=True,
                url="https://example.com/mcp?token=secret",
            )
        )
        user = SimpleNamespace(preferences=preferences)

        servers = TaskRequestBuilder._load_user_mcp_servers(user)

        assert servers == [
            {
                "name": "dingtalk_docs",
                "url": "https://example.com/mcp?token=secret",
                "type": "streamable-http",
            }
        ]

    def test_merge_user_mcp_into_bot_config_only_updates_supported_shells(self):
        bot_config_list = [
            {"shell_type": "ClaudeCode", "mcp_servers": []},
            {"shell_type": "Chat", "mcp_servers": []},
        ]
        user_mcp_servers = [
            {
                "name": "dingtalk_docs",
                "url": "https://example.com/mcp?token=secret",
                "type": "streamable-http",
            }
        ]

        TaskRequestBuilder._merge_user_mcp_into_bot_config(
            bot_config_list, user_mcp_servers
        )

        assert bot_config_list[0]["mcp_servers"] == user_mcp_servers
        assert bot_config_list[1]["mcp_servers"] == []

    def test_injects_provider_config_skill_when_message_mentions_provider_and_service_missing(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        user = SimpleNamespace(preferences="{}")

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="看看我的钉钉文档",
            preload_skills=[],
        )

        assert preload_skills == [
            {
                "name": "dingtalk-config-guide",
                "namespace": "default",
                "is_public": True,
            }
        ]

    def test_skips_provider_config_skill_when_all_registered_services_are_ready(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        preferences = user_mcp_service.dump_preferences(
            user_mcp_service.set_provider_service_config(
                user_mcp_service.set_provider_service_config(
                    None,
                    provider_id="dingtalk",
                    service_id="docs",
                    enabled=True,
                    url="https://example.com/docs?token=secret",
                ),
                provider_id="dingtalk",
                service_id="ai_table",
                enabled=True,
                url="https://example.com/ai-table?token=secret",
            )
        )
        user = SimpleNamespace(preferences=preferences)

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="帮我看一下钉钉表格",
            preload_skills=[],
        )

        assert preload_skills == []

    def test_get_bot_skills_resolves_public_user_preload_skill(self, test_db, mocker):
        builder = TaskRequestBuilder(test_db)
        team = SimpleNamespace(user_id=2, namespace="default")
        bot = SimpleNamespace(
            name="chat-bot",
            json={
                "kind": "Bot",
                "metadata": {"name": "chat-bot", "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": "chat-ghost", "namespace": "default"},
                    "shellRef": {"name": "Chat", "namespace": "default"},
                },
            },
        )
        ghost = SimpleNamespace(
            name="chat-ghost",
            json={
                "kind": "Ghost",
                "metadata": {"name": "chat-ghost", "namespace": "default"},
                "spec": {
                    "systemPrompt": "You are a helpful assistant.",
                    "skills": [],
                    "preload_skills": [],
                },
            },
        )
        skill = SimpleNamespace(
            name="dingtalk-config-guide", user_id=0, namespace="default"
        )

        mock_query = mocker.Mock()
        mock_query.filter.return_value.first.return_value = ghost
        mocker.patch.object(builder.db, "query", return_value=mock_query)
        find_skill_by_ref = mocker.patch.object(
            builder, "_find_skill_by_ref", return_value=skill
        )
        mocker.patch.object(
            builder,
            "_build_skill_data",
            return_value={"name": "dingtalk-config-guide"},
        )

        skills, preload_skills, user_selected_skills = builder._get_bot_skills(
            bot=bot,
            team=team,
            user_id=2,
            user_preload_skills=[
                {
                    "name": "dingtalk-config-guide",
                    "namespace": "default",
                    "is_public": True,
                }
            ],
        )

        find_skill_by_ref.assert_called_once_with(
            "dingtalk-config-guide",
            "default",
            True,
            2,
            team_namespace="default",
        )
        assert skills == [{"name": "dingtalk-config-guide"}]
        assert preload_skills == ["dingtalk-config-guide"]
        assert user_selected_skills == ["dingtalk-config-guide"]
