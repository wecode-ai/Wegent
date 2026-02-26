# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for MCP client variable substitution via build_connections().

Verifies that ${{user.name}} and other placeholders in MCP server
configurations are properly replaced when task_data is provided.

Note: build_connections() returns TypedDict instances (SSEConnection,
StdioConnection, StreamableHttpConnection) which are plain dicts,
so we use dict-style access (conn["key"]) not attribute access.
"""

from chat_shell.tools.mcp.client import build_connections
from shared.models.execution import ExecutionRequest


class TestBuildConnectionsVariableSubstitution:
    """Tests that build_connections() resolves ${{path}} placeholders."""

    def test_sse_headers_placeholder_replaced(self) -> None:
        """${{user.name}} in SSE headers should be replaced by task_data value."""
        config = {
            "my-server": {
                "type": "sse",
                "url": "http://mcp.example.com/sse",
                "headers": {"X-User": "${{user.name}}"},
            }
        }
        task_data = ExecutionRequest(
            user={"id": 42, "name": "zhangsan"},
            task_id=100,
            team_id=10,
        )

        connections = build_connections(config, task_data)

        assert "my-server" in connections
        conn = connections["my-server"]
        assert conn["headers"] == {"X-User": "zhangsan"}

    def test_streamable_http_headers_placeholder_replaced(self) -> None:
        """${{user.name}} in streamable-http headers should be replaced."""
        config = {
            "web-server": {
                "type": "streamable-http",
                "url": "http://mcp.example.com/stream",
                "headers": {"Authorization": "Bearer ${{user.git_token}}"},
            }
        }
        task_data = ExecutionRequest(
            user={"git_token": "ghp_test_token_123"},
        )

        connections = build_connections(config, task_data)

        conn = connections["web-server"]
        assert conn["headers"] == {"Authorization": "Bearer ghp_test_token_123"}

    def test_url_placeholder_replaced(self) -> None:
        """${{git_domain}} in URL should be replaced."""
        config = {
            "server": {
                "type": "sse",
                "url": "https://${{git_domain}}/mcp/sse",
            }
        }
        task_data = ExecutionRequest(git_domain="gitlab.example.com")

        connections = build_connections(config, task_data)

        conn = connections["server"]
        assert conn["url"] == "https://gitlab.example.com/mcp/sse"

    def test_no_task_data_preserves_placeholders(self) -> None:
        """When task_data is None, placeholders should remain in the config."""
        config = {
            "server": {
                "type": "sse",
                "url": "http://example.com/sse",
                "headers": {"X-User": "${{user.name}}"},
            }
        }

        connections = build_connections(config, task_data=None)

        conn = connections["server"]
        # Placeholder should remain unresolved
        assert conn["headers"] == {"X-User": "${{user.name}}"}

    def test_stdio_env_placeholder_replaced(self) -> None:
        """${{user.git_token}} in stdio env should be replaced."""
        config = {
            "git-mcp": {
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@mcp/git"],
                "env": {"GIT_TOKEN": "${{user.git_token}}"},
            }
        }
        task_data = ExecutionRequest(
            user={"git_token": "glpat-xxx"},
        )

        connections = build_connections(config, task_data)

        conn = connections["git-mcp"]
        assert conn["env"] == {"GIT_TOKEN": "glpat-xxx"}

    def test_multiple_placeholders_in_same_config(self) -> None:
        """Multiple different placeholders should all be resolved."""
        config = {
            "server": {
                "type": "sse",
                "url": "https://${{git_domain}}/api/mcp",
                "headers": {
                    "X-User": "${{user.name}}",
                    "X-Task": "${{task_id}}",
                    "X-Team": "${{team_id}}",
                },
            }
        }
        task_data = ExecutionRequest(
            user={"name": "testuser"},
            git_domain="github.com",
            task_id=999,
            team_id=50,
        )

        connections = build_connections(config, task_data)

        conn = connections["server"]
        assert conn["url"] == "https://github.com/api/mcp"
        assert conn["headers"]["X-User"] == "testuser"
        assert conn["headers"]["X-Task"] == "999"
        assert conn["headers"]["X-Team"] == "50"
