# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Skill MCP server extraction in Claude Code executor.

Verifies that MCP servers declared in skill_configs are correctly
extracted, variable-substituted, prefix-namespaced, and merged into
the final Claude Code SDK options alongside Ghost-level MCP servers.
"""

from unittest.mock import patch

import pytest

from executor.agents.claude_code.config_manager import (
    _check_mcp_server_reachable,
    _extract_skill_mcp_servers,
    _filter_reachable_mcp_servers,
    _normalize_mcp_server_types,
    extract_claude_options,
)
from shared.models.execution import ExecutionRequest


def _mock_reachable(name, config):
    """Mock that treats all servers as reachable."""
    return True


class TestExtractSkillMcpServers:
    """Tests for _extract_skill_mcp_servers helper."""

    def test_no_skill_configs(self):
        """Returns empty dict when no skill_configs."""
        task_data = ExecutionRequest(task_id=1, skill_configs=[])
        result = _extract_skill_mcp_servers(task_data)
        assert result == {}

    def test_skill_without_mcp_servers(self):
        """Returns empty dict when skills have no mcpServers."""
        task_data = ExecutionRequest(
            task_id=1,
            skill_configs=[
                {"name": "code-review", "description": "Reviews code"},
            ],
        )
        result = _extract_skill_mcp_servers(task_data)
        assert result == {}

    def test_single_skill_single_mcp(self):
        """Extracts MCP from a single skill with one server."""
        task_data = ExecutionRequest(
            task_id=1,
            skill_configs=[
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
            ],
        )
        result = _extract_skill_mcp_servers(task_data)

        assert "image-toolkit_imageFetchServer" in result
        server = result["image-toolkit_imageFetchServer"]
        assert server["type"] == "streamable-http"
        assert server["url"] == "http://mcp.example.com/fetch-image"
        assert server["headers"]["Authorization"] == "Bearer token123"

    def test_single_skill_multiple_mcps(self):
        """Extracts multiple MCP servers from a single skill."""
        task_data = ExecutionRequest(
            task_id=1,
            skill_configs=[
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
            ],
        )
        result = _extract_skill_mcp_servers(task_data)

        assert len(result) == 2
        assert "image-toolkit_imageFetchServer" in result
        assert "image-toolkit_nanoBananaServer" in result

    def test_multiple_skills_with_mcps(self):
        """Extracts and merges MCP servers from multiple skills."""
        task_data = ExecutionRequest(
            task_id=1,
            skill_configs=[
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
            ],
        )
        result = _extract_skill_mcp_servers(task_data)

        assert len(result) == 2
        assert "image-toolkit_imageServer" in result
        assert "knowledge-base_kbServer" in result

    def test_variable_substitution(self):
        """Verifies ${{...}} placeholders are replaced with task_data values."""
        task_data = ExecutionRequest(
            task_id=1,
            user={"name": "testuser"},
            skill_configs=[
                {
                    "name": "my-skill",
                    "mcpServers": {
                        "server1": {
                            "type": "streamable-http",
                            "url": "http://mcp.example.com/api",
                            "headers": {
                                "mcp-proxy-wegent-user": "${{user.name}}",
                            },
                        },
                    },
                }
            ],
        )
        result = _extract_skill_mcp_servers(task_data)

        server = result["my-skill_server1"]
        assert server["headers"]["mcp-proxy-wegent-user"] == "testuser"

    def test_mixed_skills_with_and_without_mcp(self):
        """Skills without mcpServers are skipped cleanly."""
        task_data = ExecutionRequest(
            task_id=1,
            skill_configs=[
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
            ],
        )
        result = _extract_skill_mcp_servers(task_data)

        assert len(result) == 1
        assert "with-mcp_server1" in result

    def test_invalid_mcp_servers_type_skipped(self):
        """Non-dict mcpServers values are skipped."""
        task_data = ExecutionRequest(
            task_id=1,
            skill_configs=[
                {"name": "bad-skill", "mcpServers": "not-a-dict"},
            ],
        )
        result = _extract_skill_mcp_servers(task_data)
        assert result == {}


class TestNormalizeMcpServerTypes:
    """Tests for _normalize_mcp_server_types."""

    def test_empty_dict(self):
        assert _normalize_mcp_server_types({}) == {}

    def test_none_returns_none(self):
        assert _normalize_mcp_server_types(None) is None

    def test_streamable_http_converted_to_http(self):
        """streamable-http type is converted to http."""
        servers = {
            "server1": {
                "type": "streamable-http",
                "url": "http://example.com/mcp",
            }
        }
        result = _normalize_mcp_server_types(servers)
        assert result["server1"]["type"] == "http"

    def test_http_type_unchanged(self):
        """http type remains unchanged."""
        servers = {
            "server1": {
                "type": "http",
                "url": "http://example.com/mcp",
            }
        }
        result = _normalize_mcp_server_types(servers)
        assert result["server1"]["type"] == "http"

    def test_mixed_types_normalized(self):
        """Only streamable-http is converted, others remain unchanged."""
        servers = {
            "s1": {"type": "streamable-http", "url": "http://a.com"},
            "s2": {"type": "http", "url": "http://b.com"},
            "s3": {"type": "sse", "url": "http://c.com"},
        }
        result = _normalize_mcp_server_types(servers)
        assert result["s1"]["type"] == "http"
        assert result["s2"]["type"] == "http"
        assert result["s3"]["type"] == "sse"

    def test_non_dict_config_skipped(self):
        """Non-dict server configs are skipped without error."""
        servers = {
            "good": {"type": "streamable-http", "url": "http://example.com"},
            "bad": "not-a-dict",
        }
        result = _normalize_mcp_server_types(servers)
        assert result["good"]["type"] == "http"
        assert result["bad"] == "not-a-dict"


class TestFilterReachableMcpServers:
    """Tests for _filter_reachable_mcp_servers and _check_mcp_server_reachable."""

    def test_empty_dict_returns_empty(self):
        assert _filter_reachable_mcp_servers({}) == {}

    def test_none_returns_none(self):
        assert _filter_reachable_mcp_servers(None) is None

    def test_no_url_returns_false(self):
        assert _check_mcp_server_reachable("test", {}) is False

    @patch(
        "executor.agents.claude_code.config_manager._check_mcp_server_reachable",
        side_effect=lambda n, c: n != "bad-server",
    )
    def test_filters_unreachable(self, mock_check):
        """Unreachable servers are removed from the result."""
        servers = {
            "good-server": {"type": "http", "url": "http://good.example.com"},
            "bad-server": {"type": "http", "url": "http://bad.example.com"},
        }
        result = _filter_reachable_mcp_servers(servers)

        assert "good-server" in result
        assert "bad-server" not in result


class TestExtractClaudeOptionsWithSkillMcp:
    """Tests for skill MCP integration in extract_claude_options.

    All tests mock _check_mcp_server_reachable to bypass network checks.
    """

    @patch(
        "executor.agents.claude_code.config_manager._check_mcp_server_reachable",
        _mock_reachable,
    )
    def test_skill_mcp_merged_into_options(self):
        """Skill MCP servers appear in the final options with normalized type."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[{"system_prompt": "You are helpful."}],
            skill_configs=[
                {
                    "name": "image-toolkit",
                    "mcpServers": {
                        "imageServer": {
                            "type": "streamable-http",
                            "url": "http://mcp.example.com/image",
                        },
                    },
                }
            ],
        )
        options = extract_claude_options(task_data)

        assert "mcp_servers" in options
        assert "image-toolkit_imageServer" in options["mcp_servers"]
        # streamable-http should be normalized to http
        assert options["mcp_servers"]["image-toolkit_imageServer"]["type"] == "http"

    @patch(
        "executor.agents.claude_code.config_manager._check_mcp_server_reachable",
        _mock_reachable,
    )
    def test_skill_mcp_merged_with_ghost_mcp(self):
        """Skill MCP servers merge alongside Ghost-level MCP with type normalization."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[
                {
                    "mcp_servers": {
                        "ghost-server": {
                            "type": "http",
                            "url": "http://ghost.example.com/mcp",
                        },
                    },
                }
            ],
            skill_configs=[
                {
                    "name": "my-skill",
                    "mcpServers": {
                        "skillServer": {
                            "type": "streamable-http",
                            "url": "http://skill.example.com/mcp",
                        },
                    },
                }
            ],
        )
        options = extract_claude_options(task_data)

        mcp = options["mcp_servers"]
        assert "ghost-server" in mcp
        assert "my-skill_skillServer" in mcp
        # Ghost server type remains http, skill server streamable-http normalized to http
        assert mcp["ghost-server"]["type"] == "http"
        assert mcp["my-skill_skillServer"]["type"] == "http"

    @patch(
        "executor.agents.claude_code.config_manager._check_mcp_server_reachable",
        _mock_reachable,
    )
    def test_no_skill_configs_preserves_ghost_mcp(self):
        """When no skill_configs, Ghost MCP remains unchanged."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[
                {
                    "mcp_servers": {
                        "ghost-server": {
                            "type": "http",
                            "url": "http://ghost.example.com/mcp",
                        },
                    },
                }
            ],
            skill_configs=[],
        )
        options = extract_claude_options(task_data)

        mcp = options["mcp_servers"]
        assert "ghost-server" in mcp
        assert len(mcp) == 1

    @patch(
        "executor.agents.claude_code.config_manager._check_mcp_server_reachable",
        _mock_reachable,
    )
    def test_skill_mcp_only_no_ghost_mcp(self):
        """Skill MCP works when Ghost has no MCP servers configured."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[{"system_prompt": "You are helpful."}],
            skill_configs=[
                {
                    "name": "my-skill",
                    "mcpServers": {
                        "server1": {
                            "type": "streamable-http",
                            "url": "http://example.com/mcp",
                        },
                    },
                }
            ],
        )
        options = extract_claude_options(task_data)

        assert "mcp_servers" in options
        assert "my-skill_server1" in options["mcp_servers"]

    def test_unreachable_mcp_servers_removed_from_options(self):
        """MCP servers that fail reachability check are excluded from options."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[
                {
                    "mcp_servers": {
                        "unreachable-ghost": {
                            "type": "http",
                            "url": "http://192.0.2.1:9999/unreachable",
                        },
                    },
                }
            ],
            skill_configs=[],
        )

        with patch(
            "executor.agents.claude_code.config_manager._check_mcp_server_reachable",
            return_value=False,
        ):
            options = extract_claude_options(task_data)

        # Unreachable servers should have been filtered out
        assert "mcp_servers" not in options
