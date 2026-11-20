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

import asyncio
import threading
from unittest.mock import patch

import pytest
from langchain_core.tools import StructuredTool

from chat_shell.tools.mcp.client import (
    MCPClient,
    build_connections,
    wrap_tool_with_protection,
)
from shared.models.execution import ExecutionRequest


class TestBuildConnectionsVariableSubstitution:
    """Tests that build_connections() resolves ${{path}} placeholders."""

    @pytest.mark.parametrize("backend_url", [None, "", " \t\n"])
    @pytest.mark.parametrize("path", ["backend_url", "backend_api_url"])
    @pytest.mark.parametrize("templated_transport", [False, True])
    def test_missing_backend_skips_only_dependent_servers(
        self, backend_url: str | None, path: str, templated_transport: bool
    ) -> None:
        config = {
            "connector": {
                "type": "sse",
                "url": f"${{{{{path}}}}}/mcp/connectors/sse",
                "headers": {"Authorization": "Bearer ${{task_token}}"},
            },
            "backend-command": {
                "type": "${{task_data.transport}}" if templated_transport else "stdio",
                "command": "tool",
                "args": [f"${{{{{path}}}}}"],
            },
            "web": {"type": "sse", "url": "https://example.test/mcp"},
        }
        request = ExecutionRequest(
            backend_url=backend_url,
            auth_token="synthetic",
            task_data={"transport": "stdio"},
        )
        for task_data in [request, None]:
            connections = build_connections(config, task_data)
            assert set(connections) == {"web"}
            assert connections["web"]["url"] == "https://example.test/mcp"
        assert config["connector"]["url"] == f"${{{{{path}}}}}/mcp/connectors/sse"

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

    @pytest.mark.parametrize("templated_transport", [False, True])
    def test_unused_transport_fields_do_not_require_backend_context(
        self, templated_transport: bool
    ) -> None:
        config = {
            "http": {
                "type": "${{task_data.http}}" if templated_transport else "http",
                "url": "https://example.test/mcp",
                "args": ["${{backend_api_url}}"],
                "timeout": "${{backend_url}}",
                "env": {"UNUSED": "${{backend_url}}"},
            },
            "stdio": {
                "type": "${{task_data.stdio}}" if templated_transport else "stdio",
                "command": "tool",
                "url": "${{backend_api_url}}/mcp",
                "headers": {"UNUSED": "${{backend_url}}"},
            },
        }
        request = ExecutionRequest(task_data={"http": "http", "stdio": "stdio"})
        connections = build_connections(config, request)
        assert set(connections) == {"http", "stdio"}
        assert connections["stdio"]["command"] == "tool"
        assert connections["http"]["url"] == "https://example.test/mcp"
        assert config["stdio"]["type"] == (
            "${{task_data.stdio}}" if templated_transport else "stdio"
        )

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


class TestMCPClientToolNamePrefix:
    """Tests that MCPClient uses the adapter's official server-name prefix."""

    @pytest.mark.asyncio
    async def test_tool_cancellation_isolated_from_user_cancellation(self) -> None:
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def call(fail: bool) -> str:
            """Separate service cancellation from cancellation of the caller."""
            if fail:
                raise asyncio.CancelledError()
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
            return "response"

        unavailable = wrap_tool_with_protection(
            StructuredTool.from_function(
                coroutine=call, name="cancelled", description="Cancelled service"
            )
        )
        assert "unavailable" in await unavailable.ainvoke({"fail": True})
        assert unavailable._wegent_mcp_unavailable.is_set()
        active = wrap_tool_with_protection(
            StructuredTool.from_function(
                coroutine=call, name="active", description="Active service"
            )
        )
        task = asyncio.create_task(active.ainvoke({"fail": False}))
        await asyncio.wait_for(started.wait(), timeout=2.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()
        assert not active._wegent_mcp_unavailable.is_set()

    @pytest.mark.asyncio
    async def test_startup_timeout_and_service_cancellation_preserve_healthy_tools(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        stopped = asyncio.Event()

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            async def get_tools(self, *, server_name):
                if server_name == "cancelled":
                    raise asyncio.CancelledError()
                if server_name == "blocked":
                    try:
                        await asyncio.Event().wait()
                    finally:
                        stopped.set()
                return [
                    StructuredTool.from_function(
                        func=lambda: "healthy",
                        name="healthy",
                        description="Healthy service",
                    )
                ]

        monkeypatch.setattr("chat_shell.tools.mcp.client.DEFAULT_STARTUP_TIMEOUT", 0.01)
        monkeypatch.setattr(
            "chat_shell.tools.mcp.client.MultiServerMCPClient", FakeClient
        )
        client = MCPClient(
            {
                name: {"url": "https://example.test/mcp"}
                for name in ["blocked", "cancelled", "healthy"]
            }
        )
        await asyncio.wait_for(client.connect(), timeout=2.0)
        assert stopped.is_set()
        assert await client.get_tools()[0].ainvoke({}) == "healthy"
        assert set(client.unavailable_servers) == {"blocked", "cancelled"}

    @pytest.mark.asyncio
    async def test_parent_cancellation_is_preserved(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        started = asyncio.Event()
        stopped = asyncio.Event()

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            async def get_tools(self, **_kwargs):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopped.set()

        monkeypatch.setattr(
            "chat_shell.tools.mcp.client.MultiServerMCPClient", FakeClient
        )
        client = MCPClient({"blocked": {"url": "https://example.test/mcp"}})
        task = asyncio.create_task(client.connect())
        await asyncio.wait_for(started.wait(), timeout=2.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()

    @pytest.mark.asyncio
    async def test_sync_timeout_returns_while_call_is_still_blocked(self) -> None:
        release = threading.Event()
        started = threading.Event()

        def blocked_call() -> str:
            """Simulate a synchronous server that never answers."""
            started.set()
            release.wait()
            return "late response"

        tool = wrap_tool_with_protection(
            StructuredTool.from_function(func=blocked_call, name="blocked"),
            timeout=0.01,
        )
        invocation = asyncio.create_task(asyncio.to_thread(tool.invoke, {}))
        try:
            result = await asyncio.wait_for(invocation, timeout=2.0)
            assert started.is_set()
            assert "timed out" in result
            assert not release.is_set()
        finally:
            release.set()

    @pytest.mark.asyncio
    async def test_connect_enables_official_tool_name_prefix(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """MCP tools should be named with the official server_tool format."""

        def list_files(fail: bool = False) -> str:
            """List files from the fake MCP server."""
            if fail:
                raise ConnectionError("private-credential-and-response-body")
            return "[]"

        class FakeMultiServerMCPClient:
            def __init__(
                self,
                connections,
                *,
                tool_name_prefix: bool = False,
                **_kwargs,
            ) -> None:
                self.connections = connections
                self.tool_name_prefix = tool_name_prefix
                if "startup-fails" in connections:
                    raise ValueError("private-credential-and-response-body")

            async def get_tools(self, *, server_name: str | None = None):
                if server_name == "denied":
                    raise PermissionError("private-credential-and-response-body")
                tool_name = (
                    f"{server_name}_list_files"
                    if self.tool_name_prefix
                    else "list_files"
                )
                return [
                    StructuredTool.from_function(
                        func=list_files,
                        name=tool_name,
                    )
                ]

        config = {
            "malformed": {"type": "stdio"},
            "startup-fails": {"url": "https://example.test/mcp"},
            "denied": {"url": "https://example.test/mcp"},
            "connector": {
                "type": "sse",
                "url": "${{backend_api_url}}/mcp/connectors/sse",
            },
            "filesystem": {
                "type": "streamable-http",
                "url": "http://mcp.example.com/stream",
            },
        }

        with patch(
            "chat_shell.tools.mcp.client.MultiServerMCPClient",
            FakeMultiServerMCPClient,
        ):
            client = MCPClient(config, task_data=ExecutionRequest())
            await client.connect()

        assert [tool.name for tool in client.get_tools()] == ["filesystem_list_files"]
        tool = client.get_tools()[0]
        assert await tool.ainvoke({"fail": False}) == "[]"
        assert "unavailable" in await tool.ainvoke({"fail": True})
        assert "unavailable" in tool.invoke({"fail": True})
        assert "unavailable" in await tool.ainvoke({"fail": False})
        assert "private-credential-and-response-body" not in caplog.text
