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
