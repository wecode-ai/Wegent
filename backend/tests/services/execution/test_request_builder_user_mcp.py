# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for user-scoped MCP injection in TaskRequestBuilder."""

from types import SimpleNamespace

from app.services.execution.request_builder import TaskRequestBuilder
from app.services.user_mcp_service import user_mcp_service


class TestUserScopedMcpInjection:
    """Tests for DingTalk Docs MCP injection."""

    def test_build_request_task_data_injects_decrypted_user_mcps(self):
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

        task_data = TaskRequestBuilder._build_request_task_data(user)

        assert task_data == {
            "user_mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": True,
                            "credentials": {
                                "url": "https://example.com/mcp?token=secret"
                            },
                        }
                    }
                }
            }
        }

    def test_build_request_task_data_filters_disabled_services(self):
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
        user = SimpleNamespace(
            preferences=user_mcp_service.dump_preferences(preferences)
        )

        task_data = TaskRequestBuilder._build_request_task_data(user)

        assert task_data == {
            "user_mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": True,
                            "credentials": {
                                "url": "https://example.com/mcp?token=secret"
                            },
                        }
                    }
                }
            }
        }

    def test_injects_service_skill_when_message_mentions_provider_and_service_missing(
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
                "name": "dingtalk-docs",
                "namespace": "default",
                "is_public": True,
            }
        ]

    def test_injects_all_provider_service_skills_for_generic_dingtalk_request(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        user = SimpleNamespace(preferences="{}")

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="帮我处理一下钉钉里的内容",
            preload_skills=[],
        )

        assert preload_skills == [
            {
                "name": "dingtalk-docs",
                "namespace": "default",
                "is_public": True,
            },
            {
                "name": "dingtalk-table",
                "namespace": "default",
                "is_public": True,
            },
            {
                "name": "dingtalk-ai-table",
                "namespace": "default",
                "is_public": True,
            },
        ]

    def test_injects_table_skill_when_message_mentions_dingtalk_sheet(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        user = SimpleNamespace(preferences="{}")

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="帮我看看钉钉表格里的工作表和单元格公式",
            preload_skills=[],
        )

        assert preload_skills == [
            {
                "name": "dingtalk-table",
                "namespace": "default",
                "is_public": True,
            }
        ]

    def test_injects_only_ai_table_skill_for_ai_table_request(self, test_db):
        builder = TaskRequestBuilder(test_db)
        user = SimpleNamespace(preferences="{}")

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="帮我更新钉钉AI表格里的记录和字段",
            preload_skills=[],
        )

        assert preload_skills == [
            {
                "name": "dingtalk-ai-table",
                "namespace": "default",
                "is_public": True,
            }
        ]

    def test_injects_runtime_skill_when_matching_service_is_ready(self, test_db):
        builder = TaskRequestBuilder(test_db)
        preferences = user_mcp_service.dump_preferences(
            user_mcp_service.set_provider_service_config(
                None,
                provider_id="dingtalk",
                service_id="docs",
                enabled=True,
                url="https://example.com/docs?token=secret",
            )
        )
        user = SimpleNamespace(preferences=preferences)

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="帮我看一下钉钉文档",
            preload_skills=[],
        )

        assert preload_skills == [
            {
                "name": "dingtalk-docs",
                "namespace": "default",
                "is_public": True,
            }
        ]

    def test_does_not_inject_other_service_when_target_service_matches(self, test_db):
        builder = TaskRequestBuilder(test_db)
        preferences = user_mcp_service.dump_preferences(
            user_mcp_service.set_provider_service_config(
                None,
                provider_id="dingtalk",
                service_id="docs",
                enabled=True,
                url="https://example.com/docs?token=secret",
            )
        )
        user = SimpleNamespace(preferences=preferences)

        preload_skills = builder._inject_conditional_provider_skills(
            user=user,
            message="总结一下我的钉钉文档",
            preload_skills=[],
        )

        assert preload_skills == [
            {
                "name": "dingtalk-docs",
                "namespace": "default",
                "is_public": True,
            }
        ]

    def test_build_skill_data_preserves_mcp_server_placeholders_when_service_ready(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        preferences = user_mcp_service.dump_preferences(
            user_mcp_service.set_provider_service_config(
                None,
                provider_id="dingtalk",
                service_id="docs",
                enabled=True,
                url="https://example.com/docs?token=secret",
            )
        )
        user = SimpleNamespace(preferences=preferences)
        skill = SimpleNamespace(
            id=101,
            user_id=0,
            json={
                "kind": "Skill",
                "metadata": {"name": "dingtalk-docs", "namespace": "default"},
                "spec": {
                    "description": "DingTalk docs runtime skill",
                    "bindShells": ["Chat"],
                    "mcpServers": {
                        "docs": {
                            "type": "streamable-http",
                            "url": "${{task_data.user_mcps.dingtalk.services.docs.credentials.url}}",
                        }
                    },
                },
            },
        )

        skill_data = builder._build_skill_data(skill, user=user)

        assert skill_data["mcpServers"] == {
            "docs": {
                "type": "streamable-http",
                "url": "${{task_data.user_mcps.dingtalk.services.docs.credentials.url}}",
            }
        }

    def test_build_skill_data_turns_runtime_skill_into_embedded_guide_when_service_missing(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        skill = SimpleNamespace(
            id=101,
            user_id=0,
            json={
                "kind": "Skill",
                "metadata": {"name": "dingtalk-docs", "namespace": "default"},
                "spec": {
                    "description": "DingTalk docs runtime skill",
                    "prompt": "Use DingTalk docs MCP.",
                    "bindShells": ["Chat"],
                    "mcpServers": {
                        "docs": {
                            "type": "streamable-http",
                            "url": "${{task_data.user_mcps.dingtalk.services.docs.credentials.url}}",
                        }
                    },
                },
            },
        )

        skill_data = builder._build_skill_data(
            skill, user=SimpleNamespace(preferences="{}")
        )

        assert "mcpServers" not in skill_data
        assert "Configuration Required" in skill_data["prompt"]
        assert "wegent://modal/mcp-provider-config?provider=dingtalk&service=docs" in (
            skill_data["prompt"]
        )

    def test_build_skill_data_does_not_rewrite_non_public_skill_named_like_runtime_skill(
        self, test_db
    ):
        builder = TaskRequestBuilder(test_db)
        skill = SimpleNamespace(
            id=301,
            user_id=7,
            json={
                "kind": "Skill",
                "metadata": {"name": "dingtalk-docs", "namespace": "workspace-team"},
                "spec": {
                    "description": "Custom skill",
                    "prompt": "Custom prompt.",
                    "bindShells": ["Chat"],
                    "mcpServers": {
                        "docs": {
                            "type": "streamable-http",
                            "url": "http://custom.example.com/mcp",
                        }
                    },
                },
            },
        )

        skill_data = builder._build_skill_data(
            skill, user=SimpleNamespace(preferences="{}")
        )

        assert skill_data["prompt"] == "Custom prompt."
        assert skill_data["mcpServers"] == {
            "docs": {
                "type": "streamable-http",
                "url": "http://custom.example.com/mcp",
            }
        }

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
        skill = SimpleNamespace(name="dingtalk-docs", user_id=0, namespace="default")

        mock_query = mocker.Mock()
        mock_query.filter.return_value.first.return_value = ghost
        mocker.patch.object(builder.db, "query", return_value=mock_query)
        find_skill_by_ref = mocker.patch.object(
            builder, "_find_skill_by_ref", return_value=skill
        )
        mocker.patch.object(
            builder,
            "_build_skill_data",
            return_value={"name": "dingtalk-docs"},
        )

        (
            skills,
            preload_skills,
            user_selected_skills,
            skill_refs,
        ) = builder._get_bot_skills(
            bot=bot,
            team=team,
            user=SimpleNamespace(preferences="{}"),
            user_id=2,
            user_preload_skills=[
                {
                    "name": "dingtalk-docs",
                    "namespace": "default",
                    "is_public": True,
                }
            ],
        )

        find_skill_by_ref.assert_called_once_with(
            "dingtalk-docs",
            "default",
            True,
            2,
            team_namespace="default",
        )
        assert skills == [{"name": "dingtalk-docs"}]
        assert preload_skills == ["dingtalk-docs"]
        assert user_selected_skills == ["dingtalk-docs"]
        assert skill_refs == {
            "dingtalk-docs": {
                "skill_id": None,
                "namespace": "default",
                "is_public": True,
            }
        }

    def test_get_bot_skills_returns_four_tuple_when_ghost_not_found(
        self, test_db, mocker
    ):
        builder = TaskRequestBuilder(test_db)
        team = SimpleNamespace(user_id=2, namespace="default")
        bot = SimpleNamespace(
            name="chat-bot",
            json={
                "kind": "Bot",
                "metadata": {"name": "chat-bot", "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": "missing-ghost", "namespace": "default"},
                    "shellRef": {"name": "Chat", "namespace": "default"},
                },
            },
        )
        mock_query = mocker.Mock()
        mock_query.filter.return_value.first.return_value = None
        mocker.patch.object(builder.db, "query", return_value=mock_query)

        result = builder._get_bot_skills(
            bot=bot,
            team=team,
            user=SimpleNamespace(preferences="{}"),
            user_id=2,
            user_preload_skills=None,
        )

        assert len(result) == 4
        assert result == ([], [], [], {})

    def test_resolve_shell_info_cache_isolated_by_shell_ref(self, test_db, mocker):
        builder = TaskRequestBuilder(test_db)

        bot_one = SimpleNamespace(
            json={
                "kind": "Bot",
                "metadata": {"name": "bot-one", "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": "ghost-a", "namespace": "default"},
                    "shellRef": {"name": "shell-a", "namespace": "default"},
                },
            }
        )
        bot_two = SimpleNamespace(
            json={
                "kind": "Bot",
                "metadata": {"name": "bot-two", "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": "ghost-b", "namespace": "default"},
                    "shellRef": {"name": "shell-b", "namespace": "default"},
                },
            }
        )

        shell_a = SimpleNamespace(
            json={
                "kind": "Shell",
                "metadata": {"name": "shell-a", "namespace": "default"},
                "spec": {"shellType": "ClaudeCode", "baseImage": "img-a"},
            }
        )
        shell_b = SimpleNamespace(
            json={
                "kind": "Shell",
                "metadata": {"name": "shell-b", "namespace": "default"},
                "spec": {"shellType": "Agno", "baseImage": "img-b"},
            }
        )

        mock_query = mocker.Mock()
        mock_query.filter.return_value.first.side_effect = [shell_a, shell_b]
        mocker.patch.object(builder.db, "query", return_value=mock_query)

        shell_info_one = builder._resolve_shell_info(bot_one, user_id=1)
        shell_info_two = builder._resolve_shell_info(bot_two, user_id=1)

        assert shell_info_one == {"shell_type": "ClaudeCode", "base_image": "img-a"}
        assert shell_info_two == {"shell_type": "Agno", "base_image": "img-b"}
