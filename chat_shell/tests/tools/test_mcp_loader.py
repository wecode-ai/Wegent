# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP loader variable substitution functionality.

This module tests that the MCP loader correctly applies variable substitution
to CHAT_MCP_SERVERS configuration using task_data.
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from chat_shell.tools.mcp.loader import load_mcp_tools


class TestMcpLoaderVariableSubstitution:
    """Test cases for MCP loader variable substitution."""

    @pytest.mark.asyncio
    async def test_load_mcp_tools_applies_variable_substitution_to_backend_servers(self):
        """Test that load_mcp_tools applies variable substitution to CHAT_MCP_SERVERS.

        This is a regression test for the issue where placeholders like ${{user.name}}
        in CHAT_MCP_SERVERS were not being replaced.
        """
        # Mock CHAT_MCP_SERVERS with placeholders
        mcp_servers_config = {
            "test-server": {
                "type": "streamable-http",
                "url": "https://api.example.com/${{user.name}}/mcp",
                "headers": {"X-User": "${{user.name}}"},
            }
        }

        task_data = {
            "user": {
                "name": "zhangsan",
                "id": 123,
            }
        }

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [MagicMock(name="test_tool")]

        with (
            patch(
                "chat_shell.tools.mcp.loader.settings.CHAT_MCP_SERVERS",
                json.dumps({"mcpServers": mcp_servers_config}),
            ),
            patch(
                "chat_shell.tools.mcp.MCPClient", return_value=mock_client
            ) as mock_mcp_class,
        ):
            mock_client.connect = MagicMock()

            result = await load_mcp_tools(
                task_id=1, bot_name="", bot_namespace="default", task_data=task_data
            )

            # Verify MCPClient was created with substituted variables
            mock_mcp_class.assert_called_once()
            call_args = mock_mcp_class.call_args
            config_passed = call_args[0][0]

            # Verify placeholders were replaced
            assert config_passed["test-server"]["url"] == "https://api.example.com/zhangsan/mcp"
            assert config_passed["test-server"]["headers"]["X-User"] == "zhangsan"

    @pytest.mark.asyncio
    async def test_load_mcp_tools_no_substitution_when_no_task_data(self):
        """Test that placeholders are preserved when task_data is None."""
        mcp_servers_config = {
            "test-server": {
                "type": "streamable-http",
                "url": "https://api.example.com/${{user.name}}/mcp",
            }
        }

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [MagicMock(name="test_tool")]

        with (
            patch(
                "chat_shell.tools.mcp.loader.settings.CHAT_MCP_SERVERS",
                json.dumps({"mcpServers": mcp_servers_config}),
            ),
            patch(
                "chat_shell.tools.mcp.MCPClient", return_value=mock_client
            ) as mock_mcp_class,
        ):
            mock_client.connect = MagicMock()

            # Call without task_data
            result = await load_mcp_tools(
                task_id=1, bot_name="", bot_namespace="default", task_data=None
            )

            # Verify MCPClient was created with original config (placeholders preserved)
            mock_mcp_class.assert_called_once()
            call_args = mock_mcp_class.call_args
            config_passed = call_args[0][0]

            # Verify placeholders were NOT replaced
            assert config_passed["test-server"]["url"] == "https://api.example.com/${{user.name}}/mcp"

    @pytest.mark.asyncio
    async def test_load_mcp_tools_substitutes_nested_user_fields(self):
        """Test substitution of nested user fields like ${{user.git_login}}."""
        mcp_servers_config = {
            "github-server": {
                "type": "streamable-http",
                "url": "https://github.com/${{user.git_login}}/mcp",
                "headers": {
                    "Authorization": "Bearer ${{user.git_token}}",
                    "X-Email": "${{user.git_email}}",
                },
            }
        }

        task_data = {
            "user": {
                "name": "zhangsan",
                "git_login": "zhangsan_git",
                "git_token": "ghp_123456",
                "git_email": "zhangsan@example.com",
            }
        }

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [MagicMock(name="github_tool")]

        with (
            patch(
                "chat_shell.tools.mcp.loader.settings.CHAT_MCP_SERVERS",
                json.dumps({"mcpServers": mcp_servers_config}),
            ),
            patch(
                "chat_shell.tools.mcp.MCPClient", return_value=mock_client
            ) as mock_mcp_class,
        ):
            mock_client.connect = MagicMock()

            result = await load_mcp_tools(
                task_id=1, bot_name="", bot_namespace="default", task_data=task_data
            )

            call_args = mock_mcp_class.call_args
            config_passed = call_args[0][0]

            # Verify all nested user fields were replaced
            assert config_passed["github-server"]["url"] == "https://github.com/zhangsan_git/mcp"
            assert config_passed["github-server"]["headers"]["Authorization"] == "Bearer ghp_123456"
            assert config_passed["github-server"]["headers"]["X-Email"] == "zhangsan@example.com"

    @pytest.mark.asyncio
    async def test_load_mcp_tools_substitutes_multiple_variables(self):
        """Test substitution of multiple different variables in config."""
        mcp_servers_config = {
            "multi-server": {
                "type": "streamable-http",
                "url": "${{backend_url}}/user/${{user.name}}/repo/${{git_repo}}",
                "headers": {"Authorization": "Bearer ${{task_token}}"},
            }
        }

        task_data = {
            "backend_url": "http://localhost:8000",
            "user": {"name": "zhangsan"},
            "git_repo": "myrepo",
            "task_token": "token-abc-123",
        }

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [MagicMock(name="multi_tool")]

        with (
            patch(
                "chat_shell.tools.mcp.loader.settings.CHAT_MCP_SERVERS",
                json.dumps({"mcpServers": mcp_servers_config}),
            ),
            patch(
                "chat_shell.tools.mcp.MCPClient", return_value=mock_client
            ) as mock_mcp_class,
        ):
            mock_client.connect = MagicMock()

            result = await load_mcp_tools(
                task_id=1, bot_name="", bot_namespace="default", task_data=task_data
            )

            call_args = mock_mcp_class.call_args
            config_passed = call_args[0][0]

            # Verify all variables were replaced
            assert config_passed["multi-server"]["url"] == "http://localhost:8000/user/zhangsan/repo/myrepo"
            assert config_passed["multi-server"]["headers"]["Authorization"] == "Bearer token-abc-123"

    @pytest.mark.asyncio
    async def test_load_mcp_handles_empty_chat_mcp_servers(self):
        """Test that load_mcp_tools handles empty CHAT_MCP_SERVERS gracefully."""
        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = []

        with (
            patch(
                "chat_shell.tools.mcp.loader.settings.CHAT_MCP_SERVERS",
                "{}",
            ),
            patch(
                "chat_shell.tools.mcp.MCPClient", return_value=mock_client
            ) as mock_mcp_class,
        ):
            mock_client.connect = MagicMock()

            result = await load_mcp_tools(
                task_id=1, bot_name="", bot_namespace="default", task_data={"user": {"name": "test"}}
            )

            # Should return None when no MCP servers are configured
            assert result is None
            # MCPClient should NOT be called when there are no servers
            mock_mcp_class.assert_not_called()
