# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Claude Code MCP processing in TaskRequestBuilder.

Verifies that skill MCP extraction, type normalization, and reachability
filtering work correctly when preparing MCP servers for Claude Code executor.
"""

from types import SimpleNamespace
from unittest.mock import patch

from app.services.execution.request_builder import TaskRequestBuilder
from shared.models.execution import ExecutionRequest


class TestExtractSkillMcpToList:
    """Tests for _extract_skill_mcp_to_list static method."""

    def test_empty_skill_configs(self):
        result = TaskRequestBuilder._extract_skill_mcp_to_list([])
        assert result == []

    def test_skill_without_mcp_servers(self):
        configs = [{"name": "code-review", "description": "Reviews code"}]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)
        assert result == []

    def test_single_skill_single_mcp(self):
        configs = [
            {
                "name": "image-toolkit",
                "mcpServers": {
                    "imageFetchServer": {
                        "type": "streamable-http",
                        "url": "http://mcp.example.com/fetch-image",
                        "headers": {"Authorization": "Bearer token123"},
                    }
                },
            }
        ]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)

        assert len(result) == 1
        assert result[0]["name"] == "image-toolkit_imageFetchServer"
        assert result[0]["type"] == "streamable-http"
        assert result[0]["url"] == "http://mcp.example.com/fetch-image"
        assert result[0]["headers"]["Authorization"] == "Bearer token123"

    def test_single_skill_multiple_mcps(self):
        configs = [
            {
                "name": "image-toolkit",
                "mcpServers": {
                    "imageFetchServer": {
                        "type": "streamable-http",
                        "url": "http://mcp.example.com/fetch-image",
                    },
                    "nanoBananaServer": {
                        "type": "streamable-http",
                        "url": "http://mcp.example.com/nano-banana",
                    },
                },
            }
        ]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)

        assert len(result) == 2
        names = [s["name"] for s in result]
        assert "image-toolkit_imageFetchServer" in names
        assert "image-toolkit_nanoBananaServer" in names

    def test_multiple_skills_with_mcps(self):
        configs = [
            {
                "name": "image-toolkit",
                "mcpServers": {
                    "imageServer": {
                        "type": "streamable-http",
                        "url": "http://mcp.example.com/image",
                    },
                },
            },
            {
                "name": "knowledge-base",
                "mcpServers": {
                    "kbServer": {
                        "type": "streamable-http",
                        "url": "http://mcp.example.com/kb",
                    },
                },
            },
        ]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)

        assert len(result) == 2
        names = [s["name"] for s in result]
        assert "image-toolkit_imageServer" in names
        assert "knowledge-base_kbServer" in names

    def test_mixed_skills_with_and_without_mcp(self):
        configs = [
            {"name": "no-mcp-skill", "description": "No MCP"},
            {
                "name": "with-mcp",
                "mcpServers": {
                    "server1": {
                        "type": "streamable-http",
                        "url": "http://example.com",
                    },
                },
            },
        ]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)

        assert len(result) == 1
        assert result[0]["name"] == "with-mcp_server1"

    def test_invalid_mcp_servers_type_skipped(self):
        configs = [{"name": "bad-skill", "mcpServers": "not-a-dict"}]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)
        assert result == []

    def test_non_dict_server_config_skipped(self):
        configs = [
            {
                "name": "bad-skill",
                "mcpServers": {"server1": "not-a-dict"},
            }
        ]
        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)
        assert result == []

    def test_selected_kb_skill_keeps_unprefixed_server_name(self):
        configs = [
            {
                "name": "wegent-knowledge",
                "mcpServers": {
                    "wegent-knowledge": {
                        "type": "streamable-http",
                        "url": "http://mcp.example.com/kb",
                    }
                },
            }
        ]

        result = TaskRequestBuilder._extract_skill_mcp_to_list(configs)

        assert result == [
            {
                "name": "wegent-knowledge",
                "type": "streamable-http",
                "url": "http://mcp.example.com/kb",
            }
        ]


class TestNormalizeMcpTypesForClaudeCode:
    """Tests for _normalize_mcp_types_for_claude_code static method."""

    def test_empty_list(self):
        servers = []
        TaskRequestBuilder._normalize_mcp_types_for_claude_code(servers)
        assert servers == []

    def test_streamable_http_converted_to_http(self):
        servers = [
            {"name": "s1", "type": "streamable-http", "url": "http://example.com"}
        ]
        TaskRequestBuilder._normalize_mcp_types_for_claude_code(servers)
        assert servers[0]["type"] == "http"

    def test_http_type_unchanged(self):
        servers = [{"name": "s1", "type": "http", "url": "http://example.com"}]
        TaskRequestBuilder._normalize_mcp_types_for_claude_code(servers)
        assert servers[0]["type"] == "http"

    def test_mixed_types_normalized(self):
        servers = [
            {"name": "s1", "type": "streamable-http", "url": "http://a.com"},
            {"name": "s2", "type": "http", "url": "http://b.com"},
            {"name": "s3", "type": "sse", "url": "http://c.com"},
        ]
        TaskRequestBuilder._normalize_mcp_types_for_claude_code(servers)
        assert servers[0]["type"] == "http"
        assert servers[1]["type"] == "http"
        assert servers[2]["type"] == "sse"

    def test_non_dict_item_skipped(self):
        servers = [
            {"name": "s1", "type": "streamable-http", "url": "http://a.com"},
            "not-a-dict",
        ]
        TaskRequestBuilder._normalize_mcp_types_for_claude_code(servers)
        assert servers[0]["type"] == "http"
        assert servers[1] == "not-a-dict"


class TestCheckMcpServerReachable:
    """Tests for _check_mcp_server_reachable static method."""

    def test_no_url_returns_false(self):
        assert TaskRequestBuilder._check_mcp_server_reachable({}) is False

    def test_empty_url_returns_false(self):
        assert TaskRequestBuilder._check_mcp_server_reachable({"url": ""}) is False

    @patch("app.services.execution.request_builder.urllib.request.urlopen")
    def test_successful_response_returns_true(self, mock_urlopen):
        server = {"url": "http://mcp.example.com/server", "type": "http"}
        result = TaskRequestBuilder._check_mcp_server_reachable(server)
        assert result is True

    @patch(
        "app.services.execution.request_builder.urllib.request.urlopen",
        side_effect=Exception("Connection refused"),
    )
    def test_connection_error_returns_false(self, mock_urlopen):
        server = {"url": "http://192.0.2.1:9999/unreachable", "type": "http"}
        result = TaskRequestBuilder._check_mcp_server_reachable(server)
        assert result is False

    def test_skips_placeholder_headers(self):
        """Headers with ${{...}} placeholders should not be sent."""
        import urllib.request

        server = {
            "url": "http://mcp.example.com/server",
            "headers": {
                "mcp-proxy-wegent-user": "${{user.name}}",
                "X-Static": "fixed-value",
            },
        }
        with patch(
            "app.services.execution.request_builder.urllib.request.urlopen"
        ) as mock_urlopen:
            TaskRequestBuilder._check_mcp_server_reachable(server)
            # Verify the request was made
            assert mock_urlopen.called
            req = mock_urlopen.call_args[0][0]
            # Static header should be present, placeholder should not
            assert req.get_header("X-static") == "fixed-value"
            assert req.get_header("Mcp-proxy-wegent-user") is None


class TestFilterReachableMcpServers:
    """Tests for _filter_reachable_mcp_servers."""

    def test_empty_list_returns_empty(self):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        assert builder._filter_reachable_mcp_servers([]) == []

    @patch.object(
        TaskRequestBuilder,
        "_check_mcp_server_reachable",
        side_effect=lambda s: s.get("name") != "bad-server",
    )
    def test_filters_unreachable(self, mock_check):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        servers = [
            {"name": "good-server", "type": "http", "url": "http://good.example.com"},
            {"name": "bad-server", "type": "http", "url": "http://bad.example.com"},
        ]
        result = builder._filter_reachable_mcp_servers(servers)

        assert len(result) == 1
        assert result[0]["name"] == "good-server"


class TestPrepareMcpForClaudeCode:
    """Integration tests for _prepare_mcp_for_claude_code."""

    @patch.object(
        TaskRequestBuilder,
        "_check_mcp_server_reachable",
        return_value=True,
    )
    def test_skill_mcp_merged_and_normalized(self, mock_check):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        bot_config = {
            "shell_type": "ClaudeCode",
            "mcp_servers": [
                {
                    "name": "ghost-server",
                    "type": "streamable-http",
                    "url": "http://ghost.example.com/mcp",
                },
            ],
        }
        skill_configs = [
            {
                "name": "my-skill",
                "mcpServers": {
                    "skillServer": {
                        "type": "streamable-http",
                        "url": "http://skill.example.com/mcp",
                    },
                },
            }
        ]

        builder._prepare_mcp_for_claude_code(bot_config, skill_configs)

        mcp = bot_config["mcp_servers"]
        assert len(mcp) == 2
        names = [s["name"] for s in mcp]
        assert "ghost-server" in names
        assert "my-skill_skillServer" in names
        # All types should be normalized to http
        for s in mcp:
            assert s["type"] == "http"

    @patch.object(
        TaskRequestBuilder,
        "_check_mcp_server_reachable",
        return_value=True,
    )
    def test_skill_mcp_only_no_ghost(self, mock_check):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        bot_config = {"shell_type": "ClaudeCode", "mcp_servers": []}
        skill_configs = [
            {
                "name": "my-skill",
                "mcpServers": {
                    "server1": {
                        "type": "streamable-http",
                        "url": "http://example.com/mcp",
                    },
                },
            }
        ]

        builder._prepare_mcp_for_claude_code(bot_config, skill_configs)

        assert len(bot_config["mcp_servers"]) == 1
        assert bot_config["mcp_servers"][0]["name"] == "my-skill_server1"
        assert bot_config["mcp_servers"][0]["type"] == "http"

    @patch.object(
        TaskRequestBuilder,
        "_check_mcp_server_reachable",
        return_value=False,
    )
    def test_unreachable_servers_removed(self, mock_check):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        bot_config = {
            "shell_type": "ClaudeCode",
            "mcp_servers": [
                {
                    "name": "unreachable",
                    "type": "http",
                    "url": "http://192.0.2.1:9999/mcp",
                },
            ],
        }

        builder._prepare_mcp_for_claude_code(bot_config, [])

        assert bot_config["mcp_servers"] == []

    @patch.object(
        TaskRequestBuilder,
        "_check_mcp_server_reachable",
        return_value=True,
    )
    def test_no_skill_configs_preserves_ghost(self, mock_check):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        bot_config = {
            "shell_type": "ClaudeCode",
            "mcp_servers": [
                {
                    "name": "ghost-server",
                    "type": "http",
                    "url": "http://ghost.example.com/mcp",
                },
            ],
        }

        builder._prepare_mcp_for_claude_code(bot_config, [])

        assert len(bot_config["mcp_servers"]) == 1
        assert bot_config["mcp_servers"][0]["name"] == "ghost-server"


class TestResolveRequestPreloadSkills:
    """Tests for late skill resolution after context processing."""

    @patch.object(
        TaskRequestBuilder,
        "_check_mcp_server_reachable",
        return_value=True,
    )
    def test_selected_kb_skill_resolves_into_request_and_claude_mcp(self, mock_check):
        builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
        request = ExecutionRequest(
            task_id=1273,
            subtask_id=1709,
            knowledge_base_ids=[1408],
            is_user_selected_kb=True,
            skill_names=["browser"],
            skill_configs=[{"name": "browser"}],
            preload_skills=["wegent-knowledge"],
            user_selected_skills=["wegent-knowledge"],
            bot=[
                {
                    "shell_type": "ClaudeCode",
                    "skills": ["browser"],
                    "mcp_servers": [],
                }
            ],
        )
        bot = SimpleNamespace(name="chat-bot")
        team = SimpleNamespace(namespace="default")

        builder._get_bot_skills = lambda **kwargs: (
            [
                {"name": "browser"},
                {
                    "name": "wegent-knowledge",
                    "mcpServers": {
                        "wegent-knowledge": {
                            "type": "streamable-http",
                            "url": "${{backend_url}}/mcp/knowledge/sse",
                        }
                    },
                },
            ],
            ["wegent-knowledge"],
            ["wegent-knowledge"],
            {
                "wegent-knowledge": {
                    "skill_id": 99,
                    "namespace": "default",
                    "is_public": True,
                }
            },
        )

        result = builder.resolve_request_preload_skills(
            request=request,
            bot=bot,
            team=team,
            user_id=7,
        )

        assert result.skill_names == ["browser", "wegent-knowledge"]
        assert result.preload_skills == ["wegent-knowledge"]
        assert result.user_selected_skills == ["wegent-knowledge"]
        assert result.skill_refs["wegent-knowledge"]["is_public"] is True
        assert "wegent-knowledge" in result.bot[0]["skills"]
        assert result.bot[0]["mcp_servers"] == [
            {
                "name": "wegent-knowledge",
                "type": "http",
                "url": "${{backend_url}}/mcp/knowledge/sse",
            }
        ]
