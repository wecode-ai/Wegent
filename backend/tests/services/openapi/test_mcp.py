# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for backend OpenAPI MCP loading."""

from unittest.mock import patch

import pytest

from app.services.openapi.mcp import load_server_mcp_tools


@pytest.mark.asyncio
async def test_load_server_mcp_tools_can_skip_env_servers_for_system_agent():
    with (
        patch(
            "app.core.config.settings.CHAT_MCP_SERVERS",
            '{"mcpServers":{"env-server":{"type":"streamable-http","url":"http://env.example.com/mcp"}}}',
        ),
        patch("chat_shell.tools.mcp.MCPClient") as mcp_class,
    ):
        client = await load_server_mcp_tools(
            task_id=1,
            include_env_mcp_servers=False,
        )

    assert client is None
    mcp_class.assert_not_called()
