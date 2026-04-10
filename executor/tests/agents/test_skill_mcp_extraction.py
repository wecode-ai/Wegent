# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Skill MCP server handling in Claude Code executor.

Note: Skill MCP extraction, type normalization, and reachability filtering
have been migrated to the backend (TaskRequestBuilder). These tests verify
the executor correctly passes through the pre-processed MCP servers from
bot_config into Claude Code SDK options.
"""

from executor.agents.claude_code.config_manager import (
    _extract_user_provider_mcps,
    extract_claude_options,
)
from shared.models.execution import ExecutionRequest


class TestExtractClaudeOptionsWithMcp:
    """Tests for MCP handling in extract_claude_options.

    The backend now pre-processes MCP servers (skill merge, type normalization,
    reachability filtering). The executor just needs to extract, substitute
    variables, and convert to dict format.
    """

    def test_mcp_servers_from_bot_config_passed_through(self):
        """Pre-processed MCP servers from bot_config appear in options."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[
                {
                    "mcp_servers": [
                        {
                            "name": "ghost-server",
                            "type": "http",
                            "url": "http://ghost.example.com/mcp",
                        },
                        {
                            "name": "my-skill_skillServer",
                            "type": "http",
                            "url": "http://skill.example.com/mcp",
                        },
                    ],
                }
            ],
        )
        options = extract_claude_options(task_data)

        assert "mcp_servers" in options
        mcp = options["mcp_servers"]
        # Should be converted to dict format
        assert isinstance(mcp, dict)
        assert "ghost-server" in mcp
        assert "my-skill_skillServer" in mcp
        # Types should already be normalized by backend
        assert mcp["ghost-server"]["type"] == "http"
        assert mcp["my-skill_skillServer"]["type"] == "http"

    def test_no_mcp_servers(self):
        """No mcp_servers key when bot has none configured."""
        task_data = ExecutionRequest(
            task_id=1,
            bot=[{"system_prompt": "You are helpful."}],
        )
        options = extract_claude_options(task_data)
        assert "mcp_servers" not in options

    def test_empty_bot_list(self):
        """Empty bot list should not crash."""
        task_data = ExecutionRequest(task_id=1, bot=[])
        options = extract_claude_options(task_data)
        assert "mcp_servers" not in options


class TestExtractUserProviderMcps:
    """Tests for _extract_user_provider_mcps."""

    def test_extracts_dingtalk_docs(self):
        """Extracts DingTalk docs MCP from user_mcps."""
        task_data = ExecutionRequest(
            task_id=1,
            task_data={
                "user_mcps": {
                    "dingtalk": {
                        "services": {
                            "docs": {
                                "enabled": True,
                                "credentials": {
                                    "url": "https://mcp.dingtalk.com/v1/docs?token=abc"
                                },
                            }
                        }
                    }
                }
            },
        )
        result = _extract_user_provider_mcps(task_data)
        assert "dingtalk_docs" in result
        assert result["dingtalk_docs"]["type"] == "streamable-http"
        assert (
            result["dingtalk_docs"]["url"]
            == "https://mcp.dingtalk.com/v1/docs?token=abc"
        )

    def test_extracts_multiple_services(self):
        """Extracts multiple enabled services from same provider."""
        task_data = ExecutionRequest(
            task_id=1,
            task_data={
                "user_mcps": {
                    "dingtalk": {
                        "services": {
                            "docs": {
                                "enabled": True,
                                "credentials": {"url": "https://mcp.dingtalk.com/docs"},
                            },
                            "table": {
                                "enabled": True,
                                "credentials": {
                                    "url": "https://mcp.dingtalk.com/table"
                                },
                            },
                        }
                    }
                }
            },
        )
        result = _extract_user_provider_mcps(task_data)
        assert len(result) == 2
        assert "dingtalk_docs" in result
        assert "dingtalk_table" in result

    def test_skips_disabled_service(self):
        """Disabled services are not included."""
        task_data = ExecutionRequest(
            task_id=1,
            task_data={
                "user_mcps": {
                    "dingtalk": {
                        "services": {
                            "docs": {
                                "enabled": False,
                                "credentials": {"url": "https://mcp.dingtalk.com/docs"},
                            }
                        }
                    }
                }
            },
        )
        result = _extract_user_provider_mcps(task_data)
        assert result == {}

    def test_skips_empty_url(self):
        """Services with empty URL are not included."""
        task_data = ExecutionRequest(
            task_id=1,
            task_data={
                "user_mcps": {
                    "dingtalk": {
                        "services": {
                            "docs": {
                                "enabled": True,
                                "credentials": {"url": ""},
                            }
                        }
                    }
                }
            },
        )
        result = _extract_user_provider_mcps(task_data)
        assert result == {}

    def test_returns_empty_when_no_task_data(self):
        """Returns empty dict when task_data is None."""
        task_data = ExecutionRequest(task_id=1)
        result = _extract_user_provider_mcps(task_data)
        assert result == {}

    def test_returns_empty_when_no_user_mcps(self):
        """Returns empty dict when user_mcps is not present."""
        task_data = ExecutionRequest(task_id=1, task_data={"other_key": "value"})
        result = _extract_user_provider_mcps(task_data)
        assert result == {}

    def test_strips_whitespace_from_url(self):
        """URL whitespace is stripped."""
        task_data = ExecutionRequest(
            task_id=1,
            task_data={
                "user_mcps": {
                    "dingtalk": {
                        "services": {
                            "docs": {
                                "enabled": True,
                                "credentials": {
                                    "url": "  https://mcp.dingtalk.com/docs  "
                                },
                            }
                        }
                    }
                }
            },
        )
        result = _extract_user_provider_mcps(task_data)
        assert result["dingtalk_docs"]["url"] == "https://mcp.dingtalk.com/docs"
