# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for backend OpenAPI MCP loading."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from app.services.openapi import mcp as openapi_mcp
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


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["server", "bot", "custom"])
async def test_mcp_loaders_keep_healthy_tools_when_other_services_fail(
    source: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from langchain_core.tools import StructuredTool

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def get_tools(self, *, server_name):
            if server_name == "blocked":
                await asyncio.Event().wait()
            return [
                StructuredTool.from_function(
                    func=lambda: "healthy",
                    name="healthy",
                    description="Healthy service",
                )
            ]

    servers = {
        "invalid": None,
        "blocked": {"url": "https://example.test/blocked"},
        "connector": {"url": "${{backend_api_url}}/mcp/connectors/sse"},
        "healthy": {"url": "https://example.test/healthy"},
    }
    monkeypatch.setattr("chat_shell.tools.mcp.client.MultiServerMCPClient", FakeClient)
    monkeypatch.setattr("chat_shell.tools.mcp.client.DEFAULT_STARTUP_TIMEOUT", 0.01)
    monkeypatch.setattr(
        "app.core.config.settings.CHAT_MCP_SERVERS", json.dumps(servers)
    )
    monkeypatch.setattr(
        openapi_mcp, "_get_bot_mcp_servers", AsyncMock(return_value=servers)
    )
    if source == "server":
        loading = openapi_mcp.load_server_mcp_tools(task_id=1)
    elif source == "bot":
        loading = openapi_mcp.load_bot_mcp_tools(task_id=1, user_id=1, bot_name="test")
    else:
        loading = openapi_mcp.load_custom_mcp_tools(task_id=1, mcp_servers=servers)
    client = await asyncio.wait_for(loading, timeout=2.0)
    assert client is not None
    assert await client.get_tools()[0].ainvoke({}) == "healthy"
    assert set(client.get_tools_with_server()) == {"healthy"}
