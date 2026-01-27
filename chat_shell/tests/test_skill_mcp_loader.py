# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill MCP servers loading functionality.

This module tests the ability to load MCP servers from skill configurations.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.skill_factory import (
    _load_skill_mcp_tools,
    prepare_skill_tools,
)


class TestLoadSkillMcpTools:
    """Test cases for _load_skill_mcp_tools function."""

    @pytest.mark.asyncio
    async def test_empty_mcp_configs_returns_empty(self):
        """Test that empty MCP configs returns empty lists."""
        tools, clients = await _load_skill_mcp_tools({}, task_id=1)
        assert tools == []
        assert clients == []

    @pytest.mark.asyncio
    async def test_mcp_client_created_with_config(self):
        """Test that MCPClient is created with skill MCP configs."""
        mcp_configs = {
            "test_skill_server1": {
                "type": "stdio",
                "command": "python",
                "args": ["-m", "test_server"],
            }
        }

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [MagicMock(name="test_tool")]

        with patch(
            "chat_shell.tools.mcp.MCPClient", return_value=mock_client
        ) as mock_mcp_class:
            mock_client.connect = AsyncMock()
            tools, clients = await _load_skill_mcp_tools(mcp_configs, task_id=1)

            mock_mcp_class.assert_called_once_with(mcp_configs, task_data=None)
            mock_client.connect.assert_called_once()
            assert len(tools) == 1
            assert len(clients) == 1
            assert clients[0] == mock_client

    @pytest.mark.asyncio
    async def test_mcp_connection_failure_returns_empty(self):
        """Test that connection failure returns empty lists gracefully."""
        mcp_configs = {
            "test_skill_server1": {
                "type": "stdio",
                "command": "nonexistent_command",
            }
        }

        mock_client = MagicMock()
        mock_client.is_connected = False
        mock_client.connect = AsyncMock()
        mock_client.disconnect = AsyncMock()

        with patch("chat_shell.tools.mcp.MCPClient", return_value=mock_client):
            tools, clients = await _load_skill_mcp_tools(mcp_configs, task_id=1)

            assert tools == []
            assert clients == []
            # Verify disconnect was called for cleanup
            mock_client.disconnect.assert_called_once()

    @pytest.mark.asyncio
    async def test_mcp_connection_timeout_returns_empty(self):
        """Test that connection timeout returns empty lists gracefully."""
        import asyncio

        mcp_configs = {
            "test_skill_server1": {
                "type": "stdio",
                "command": "python",
            }
        }

        mock_client = MagicMock()
        mock_client.connect = AsyncMock(side_effect=asyncio.TimeoutError())
        mock_client.disconnect = AsyncMock()

        with patch("chat_shell.tools.mcp.MCPClient", return_value=mock_client):
            tools, clients = await _load_skill_mcp_tools(mcp_configs, task_id=1)

            assert tools == []
            assert clients == []
            # Verify disconnect was called for cleanup
            mock_client.disconnect.assert_called_once()

    @pytest.mark.asyncio
    async def test_mcp_connection_exception_cleans_up(self):
        """Test that connection exception triggers proper cleanup."""
        mcp_configs = {
            "test_skill_server1": {
                "type": "stdio",
                "command": "python",
            }
        }

        mock_client = MagicMock()
        mock_client.connect = AsyncMock(side_effect=Exception("Connection error"))
        mock_client.disconnect = AsyncMock()

        with patch("chat_shell.tools.mcp.MCPClient", return_value=mock_client):
            tools, clients = await _load_skill_mcp_tools(mcp_configs, task_id=1)

            assert tools == []
            assert clients == []
            # Verify disconnect was called for cleanup
            mock_client.disconnect.assert_called_once()


class TestPrepareSkillToolsWithMcp:
    """Test cases for prepare_skill_tools with MCP servers."""

    @pytest.mark.asyncio
    async def test_skill_with_mcp_servers_config(self):
        """Test that skill with mcpServers config triggers MCP loading."""
        skill_configs = [
            {
                "name": "test_skill",
                "description": "A test skill",
                "mcpServers": {
                    "server1": {
                        "type": "stdio",
                        "command": "python",
                        "args": ["-m", "test_server"],
                    }
                },
            }
        ]

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [MagicMock(name="mcp_tool")]

        with patch(
            "chat_shell.tools.mcp.MCPClient", return_value=mock_client
        ) as mock_mcp_class:
            mock_client.connect = AsyncMock()
            tools, clients = await prepare_skill_tools(
                task_id=1,
                subtask_id=1,
                user_id=1,
                skill_configs=skill_configs,
            )

            # MCP client should be created with prefixed server name
            mock_mcp_class.assert_called_once()
            call_args = mock_mcp_class.call_args
            assert "test_skill_server1" in call_args[0][0]

            # Should return MCP tools and clients
            assert len(tools) == 1
            assert len(clients) == 1

    @pytest.mark.asyncio
    async def test_skill_without_mcp_servers(self):
        """Test that skill without mcpServers doesn't trigger MCP loading."""
        skill_configs = [
            {
                "name": "test_skill",
                "description": "A test skill without MCP",
                # No mcpServers field
            }
        ]

        with patch("chat_shell.tools.mcp.MCPClient") as mock_mcp_class:
            tools, clients = await prepare_skill_tools(
                task_id=1,
                subtask_id=1,
                user_id=1,
                skill_configs=skill_configs,
            )

            # MCP client should NOT be created
            mock_mcp_class.assert_not_called()

            # Should return empty lists
            assert tools == []
            assert clients == []

    @pytest.mark.asyncio
    async def test_multiple_skills_with_mcp_servers(self):
        """Test that multiple skills' MCP servers are merged."""
        skill_configs = [
            {
                "name": "skill_a",
                "description": "Skill A",
                "mcpServers": {
                    "server_a": {"type": "stdio", "command": "cmd_a"},
                },
            },
            {
                "name": "skill_b",
                "description": "Skill B",
                "mcpServers": {
                    "server_b": {"type": "stdio", "command": "cmd_b"},
                },
            },
        ]

        mock_client = MagicMock()
        mock_client.is_connected = True
        mock_client.get_tools.return_value = [
            MagicMock(name="tool_a"),
            MagicMock(name="tool_b"),
        ]

        with patch(
            "chat_shell.tools.mcp.MCPClient", return_value=mock_client
        ) as mock_mcp_class:
            mock_client.connect = AsyncMock()
            tools, clients = await prepare_skill_tools(
                task_id=1,
                subtask_id=1,
                user_id=1,
                skill_configs=skill_configs,
            )

            # MCP client should be created once with merged configs
            mock_mcp_class.assert_called_once()
            call_args = mock_mcp_class.call_args
            merged_config = call_args[0][0]

            # Should have both prefixed server names
            assert "skill_a_server_a" in merged_config
            assert "skill_b_server_b" in merged_config

            # Should return combined tools
            assert len(tools) == 2
            assert len(clients) == 1

    @pytest.mark.asyncio
    async def test_return_type_is_tuple(self):
        """Test that prepare_skill_tools returns tuple even with empty configs."""
        result = await prepare_skill_tools(
            task_id=1,
            subtask_id=1,
            user_id=1,
            skill_configs=[],
        )

        assert isinstance(result, tuple)
        assert len(result) == 2
        tools, clients = result
        assert isinstance(tools, list)
        assert isinstance(clients, list)
